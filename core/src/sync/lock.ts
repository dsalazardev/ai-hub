import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LOCK_PATH = 'sync.lock.json';
export const GENERATOR_VERSION = '1.0.0';

export interface LockFileEntry {
  sha256: string;
  source: string;
  markerSource?: string;
}

export interface SyncLock {
  version: 2;
  generatorVersion: string;
  sources: Record<string, string>;
  files: Record<string, LockFileEntry>;
}

interface LegacyLock {
  version: 1;
  sources: Record<string, string>;
  files: Record<string, LockFileEntry>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readLock(root: string): Promise<SyncLock | null> {
  const raw = await fs.readFile(path.join(root, LOCK_PATH), 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${LOCK_PATH} no es JSON válido: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.files) || !isRecord(parsed.sources)) {
    throw new Error(`${LOCK_PATH} no tiene el formato esperado; bórralo y ejecuta ai-hub sync`);
  }
  if (parsed.version === 1) {
    const legacy = parsed as unknown as LegacyLock;
    return { version: 2, generatorVersion: 'legacy', sources: legacy.sources, files: legacy.files };
  }
  if (parsed.version !== 2) {
    throw new Error(`${LOCK_PATH} usa una versión no soportada; bórralo y ejecuta ai-hub sync`);
  }
  return {
    version: 2,
    generatorVersion: typeof parsed.generatorVersion === 'string' ? parsed.generatorVersion : 'unknown',
    sources: parsed.sources as Record<string, string>,
    files: parsed.files as Record<string, LockFileEntry>,
  };
}

export async function writeLock(root: string, lock: SyncLock): Promise<void> {
  await fs.writeFile(path.join(root, LOCK_PATH), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}
