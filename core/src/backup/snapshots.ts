import fs from 'node:fs/promises';
import path from 'node:path';
import { readLock } from '../sync/lock.js';

export const BACKUP_DIR = '.backups';
export const SNAPSHOT_FILE = 'snapshot.json';
export const INSTALLED_RELATIVE = '.planning/installed.json';

export interface SnapshotRecord {
  id: string;
  createdAt: string;
  reason: string;
  files: string[];
}

export class BackupNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`snapshot no encontrado: ${id}`);
    this.name = 'BackupNotFoundError';
  }
}

function snapshotDir(root: string, id: string): string {
  return path.join(root, BACKUP_DIR, id);
}

function newId(reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = reason.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '') || 'manual';
  return `${stamp}-${slug}`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function walkRelative(root: string, relative: string): Promise<string[]> {
  const absolute = path.join(root, relative);
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walkRelative(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function managedFiles(root: string): Promise<string[]> {
  const files = new Set<string>([
    'sync.lock.json',
    '.ai-hubrc.json',
    'manifest.yaml',
    INSTALLED_RELATIVE,
  ]);
  const lock = await readLock(root);
  for (const rel of Object.keys(lock?.files ?? {})) {
    files.add(rel);
  }
  for (const rel of await walkRelative(root, '.ai-hub')) {
    files.add(rel);
  }
  const result: string[] = [];
  for (const rel of [...files].sort()) {
    if (await exists(path.join(root, rel))) {
      result.push(rel);
    }
  }
  return result;
}

export async function createBackup(root: string, reason = 'manual'): Promise<SnapshotRecord> {
  const id = newId(reason);
  const dir = snapshotDir(root, id);
  const files = await managedFiles(root);
  for (const rel of files) {
    const destination = path.join(dir, 'files', rel);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, rel), destination);
  }
  const record: SnapshotRecord = {
    id,
    createdAt: new Date().toISOString(),
    reason,
    files,
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, SNAPSHOT_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export async function listBackups(root: string): Promise<SnapshotRecord[]> {
  const dir = path.join(root, BACKUP_DIR);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const records: SnapshotRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const raw = await fs
      .readFile(path.join(dir, entry.name, SNAPSHOT_FILE), 'utf8')
      .catch(() => null);
    if (raw === null) {
      continue;
    }
    try {
      records.push(JSON.parse(raw) as SnapshotRecord);
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new BackupNotFoundError(id);
  }
}

export async function restoreBackup(root: string, id: string): Promise<{ restored: string[] }> {
  assertSafeId(id);
  const dir = snapshotDir(root, id);
  const raw = await fs.readFile(path.join(dir, SNAPSHOT_FILE), 'utf8').catch(() => null);
  if (raw === null) {
    throw new BackupNotFoundError(id);
  }
  const record = JSON.parse(raw) as SnapshotRecord;
  const restored: string[] = [];
  for (const rel of record.files) {
    const source = path.join(dir, 'files', rel);
    if (!(await exists(source))) {
      continue;
    }
    const destination = path.join(root, rel);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    restored.push(rel);
  }
  return { restored };
}

export interface PurgeResult {
  refused: boolean;
  backup: SnapshotRecord | null;
  removed: string[];
}

export async function purgeGenerated(root: string, confirm: boolean): Promise<PurgeResult> {
  if (!confirm) {
    return { refused: true, backup: null, removed: [] };
  }
  const backup = await createBackup(root, 'purge');
  const lock = await readLock(root);
  const targets = new Set<string>(Object.keys(lock?.files ?? {}));
  targets.add('sync.lock.json');
  targets.add('.ai-hubrc.json');
  targets.add(INSTALLED_RELATIVE);
  const removed: string[] = [];
  for (const rel of [...targets].sort()) {
    const abs = path.join(root, rel);
    if (await exists(abs)) {
      await fs.rm(abs, { force: true });
      removed.push(rel);
    }
  }
  const dirs = new Set(
    removed
      .map((rel) => path.posix.dirname(rel))
      .filter((dir) => dir !== '.' && dir !== '.planning'),
  );
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await removeEmptyDirs(root, dir);
  }
  return { refused: false, backup, removed };
}

async function removeEmptyDirs(root: string, rel: string): Promise<void> {
  let current = rel;
  for (;;) {
    if (current === '.' || current.startsWith('..') || current === '') {
      return;
    }
    const abs = path.join(root, current);
    const entries = await fs.readdir(abs).catch(() => null);
    if (entries === null || entries.length > 0) {
      return;
    }
    await fs.rmdir(abs).catch(() => undefined);
    current = path.posix.dirname(current);
  }
}
