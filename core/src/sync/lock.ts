import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LOCK_PATH = '.ai-hub/sync.lock.json';

export interface LockFileEntry {
  sha256: string;
  source: string;
}

export interface SyncLock {
  version: 1;
  sources: Record<string, string>;
  files: Record<string, LockFileEntry>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function readLock(root: string): Promise<SyncLock | null> {
  const raw = await fs.readFile(path.join(root, LOCK_PATH), 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<SyncLock>;
  if (parsed.version !== 1 || typeof parsed.files !== 'object' || typeof parsed.sources !== 'object') {
    throw new Error(`${LOCK_PATH} no tiene el formato esperado; bórralo y ejecuta ai-hub sync`);
  }
  return parsed as SyncLock;
}

export async function writeLock(root: string, lock: SyncLock): Promise<void> {
  await fs.writeFile(path.join(root, LOCK_PATH), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}
