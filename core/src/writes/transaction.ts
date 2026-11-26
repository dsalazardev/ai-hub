import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireLock, canonicalTargetKey, projectLockPath, sharedLockPath, type LockHandle, type LockOptions } from '../harness/lock.js';
import { detectSyncedFolder, privateCopyName, resolvePrivateStorage, type PrivateStorageHost } from './private-storage.js';
import { effectiveSensitivity, requireTarget, type TargetDeclaration } from './targets.js';

/**
 * Transacción de escritura X2 (R-035, R-036, R-037, R-105):
 * lock → leer bytes y huella → transformar → comparar → copia según sensibilidad → temporal en el
 * mismo directorio → flush → captura (si procede) → última comprobación → rename → comparar captura
 * → verificar → podar retención → soltar lock.
 *
 * Garantías (D-58): el lock excluye solo a escritores del motor que lo toman. Frente a escritores
 * externos hay detección previa (hasta la última comprobación) y, con captura, detección posterior.
 * Comprobar y después reemplazar NO es una actualización condicional atómica: entre la última
 * comprobación y el rename queda una ventana; una pérdida detectada después no se ha evitado.
 */

export const DEFAULT_ATTEMPTS = 3;
export const CAPTURE_QUOTA = 3;
const TEMP_MARK = '.ai-hub-tmp-';
const CAPTURE_MARK = '.ai-hub-capture-';
const BACKUP_SUFFIX = '.pre-ai-hub';
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export type WriteReason =
  | 'write_contention'
  | 'private_storage_unconfigured'
  | 'private_storage_invalid'
  | 'capture_quota_full'
  | 'verify_failed';

export interface TransactionHooks {
  /** Tras leer y antes de transformar (edición externa durante la transformación). */
  afterRead?: (attempt: number) => Promise<void> | void;
  /** Tras escribir y sincronizar el temporal (interrupción antes del reemplazo). */
  afterTempWritten?: (attempt: number) => Promise<void> | void;
  /** Justo antes de la última comprobación (contención). */
  beforeLastCheck?: (attempt: number) => Promise<void> | void;
  /** Tras la última comprobación y antes del rename: la ventana residual. */
  afterLastCheck?: (attempt: number) => Promise<void> | void;
  /** Sustituye a `fs.rename` (fallos inyectados). */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface WriteRequest {
  root: string;
  /** Ruta absoluta del destino. */
  file: string;
  /** Módulo escritor (para el registro de destinos). */
  module: string;
  /** Declaración explícita; si falta, se busca por ruta relativa a `root`. */
  target?: TargetDeclaration;
  /** Nuevo contenido a partir del actual (`null` = no existe). Devolver el mismo texto = sin cambio. */
  transform: (current: string | null) => string | Promise<string>;
  maxAttempts?: number;
  lock?: LockOptions;
  /**
   * Lock que quien llama ya tiene y que cubre este destino (p. ej. `generatedTargetsLock` durante un `sync`): la
   * transacción no toma uno por archivo ni lo suelta. Todo lo demás de X2 (temporal sincronizado, última
   * comprobación, rename y verificación) se mantiene.
   */
  heldLock?: LockHandle;
  hooks?: TransactionHooks;
  /** Retención de copias; por defecto, la del destino. */
  retention?: number;
  privateHost?: PrivateStorageHost;
  env?: NodeJS.ProcessEnv;
  /** Desactiva la captura aunque el destino la admita (p. ej. el plan la sustituye). */
  capture?: boolean;
}

export interface CaptureResult {
  status: 'none' | 'no_inplace_change' | 'external_write_detected' | 'external_guard_reduced';
  file?: string;
}

export type WriteResult =
  | { status: 'unchanged'; attempts: number; leftoverTemps: string[] }
  | { status: 'written'; attempts: number; backup: string | null; capture: CaptureResult; pruned: string[]; leftoverTemps: string[] }
  | { status: 'stopped'; reason: WriteReason; detail: string; attempts: number; leftoverTemps: string[] };

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    // Algunos errores de lectura (p. ej. EISDIR) llegan sin ruta: se añade para que quien informa nombre el archivo.
    if (error.path === undefined) {
      error.path = file;
    }
    throw error;
  });
}

function fingerprint(text: string | null): string {
  return text === null ? 'absent' : sha256(text);
}

/** ¿Es el nombre de un temporal de la transacción X2? */
export function isTransactionTemp(name: string): boolean {
  return name.startsWith('.') && name.includes(TEMP_MARK);
}

/** Temporales sobrantes de escrituras interrumpidas sobre `file` (se informan, nunca se usan). */
export async function findLeftoverTemps(file: string): Promise<string[]> {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}${TEMP_MARK}`;
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith(prefix)).map((name) => path.join(dir, name));
}

export async function listCaptures(file: string): Promise<string[]> {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${CAPTURE_MARK}`;
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith(prefix)).sort().map((name) => path.join(dir, name));
}

/** Liberación explícita de una captura: la persona la revisó. */
export async function releaseCapture(capture: string): Promise<void> {
  if (!path.basename(capture).includes(CAPTURE_MARK)) {
    throw new Error(`no es una captura del motor: ${capture}`);
  }
  await fs.rm(capture, { force: true });
}

export async function lockFor(request: Pick<WriteRequest, 'root' | 'file' | 'env'>, target: TargetDeclaration): Promise<string> {
  const relative = path.relative(request.root, request.file);
  // Un proyecto sin arnés todavía (sin `.ai-hub/`) usa el lock compartido de usuario: el lock nunca crea
  // `.ai-hub/` como efecto lateral (p. ej. un init que falla antes de instalar).
  const installed = await fs.access(path.join(request.root, '.ai-hub')).then(() => true, () => false);
  // Un destino externo (perfil de Hermes, almacenamiento privado) usa siempre el lock compartido de usuario:
  // nunca crea `.ai-hub/` dentro de un directorio ajeno, aunque `root` lo contenga.
  const external = target.pattern.startsWith('external:');
  if (installed && !external && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return projectLockPath(request.root, `w-${sha256(relative.split(path.sep).join('/')).slice(0, 24)}`);
  }
  return sharedLockPath(await canonicalTargetKey(request.file), request.env ?? process.env);
}

/**
 * Lock de los destinos generados de un proyecto: un `sync` lo toma una vez para todos sus destinos en lugar de uno
 * por archivo. Solo `sync/sync.ts` escribe esos destinos (gate de escritores), así que excluye a otro `sync` del
 * mismo proyecto. Sin `.ai-hub/` todavía, usa el lock compartido de usuario del proyecto (nunca crea `.ai-hub/`).
 */
export async function generatedTargetsLock(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const installed = await fs.access(path.join(root, '.ai-hub')).then(() => true, () => false);
  return installed ? projectLockPath(root, 'sync-targets') : sharedLockPath(`${await canonicalTargetKey(root)}#sync-targets`, env);
}

async function backupIndexes(dir: string, base: string): Promise<{ name: string; index: number }[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const out: { name: string; index: number }[] = [];
  for (const name of entries) {
    if (name === `${base}${BACKUP_SUFFIX}`) {
      out.push({ name, index: 0 });
      continue;
    }
    const match = name.startsWith(`${base}${BACKUP_SUFFIX}.`) ? /^(\d+)$/.exec(name.slice(base.length + BACKUP_SUFFIX.length + 1)) : null;
    if (match) {
      out.push({ name, index: Number.parseInt(match[1], 10) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Copia byte a byte creada en exclusiva con el siguiente índice libre (nunca reutiliza uno menor). */
async function writeBackup(dir: string, base: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const existing = await backupIndexes(dir, base);
    const next = existing.length === 0 ? 0 : existing[existing.length - 1].index + 1;
    const name = next === 0 ? `${base}${BACKUP_SUFFIX}` : `${base}${BACKUP_SUFFIX}.${next}`;
    try {
      await fs.writeFile(path.join(dir, name), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return path.join(dir, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new Error(`no se pudo crear una copia exclusiva de ${base}`);
}

async function pruneBackups(dir: string, base: string, keep: number): Promise<string[]> {
  const existing = await backupIndexes(dir, base);
  const excess = existing.length - keep;
  const removed: string[] = [];
  for (const item of existing.slice(0, Math.max(excess, 0))) {
    await fs.rm(path.join(dir, item.name), { force: true });
    removed.push(path.join(dir, item.name));
  }
  return removed;
}

async function writeTemp(file: string, content: string): Promise<string> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}${TEMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

function stopped(reason: WriteReason, detail: string, attempts: number, leftoverTemps: string[]): WriteResult {
  return { status: 'stopped', reason, detail, attempts, leftoverTemps };
}

export async function transactWrite(request: WriteRequest): Promise<WriteResult> {
  const target = request.target ?? requireTarget(request.module, path.relative(request.root, request.file));
  const maxAttempts = request.maxAttempts ?? DEFAULT_ATTEMPTS;
  const retention = Math.max(0, request.retention ?? target.retention);
  const rename = request.hooks?.rename ?? ((from: string, to: string) => fs.rename(from, to));
  const leftoverTemps = await findLeftoverTemps(request.file);
  const handle = request.heldLock ?? (await acquireLock(await lockFor(request, target), `escribir ${path.basename(request.file)}`, { waitMs: 30000, ...request.lock }));
  let crashed = false;
  try {
    let attempts = 0;
    while (attempts < maxAttempts) {
      attempts += 1;
      const current = await readText(request.file);
      const seen = fingerprint(current);
      await request.hooks?.afterRead?.(attempts);
      const next = await request.transform(current);
      if (current !== null && next === current) {
        return { status: 'unchanged', attempts, leftoverTemps };
      }
      const sensitivity = effectiveSensitivity(target, current);
      // Custodia de la copia previa (R-032): sensible → solo almacenamiento privado validado.
      let backupDir: string | null = null;
      let backupBase = path.basename(request.file);
      if (current !== null && retention > 0) {
        if (sensitivity === 'sensitive') {
          const storage = await resolvePrivateStorage(request.root, request.privateHost);
          if (!storage.ok) {
            return stopped(storage.reason, storage.detail, attempts, leftoverTemps);
          }
          backupDir = storage.dir;
          backupBase = privateCopyName(await canonicalTargetKey(request.file), path.basename(request.file));
        } else {
          backupDir = path.dirname(request.file);
        }
      }
      // Captura (R-105): solo no sensibles fuera de carpetas sincronizadas; plaza reservada antes.
      const wantsCapture = request.capture !== false && current !== null && sensitivity !== 'sensitive' && detectSyncedFolder(request.file, request.env ?? process.env) === null;
      if (wantsCapture && (await listCaptures(request.file)).length >= CAPTURE_QUOTA) {
        return stopped('capture_quota_full', `hay ${CAPTURE_QUOTA} capturas sin liberar de ${request.file}; revísalas y libéralas`, attempts, leftoverTemps);
      }
      await fs.mkdir(path.dirname(request.file), { recursive: true });
      const temp = await writeTemp(request.file, next);
      let capture: CaptureResult = { status: current === null ? 'none' : 'external_guard_reduced' };
      let captureFile: string | null = null;
      try {
        await request.hooks?.afterTempWritten?.(attempts);
        if (wantsCapture) {
          captureFile = `${request.file}${CAPTURE_MARK}${Date.now()}-${randomBytes(3).toString('hex')}`;
          try {
            await fs.link(request.file, captureFile);
          } catch {
            captureFile = null;
          }
        }
        await request.hooks?.beforeLastCheck?.(attempts);
        if (fingerprint(await readText(request.file)) !== seen) {
          await fs.rm(temp, { force: true });
          if (captureFile) {
            await fs.rm(captureFile, { force: true });
          }
          continue;
        }
        const backup = backupDir !== null && current !== null ? await writeBackup(backupDir, backupBase, current) : null;
        await request.hooks?.afterLastCheck?.(attempts);
        let renamed = false;
        let contention = false;
        while (!renamed) {
          try {
            await rename(temp, request.file);
            renamed = true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (!TRANSIENT.has(code) || attempts >= maxAttempts) {
              throw error;
            }
            attempts += 1;
            // Cada reintento repite la última comprobación y cuenta en el límite (D-58).
            if (fingerprint(await readText(request.file)) !== seen) {
              contention = true;
              break;
            }
          }
        }
        if (contention) {
          await fs.rm(temp, { force: true });
          if (captureFile) {
            await fs.rm(captureFile, { force: true });
          }
          continue;
        }
        if (captureFile) {
          if (fingerprint(await readText(captureFile)) === seen) {
            await fs.rm(captureFile, { force: true });
            capture = { status: 'no_inplace_change' };
          } else {
            capture = { status: 'external_write_detected', file: captureFile };
          }
        }
        if ((await readText(request.file)) !== next) {
          return stopped('verify_failed', `el contenido de ${request.file} no coincide tras reemplazar`, attempts, leftoverTemps);
        }
        // Retención solo tras una escritura verificada y nunca con una pérdida detectada (R-037).
        const pruned = backupDir !== null && capture.status !== 'external_write_detected' ? await pruneBackups(backupDir, backupBase, retention) : [];
        return { status: 'written', attempts, backup, capture, pruned, leftoverTemps };
      } catch (error) {
        if (isSimulatedCrash(error)) {
          crashed = true;
        } else {
          await fs.rm(temp, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    }
    return stopped('write_contention', `${request.file} cambió en cada uno de ${maxAttempts} intentos; no se reemplazó`, attempts, leftoverTemps);
  } finally {
    // Un lock ajeno a la transacción lo suelta quien lo tomó.
    if (!crashed && request.heldLock === undefined) {
      await handle.release();
    }
  }
}

/**
 * Costura de prueba: un error con `simulateCrash` reproduce la muerte del proceso (no limpia el
 * temporal ni suelta el lock), como haría un `kill` real entre dos pasos.
 */
export class SimulatedCrash extends Error {
  readonly simulateCrash = true;
}

function isSimulatedCrash(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { simulateCrash?: boolean }).simulateCrash === true;
}
