import fs from 'node:fs/promises';
import path from 'node:path';
import { mapLimit } from '../concurrency.js';
import { isEngineCheckout } from '../source-checkout.js';
import type { SyncConfig } from './config.js';
import { loadSyncConfig, resolveSourcePath } from './config.js';
import { normalize, renderAll, type RenderedFile, type RenderedFiles } from './render.js';
import {
  GENERATOR_VERSION,
  readLock,
  sha256,
  writeLock,
  type LockFileEntry,
  type SyncLock,
} from './lock.js';

export interface SyncResult {
  written: string[];
  removed: string[];
  problems: string[];
}

export interface SyncOptions {
  check: boolean;
  force?: boolean;
}

export class SyncSourceError extends Error {
  constructor(
    readonly source: string,
    readonly resolvedPath: string,
  ) {
    super(`fuente no encontrada: ${source} (resuelta a ${resolvedPath})`);
    this.name = 'SyncSourceError';
  }
}

export class SyncSourceCheckoutError extends Error {
  constructor(readonly root: string) {
    super(
      `checkout del motor: ${root}\n` +
        'Proyectar aquí replicaría skills, agentes y reglas sobre el taller.\n' +
        'Los destinos de agente pertenecen al proyecto consumidor, no al repo que publica el motor.\n' +
        'Usa sync --force sólo si quieres dogfooding deliberado.',
    );
    this.name = 'SyncSourceCheckoutError';
  }
}

export async function runSync(root: string, options: SyncOptions): Promise<SyncResult> {
  if (!options.check && !options.force && (await isEngineCheckout(root))) {
    throw new SyncSourceCheckoutError(root);
  }

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

  const nextLock = await buildLock(root, rendered);

  for (const rel of symlinks) {
    await fs.unlink(path.join(root, rel));
    result.removed.push(rel);
  }
  for (const rel of obsolete) {
    await fs.rm(path.join(root, rel), { force: true });
    result.removed.push(rel);
  }
  const written = await mapLimit(sortedEntries(rendered), 24, async ([rel, file]) => {
    const abs = path.join(root, rel);
    const current = await readCopy(abs);
    if (current === file.content) {
      return null;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf8');
    return rel;
  });
  result.written.push(...written.filter((rel): rel is string => rel !== null));
  await writeLock(root, nextLock);
  return result;
}

function sourceDescription(source: string): string {
  return source.startsWith('@engine/')
    ? 'viene del motor; actualiza el paquete'
    : `fuente: ${source}`;
}

async function checkCopies(root: string, rendered: RenderedFiles, previous: SyncLock | null): Promise<string[]> {
  const problems = await mapLimit(sortedEntries(rendered), 24, async ([rel, file]) => {
    const current = await readCopy(path.join(root, rel));
    if (current === null) {
      return `falta ${rel} (${sourceDescription(file.source)})`;
    }
    if (current === file.content) {
      return null;
    }
    const registered = previous?.files[rel];
    if (registered && sha256(current) !== registered.sha256) {
      const hint = file.source.startsWith('@engine/')
        ? 'viene del motor; actualiza el paquete'
        : `edita la fuente: ${file.source}`;
      return `editado a mano: ${rel} (${hint}; luego ejecuta ai-hub sync)`;
    }
    return `desactualizado: ${rel} (${sourceDescription(file.source)})`;
  });
  return problems.filter((problem): problem is string => problem !== null);
}

export async function buildLock(root: string, rendered: RenderedFiles): Promise<SyncLock> {
  const sources: Record<string, string> = {};
  const files: SyncLock['files'] = {};
  for (const [rel, file] of sortedEntries(rendered)) {
    const entry: LockFileEntry = { sha256: sha256(file.content), source: file.source };
    if (file.markerSource !== undefined) {
      entry.markerSource = file.markerSource;
    }
    files[rel] = entry;
    if (!(file.source in sources)) {
      const resolvedPath = resolveSourcePath(root, file.source);
      const sourceText = await readCopy(resolvedPath);
      if (sourceText === null) {
        throw new SyncSourceError(file.source, resolvedPath);
      }
      sources[file.source] = sha256(sourceText);
    }
  }
  return { version: 2, generatorVersion: GENERATOR_VERSION, sources: sortRecord(sources), files };
}

export async function checkLockIntegrity(root: string, lock: SyncLock): Promise<string[]> {
  const problems: string[] = [];
  for (const [rel, entry] of Object.entries(lock.files)) {
    if (!(entry.source in lock.sources)) {
      problems.push(`files["${rel}"].source no está en sources: ${entry.source}`);
    }
  }
  for (const [source, expected] of Object.entries(lock.sources)) {
    const resolvedPath = resolveSourcePath(root, source);
    const sourceText = await readCopy(resolvedPath);
    if (sourceText === null) {
      problems.push(`source no encontrada: ${source} (resuelta a ${resolvedPath})`);
      continue;
    }
    if (sha256(sourceText) !== expected) {
      problems.push(`hash de source no coincide: ${source}`);
    }
  }
  return problems;
}

export type LockCategory = 'skills' | 'agents' | 'rules' | 'preflight' | 'mcp' | 'other';

export interface LockCheckResult {
  ok: boolean;
  expectedCount: number;
  actualCount: number;
  expectedSourceCount: number;
  actualSourceCount: number;
  breakdown: Record<LockCategory, number>;
  missing: string[];
  extra: string[];
  different: string[];
  invalidSources: string[];
  error: string | null;
}

function categoryOf(source: string): LockCategory {
  if (source === '@engine/engine/preflight.md' || source === 'engine/preflight.md') {
    return 'preflight';
  }
  if (source.startsWith('@engine/skills/') || source.includes('/skills/')) {
    return 'skills';
  }
  if (source.includes('/agents/')) {
    return 'agents';
  }
  if (source.startsWith('rules/') || source.includes('/rules/')) {
    return 'rules';
  }
  if (source === 'manifest.yaml' || source === 'mcp-manifest.yaml') {
    return 'mcp';
  }
  return 'other';
}

export async function checkLock(root: string): Promise<LockCheckResult> {
  const config = await loadSyncConfig(root);
  const rendered = await renderAll(root, config);
  const breakdown: Record<LockCategory, number> = {
    skills: 0,
    agents: 0,
    rules: 0,
    preflight: 0,
    mcp: 0,
    other: 0,
  };
  for (const file of rendered.values()) {
    breakdown[categoryOf(file.source)] += 1;
  }
  const expectedCount = rendered.size;

  let expected: SyncLock;
  try {
    expected = await buildLock(root, rendered);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      expectedCount,
      actualCount: 0,
      expectedSourceCount: 0,
      actualSourceCount: 0,
      breakdown,
      missing: [],
      extra: [],
      different: [],
      invalidSources: [message],
      error: message,
    };
  }

  let actual: SyncLock | null;
  try {
    actual = await readLock(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      expectedCount,
      actualCount: 0,
      expectedSourceCount: Object.keys(expected.sources).length,
      actualSourceCount: 0,
      breakdown,
      missing: Object.keys(expected.files).sort(),
      extra: [],
      different: [],
      invalidSources: [message],
      error: message,
    };
  }

  const actualFiles = actual?.files ?? {};
  const missing = Object.keys(expected.files)
    .filter((rel) => !(rel in actualFiles))
    .sort();
  const extra = Object.keys(actualFiles)
    .filter((rel) => !(rel in expected.files))
    .sort();
  const different = Object.keys(expected.files)
    .filter((rel) => {
      const current = actualFiles[rel];
      const wanted = expected.files[rel];
      return (
        current !== undefined &&
        (current.sha256 !== wanted.sha256 ||
          current.source !== wanted.source ||
          current.markerSource !== wanted.markerSource)
      );
    })
    .sort();
  const invalidSources =
    actual === null ? ['sync.lock.json no existe'] : await checkLockIntegrity(root, actual);

  return {
    ok:
      missing.length === 0 &&
      extra.length === 0 &&
      different.length === 0 &&
      invalidSources.length === 0,
    expectedCount,
    actualCount: Object.keys(actualFiles).length,
    expectedSourceCount: Object.keys(expected.sources).length,
    actualSourceCount: actual === null ? 0 : Object.keys(actual.sources).length,
    breakdown,
    missing,
    extra,
    different,
    invalidSources,
    error: actual === null ? 'sync.lock.json no existe' : null,
  };
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
