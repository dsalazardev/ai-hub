import fs from 'node:fs/promises';
import { lockFor } from '../writes/transaction.js';
import { requireTarget } from '../writes/targets.js';
import { withLock } from '../harness/lock.js';
import path from 'node:path';
import { isMap, parseDocument, stringify, type Document } from 'yaml';
import type { ProjectManifest } from './manifest.js';

/**
 * Único escritor de `manifest.yaml` (fabrica-verificable, design §D4). Toda escritura pasa por aquí: un temporal en la
 * misma carpeta y un `rename` sobre el destino, de modo que una interrupción deja el archivo anterior byte a byte.
 * Ningún otro módulo de `core/src` puede escribir, añadir ni renombrar sobre `manifest.yaml`; lo comprueba
 * `tests/manifest-write.test.ts`.
 */
const MANIFEST = 'manifest.yaml';
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 100;
/** Bloqueos pasajeros de Windows y de carpetas sincronizadas (antivirus, OneDrive). */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || attempt >= RENAME_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

/** El manifiesto cambió desde que se leyó: no se reemplaza (última comprobación de X2). */
export class ManifestChangedError extends Error {
  constructor(file: string) {
    super(`${file} cambió mientras se preparaba la escritura; no se reemplaza (vuelve a ejecutar el comando)`);
    this.name = 'ManifestChangedError';
  }
}

/**
 * Escribe el texto completo del manifiesto de forma atómica. Si algo falla, el archivo anterior queda intacto.
 * Con `expected` (el texto leído al preparar el cambio), un manifiesto modificado entretanto no se reemplaza.
 */
export async function writeManifestText(root: string, text: string, expected?: string | null): Promise<'written' | 'unchanged'> {
  const file = path.join(root, MANIFEST);
  // 3.11: el mecanismo propio (temporal en la misma carpeta y rename con reintentos) se conserva porque sus pruebas de
  // contrato (fabrica-verificable 3.1 y 3.5) inyectan fallos en él; cubre las garantías de X2 que aplican a un archivo
  // de estado: exclusión X1 entre escritores del motor, bytes iguales sin escritura, última comprobación contra el
  // texto leído, volcado a disco del temporal, rename y verificación posterior. Sin copia adyacente: la reversión la
  // cubren los snapshots. Riesgo residual común con X2: un escritor externo entre la última comprobación y el rename.
  const lock = await lockFor({ root, file }, requireTarget('manifest/write.ts', MANIFEST));
  return withLock(lock, 'escribir manifest.yaml', async () => {
    const current = await fs.readFile(file, 'utf8').catch(() => null);
    if (expected !== undefined && current !== expected) {
      throw new ManifestChangedError(file);
    }
    if (current === text) {
      return 'unchanged';
    }
    const temp = `${file}.ai-hub-${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, text, 'utf8');
      const handle = await fs.open(temp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (expected !== undefined && (await fs.readFile(file, 'utf8').catch(() => null)) !== expected) {
        throw new ManifestChangedError(file);
      }
      await renameWithRetry(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      if (error instanceof ManifestChangedError) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`no se pudo escribir ${file}${code ? ` (${code})` : ''}; el archivo anterior queda intacto`, { cause: error });
    }
    if ((await fs.readFile(file, 'utf8')) !== text) {
      throw new Error(`${file}: la verificación tras escribir no coincide; revisa el archivo`);
    }
    return 'written';
  }, { waitMs: 30_000 });
}

export async function writeManifest(root: string, manifest: ProjectManifest): Promise<void> {
  await writeManifestText(root, stringify(manifest));
}

export type ManifestProblem =
  /** No hay `manifest.yaml`. */
  | { state: 'absent' }
  /** No es un mapping, tiene claves duplicadas o no es YAML: se nombra el problema, nunca el contenido. */
  | { state: 'invalid'; problem: string };

/** Documento YAML del manifiesto (conserva comentarios y orden), o el motivo por el que no se puede actualizar. */
export async function readManifestDocument(root: string): Promise<{ doc: Document; text: string } | ManifestProblem> {
  const text = await fs.readFile(path.join(root, MANIFEST), 'utf8').catch(() => null);
  if (text === null) {
    return { state: 'absent' };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const code = doc.errors[0].code;
    return { state: 'invalid', problem: code === 'DUPLICATE_KEY' ? 'tiene claves duplicadas' : `no es YAML válido (${code})` };
  }
  if (!isMap(doc.contents)) {
    return { state: 'invalid', problem: 'no es un mapping YAML' };
  }
  return { doc, text };
}

export type BlockUpdate = { state: 'written' } | { state: 'unchanged' } | ManifestProblem;

/**
 * Declara o sustituye un bloque de primer nivel conservando el resto del archivo (claves, orden y comentarios).
 * `next` puede ser el valor o una función del valor anterior. Si el bloque ya es igual, no escribe. Falla cerrado, sin
 * escribir, cuando el manifiesto no es un mapping utilizable.
 */
export async function updateManifestBlock(root: string, key: string, next: unknown | ((previous: unknown) => unknown)): Promise<BlockUpdate> {
  const loaded = await readManifestDocument(root);
  if ('state' in loaded) {
    return loaded;
  }
  const previous: unknown = loaded.doc.has(key) ? (loaded.doc.toJS() as Record<string, unknown>)[key] : undefined;
  const value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(previous) : next;
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(value)) {
    return { state: 'unchanged' };
  }
  loaded.doc.set(key, value);
  await writeManifestText(root, loaded.doc.toString(), loaded.text);
  return { state: 'written' };
}
