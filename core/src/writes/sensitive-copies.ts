import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalTargetKey } from '../harness/lock.js';
import { privateCopyName, resolvePrivateStorage, type PrivateStorageHost } from './private-storage.js';
import { findTarget } from './targets.js';

/**
 * Copias sensibles adyacentes de versiones previas (R-040): `doctor` las informa solo por presencia (nunca su
 * contenido) y un comando explícito las mueve al almacenamiento privado validado. Nunca se borran solas.
 */

const COPY = /\.pre-ai-hub(\.\d+)?$/;
/** Archivos sensibles de un perfil de Hermes (fuera del repositorio). */
const PROFILE_SENSITIVE = new Set(['config.yaml', '.env']);

async function list(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [] as string[])).map((name) => path.join(dir, name));
}

/** Copias `*.pre-ai-hub[.n]` cuyo original es sensible: en el repositorio y en los perfiles de Hermes. */
export async function findSensitiveCopies(root: string, hermesHome: string | null): Promise<string[]> {
  const found: string[] = [];
  const candidates = [...(await list(root)), ...(await list(path.join(root, '.ai-hub'))), ...(await list(path.join(root, '.claude')))];
  for (const file of candidates) {
    const base = file.replace(COPY, '');
    if (base === file) {
      continue;
    }
    const rel = path.relative(root, base).split(path.sep).join('/');
    if (findTarget(rel)?.sensitivity === 'sensitive') {
      found.push(file);
    }
  }
  if (hermesHome !== null) {
    const profiles = (await list(path.join(hermesHome, 'profiles'))).concat([hermesHome]);
    for (const dir of profiles) {
      for (const file of await list(dir)) {
        const base = path.basename(file).replace(COPY, '');
        if (base !== path.basename(file) && PROFILE_SENSITIVE.has(base)) {
          found.push(file);
        }
      }
    }
  }
  return [...new Set(found)].sort();
}

export const MOVE_COMMAND = 'ai-hub backups move-sensitive --yes';

export async function checkSensitiveCopies(root: string, hermesHome: string | null): Promise<{ id: 'sensitive-copies'; ok: boolean; detail: string }> {
  const copies = await findSensitiveCopies(root, hermesHome);
  if (copies.length === 0) {
    return { id: 'sensitive-copies', ok: true, detail: 'sin copias sensibles junto a sus archivos' };
  }
  return {
    id: 'sensitive-copies',
    ok: true,
    detail: `aviso: ${copies.length} copia(s) sensible(s) junto a sus archivos (de versiones previas): ${copies.join(', ')}; muévelas al almacenamiento privado con ${MOVE_COMMAND}`,
  };
}

export type MoveResult = { ok: true; moved: Array<{ from: string; to: string }> } | { ok: false; reason: string; detail: string };

/** Mueve cada copia al almacenamiento privado validado; sin él, no mueve nada. Nada queda junto al original. */
export async function moveSensitiveCopies(root: string, hermesHome: string | null, host?: PrivateStorageHost): Promise<MoveResult> {
  const copies = await findSensitiveCopies(root, hermesHome);
  if (copies.length === 0) {
    return { ok: true, moved: [] };
  }
  const storage = await resolvePrivateStorage(root, host);
  if (!storage.ok) {
    return { ok: false, reason: storage.reason, detail: storage.detail };
  }
  const moved: Array<{ from: string; to: string }> = [];
  for (const file of copies) {
    const target = path.join(storage.dir, `legacy-${privateCopyName(await canonicalTargetKey(file), path.basename(file))}`);
    const bytes = await fs.readFile(file);
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST' || !(await fs.readFile(target)).equals(bytes)) {
        throw error;
      }
    });
    await fs.rm(file);
    moved.push({ from: file, to: target });
  }
  return { ok: true, moved };
}
