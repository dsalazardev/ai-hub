import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readTemplate } from '../harness/local.js';

/**
 * Identidad gestionada del perfil `hermes-control` (HC-04, HC-05, HC-09…HC-11): un bloque versionado con el hash
 * del cuerpo, regla de tres vías y copia protegida. Todo lo que queda fuera del bloque pertenece a la persona y se
 * conserva byte a byte.
 */
export const SOUL_VERSION = 1;
export const SOUL_BEGIN = '<!-- ai-hub:soul:begin';
export const SOUL_END = '<!-- ai-hub:soul:end -->';
/** SHA-256 del cuerpo de cada plantilla publicada (el actual primero). */
export const SOUL_HISTORY: readonly string[] = ['d5169d2409f9b0a7fa8103b29304f6eb113e941c35381e00851c7e6a78771a74'];

export type SoulState = 'present' | 'created' | 'updated' | 'pending';
export type SoulStage = 'identity-before-backup' | 'identity-backup' | 'identity-block';

export interface SoulOptions {
  /** Procedencia demostrable: `profile create` corrió en esta ejecución y el perfil no existía. */
  createdThisRun?: boolean;
  /** Solo el paso interactivo de control la aporta; `enroll` nunca pregunta. */
  adopt?: () => Promise<boolean>;
  /** Historial inyectable en pruebas; por defecto, el publicado. */
  history?: readonly string[];
  /** La conexión ya está guardada (`.env` + `manifest.control`): decide la segunda mitad de la acción. */
  saved?: boolean;
  onStage?: (stage: SoulStage) => void | Promise<void>;
}

export interface SoulOutcome {
  state: SoulState;
  file: string;
  backup: string | null;
  reason: 'edited' | 'unmarked' | null;
  action: string | null;
}

interface Parsed {
  start: number;
  end: number;
  version: number;
  markerHash: string;
  body: string;
  bodyHash: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function read(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
}

function parse(text: string): Parsed | null {
  const begin = /<!-- ai-hub:soul:begin v=(\d+) sha256=([a-f0-9]{64}) -->/.exec(text);
  if (begin === null) {
    return null;
  }
  const end = text.indexOf(SOUL_END, begin.index + begin[0].length);
  if (end < 0) {
    return null;
  }
  let bodyStart = begin.index + begin[0].length;
  if (text.startsWith('\r\n', bodyStart)) {
    bodyStart += 2;
  } else if (text.startsWith('\n', bodyStart)) {
    bodyStart += 1;
  }
  const body = text.slice(bodyStart, end);
  return {
    start: begin.index,
    end: end + SOUL_END.length,
    version: Number(begin[1]),
    markerHash: begin[2],
    body,
    bodyHash: sha256(body),
  };
}

function bodyOf(template: string): string {
  return template.endsWith('\n') ? template : `${template}\n`;
}

function render(template: string): string {
  const body = bodyOf(template);
  return `${SOUL_BEGIN} v=${SOUL_VERSION} sha256=${sha256(body)} -->\n${body}${SOUL_END}`;
}

/** Primera copia libre; una copia idéntica se reutiliza y jamás se sobrescribe otra. */
async function protectedBackup(dir: string, content: string): Promise<string> {
  const base = path.join(dir, 'SOUL.md.pre-ai-hub');
  for (const name of [path.basename(base), ...Array.from({ length: 100 }, (_, index) => `${path.basename(base)}.${index + 1}`)]) {
    const candidate = path.join(dir, name);
    const existing = await read(candidate);
    if (existing === content) {
      return candidate;
    }
    if (existing === null) {
      try {
        await fs.writeFile(candidate, content, { encoding: 'utf8', flag: 'wx' });
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }
  throw new Error(`no hay un nombre libre para la copia protegida de SOUL.md en ${dir}`);
}

/** Una copia idéntica sin marcadores prueba que una adopción ya se decidió (D′). */
async function identicalBackup(dir: string, content: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of entries.filter((entry) => /^SOUL\.md\.pre-ai-hub(?:\.\d+)?$/.test(entry))) {
    if ((await read(path.join(dir, name))) === content) {
      return true;
    }
  }
  return false;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.ai-hub-${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function setAsideSoulAction(file: string, saved: boolean, retakeAction: string): string {
  return `aparta \`${file}\` (renómbralo); después ${saved ? 'ai-hub control enroll --yes' : retakeAction}`;
}

/**
 * ¿La recuperación debe empezar apartando el archivo? Solo cuando no hay bloque utilizable ni una copia idéntica
 * que pruebe una adopción ya decidida.
 */
export async function soulNeedsSetAside(profileDir: string): Promise<boolean> {
  const file = path.join(profileDir, 'SOUL.md');
  const original = await read(file);
  if (original === null) {
    return false;
  }
  const parsed = parse(original);
  if (parsed === null) {
    return !(await identicalBackup(profileDir, original));
  }
  return parsed.bodyHash !== parsed.markerHash || !SOUL_HISTORY.includes(parsed.markerHash);
}

/** Vista de solo lectura para el plan: `present` únicamente cuando el bloque ya es el actual e íntegro. */
export async function inspectSoulIdentity(profileDir: string): Promise<SoulState> {
  const file = path.join(profileDir, 'SOUL.md');
  const original = await read(file);
  if (original === null) {
    return 'pending';
  }
  const parsed = parse(original);
  if (parsed === null || parsed.bodyHash !== parsed.markerHash || !SOUL_HISTORY.includes(parsed.markerHash)) {
    return 'pending';
  }
  const template = await readTemplate('hermes/SOUL.md');
  return parsed.version === SOUL_VERSION && parsed.markerHash === sha256(bodyOf(template)) && parsed.body === bodyOf(template)
    ? 'present'
    : 'pending';
}

export async function ensureSoulIdentity(
  profileDir: string,
  options: SoulOptions,
  retakeAction = 'ai-hub init --yes --connect-hermes --discord-channel <id> --approver <id> --discord-token-stdin',
): Promise<SoulOutcome> {
  const file = path.join(profileDir, 'SOUL.md');
  const template = await readTemplate('hermes/SOUL.md');
  const current = render(template);
  const currentHash = sha256(bodyOf(template));
  const history = options.history ?? SOUL_HISTORY;
  const original = await read(file);
  if (original === null) {
    await options.onStage?.('identity-backup');
    await writeAtomic(file, `${current}\n`);
    await options.onStage?.('identity-block');
    return { state: 'created', file, backup: null, reason: null, action: null };
  }
  const parsed = parse(original);
  if (parsed !== null) {
    if (parsed.bodyHash !== parsed.markerHash || !history.includes(parsed.markerHash)) {
      return {
        state: 'pending',
        file,
        backup: null,
        reason: 'edited',
        action: setAsideSoulAction(file, options.saved === true, retakeAction),
      };
    }
    if (parsed.version === SOUL_VERSION && parsed.markerHash === currentHash && parsed.body === bodyOf(template)) {
      await options.onStage?.('identity-block');
      return { state: 'present', file, backup: null, reason: null, action: null };
    }
    await options.onStage?.('identity-backup');
    await writeAtomic(file, `${original.slice(0, parsed.start)}${current}${original.slice(parsed.end)}`);
    await options.onStage?.('identity-block');
    return { state: 'updated', file, backup: null, reason: null, action: null };
  }
  const allowed = options.createdThisRun === true
    || (await identicalBackup(profileDir, original))
    || (options.adopt !== undefined && (await options.adopt()));
  if (!allowed) {
    return {
      state: 'pending',
      file,
      backup: null,
      reason: 'unmarked',
      action: setAsideSoulAction(file, options.saved === true, retakeAction),
    };
  }
  await options.onStage?.('identity-before-backup');
  const backup = await protectedBackup(profileDir, original);
  await options.onStage?.('identity-backup');
  await writeAtomic(file, `${current}\n`);
  await options.onStage?.('identity-block');
  return { state: 'created', file, backup, reason: null, action: null };
}
