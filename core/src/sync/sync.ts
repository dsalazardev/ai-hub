import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncConfig } from './config.js';
import { loadSyncConfig, resolveSourcePath } from './config.js';
import { normalize, renderAll, type RenderedFile, type RenderedFiles } from './render.js';
import { GENERATOR_VERSION, readLock, sha256, writeLock, type SyncLock } from './lock.js';

export interface SyncResult {
  written: string[];
  removed: string[];
  problems: string[];
}

export interface SyncOptions {
  check: boolean;
}

export async function runSync(root: string, options: SyncOptions): Promise<SyncResult> {
  const config = await loadSyncConfig(root);
  const rendered = await renderAll(root, config);
  const previous = await readLock(root);
  const result: SyncResult = { written: [], removed: [], problems: [] };

  const symlinks = await findSymlinks(root, config, rendered);
  const obsolete = previous
    ? Object.keys(previous.files)
        .filter((rel) => !rendered.has(rel))
        .sort()
    : [];

  if (options.check) {
    result.problems.push(...(await checkCopies(root, rendered, previous)));
    result.problems.push(...symlinks.map((rel) => `enlace simbólico no permitido: ${rel}`));
    result.problems.push(...obsolete.map((rel) => `destino obsoleto: ${rel}`));
    return result;
  }

  for (const rel of symlinks) {
    await fs.unlink(path.join(root, rel));
    result.removed.push(rel);
  }
  for (const rel of obsolete) {
    await fs.rm(path.join(root, rel), { force: true });
    result.removed.push(rel);
  }
  for (const [rel, file] of sortedEntries(rendered)) {
    const abs = path.join(root, rel);
    const current = await readCopy(abs);
    if (current === file.content) {
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf8');
    result.written.push(rel);
  }
  await writeLock(root, await buildLock(root, rendered));
  return result;
}

async function checkCopies(root: string, rendered: RenderedFiles, previous: SyncLock | null): Promise<string[]> {
  const problems: string[] = [];
  for (const [rel, file] of sortedEntries(rendered)) {
    const current = await readCopy(path.join(root, rel));
    if (current === null) {
      problems.push(`falta ${rel} (fuente: ${file.source})`);
    } else if (current !== file.content) {
      const registered = previous?.files[rel];
      if (registered && sha256(current) !== registered.sha256) {
        problems.push(
          `editado a mano: ${rel} (edita la fuente: ${file.source}; luego ejecuta ai-hub sync)`,
        );
      } else {
        problems.push(`desactualizado: ${rel} (fuente: ${file.source})`);
      }
    }
  }
  return problems;
}

async function buildLock(root: string, rendered: RenderedFiles): Promise<SyncLock> {
  const sources: Record<string, string> = {};
  const files: SyncLock['files'] = {};
  for (const [rel, file] of sortedEntries(rendered)) {
    files[rel] = { sha256: sha256(file.content), source: file.source };
    if (!(file.source in sources)) {
      const sourceText = await readCopy(resolveSourcePath(root, file.source));
      sources[file.source] = sha256(sourceText ?? '');
    }
  }
  return { version: 2, generatorVersion: GENERATOR_VERSION, sources: sortRecord(sources), files };
}

async function findSymlinks(root: string, config: SyncConfig, rendered: RenderedFiles): Promise<string[]> {
  const generatedDirs = [
    ...config.skills.targets.map((target) => target.path),
    ...Object.values(config.agents.targets).map((target) => target.path),
    ...Object.values(config.rules.targets).map((target) => target.path),
  ];
  const found = new Set<string>();
  for (const dir of generatedDirs) {
    await collectSymlinks(root, dir, found);
  }
  for (const rel of rendered.keys()) {
    const stat = await fs.lstat(path.join(root, rel)).catch(() => null);
    if (stat?.isSymbolicLink()) {
      found.add(rel);
    }
  }
  return [...found].sort();
}

async function collectSymlinks(root: string, relDir: string, found: Set<string>): Promise<void> {
  const absDir = path.join(root, relDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return;
  }
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      found.add(rel);
    } else if (entry.isDirectory()) {
      await collectSymlinks(root, rel, found);
    }
  }
}

async function readCopy(abs: string): Promise<string | null> {
  const text = await fs.readFile(abs, 'utf8').catch(() => null);
  return text === null ? null : normalize(text);
}

function sortedEntries(rendered: RenderedFiles): [string, RenderedFile][] {
  return [...rendered.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
