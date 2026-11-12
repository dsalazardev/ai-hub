import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type AiHubSource = 'env' | 'rc' | 'dot-dir' | 'plain-dir' | 'manifest-root';

export interface AiHubLocation {
  /** Absolute harness directory (the one that contains manifest.yaml). */
  dir: string;
  source: AiHubSource;
  manifest: string;
}

export interface AiHubRc {
  version: 1 | 2;
  dir?: string;
  preset?: string;
  targets?: string[];
  guardMode?: 'shadow' | 'enforce';
}

export class AiHubDirNotFoundError extends Error {
  constructor(readonly tried: string[]) {
    super(`No se encontró el arnés de ai-hub. Rutas probadas:\n${tried.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'AiHubDirNotFoundError';
  }
}

export class AiHubRcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiHubRcError';
  }
}

const RC_NAME = '.ai-hubrc.json';
const MANIFEST_NAME = 'manifest.yaml';

function hasManifest(dir: string): boolean {
  return existsSync(path.join(dir, MANIFEST_NAME));
}

/** Reads `.ai-hubrc.json` next to the caller, if present. */
export function readAiHubRc(startDir: string): AiHubRc | null {
  const file = path.join(startDir, RC_NAME);
  if (!existsSync(file)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AiHubRcError(`${RC_NAME} no es JSON válido: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AiHubRcError(`${RC_NAME} debe ser un objeto`);
  }
  const data = parsed as Record<string, unknown>;
  if (data.version !== 1 && data.version !== 2) {
    throw new AiHubRcError(`${RC_NAME}: "version" debe ser 1 o 2`);
  }
  if (data.dir !== undefined && (typeof data.dir !== 'string' || data.dir.trim() === '')) {
    throw new AiHubRcError(`${RC_NAME}: "dir" debe ser un texto no vacío`);
  }
  if (data.preset !== undefined && (typeof data.preset !== 'string' || data.preset.trim() === '')) {
    throw new AiHubRcError(`${RC_NAME}: "preset" debe ser un texto no vacío`);
  }
  if (data.guardMode !== undefined && data.guardMode !== 'shadow' && data.guardMode !== 'enforce') {
    throw new AiHubRcError(`${RC_NAME}: "guardMode" debe ser "shadow" o "enforce"`);
  }
  if (data.targets !== undefined) {
    if (!Array.isArray(data.targets) || !data.targets.every((t): t is string => typeof t === 'string')) {
      throw new AiHubRcError(`${RC_NAME}: "targets" debe ser una lista de textos`);
    }
  }
  return {
    version: data.version,
    dir: data.dir as string | undefined,
    preset: data.preset as string | undefined,
    targets: data.targets as string[] | undefined,
    guardMode: data.guardMode as 'shadow' | 'enforce' | undefined,
  };
}

export function writeAiHubRc(startDir: string, rc: AiHubRc): void {
  writeFileSync(path.join(startDir, RC_NAME), `${JSON.stringify(rc, null, 2)}\n`, 'utf8');
}

/**
 * Resolves the harness directory without assuming `.ai-hub/` or `ai-hub/`.
 *
 * Order: AI_HUB_DIR → .ai-hubrc.json `dir` → ./.ai-hub → ./ai-hub → nearest ancestor with manifest.yaml.
 * An explicit source (env or rc) that points nowhere fails fast instead of silently falling through.
 */
export function resolveAiHubDir(startDir: string = process.cwd()): AiHubLocation {
  const start = path.resolve(startDir);
  const tried: string[] = [];

  const fromEnv = process.env.AI_HUB_DIR;
  if (fromEnv && fromEnv.trim() !== '') {
    const dir = path.resolve(start, fromEnv);
    tried.push(`${dir} (AI_HUB_DIR)`);
    if (hasManifest(dir)) {
      return { dir, source: 'env', manifest: path.join(dir, MANIFEST_NAME) };
    }
    throw new AiHubDirNotFoundError(tried);
  }

  const rc = readAiHubRc(start);
  if (rc?.dir) {
    const dir = path.resolve(start, rc.dir);
    tried.push(`${dir} (${RC_NAME})`);
    if (hasManifest(dir)) {
      return { dir, source: 'rc', manifest: path.join(dir, MANIFEST_NAME) };
    }
    throw new AiHubDirNotFoundError(tried);
  }

  const dotDir = path.join(start, '.ai-hub');
  tried.push(dotDir);
  if (hasManifest(dotDir)) {
    return { dir: dotDir, source: 'dot-dir', manifest: path.join(dotDir, MANIFEST_NAME) };
  }

  const plainDir = path.join(start, 'ai-hub');
  tried.push(plainDir);
  if (hasManifest(plainDir)) {
    return { dir: plainDir, source: 'plain-dir', manifest: path.join(plainDir, MANIFEST_NAME) };
  }

  let cursor = start;
  for (;;) {
    tried.push(cursor);
    if (hasManifest(cursor)) {
      return { dir: cursor, source: 'manifest-root', manifest: path.join(cursor, MANIFEST_NAME) };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  throw new AiHubDirNotFoundError(tried);
}

export type InitRootSource = 'dir' | 'env' | 'dir+env' | 'installation' | 'cwd';

/**
 * Raíz de `init` (init-fiabilidad, DEV-01/01a/02): nunca adopta un ancestro por su cuenta.
 * - `root`: destino elegido; `ancestor` nombra una instalación por encima de un destino explícito (solo aviso).
 * - `conflict`: `--dir` y `AI_HUB_DIR` resuelven a rutas distintas.
 * - `ancestor`: sin destino explícito ni instalación en el cwd, un ancestro tiene `manifest.yaml`.
 */
export type InitRoot =
  | { kind: 'root'; root: string; source: InitRootSource; ancestor: string | null }
  | { kind: 'conflict'; dir: string; env: string }
  | { kind: 'ancestor'; cwd: string; ancestor: string };

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Instalación presente en `dir` mismo (rc con `dir`, `./.ai-hub`, `./ai-hub` o `./manifest.yaml`), sin subir. */
function installationIn(dir: string): string | null {
  const rc = readAiHubRc(dir);
  if (rc?.dir) {
    const target = path.resolve(dir, rc.dir);
    if (hasManifest(target)) {
      return target;
    }
  }
  for (const candidate of [path.join(dir, '.ai-hub'), path.join(dir, 'ai-hub'), dir]) {
    if (hasManifest(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Ancestro más cercano (sin contar `dir`) que contiene `manifest.yaml`. */
function installedAncestor(dir: string): string | null {
  let cursor = path.dirname(dir);
  let previous = dir;
  while (cursor !== previous) {
    if (hasManifest(cursor)) {
      return cursor;
    }
    previous = cursor;
    cursor = path.dirname(cursor);
  }
  return null;
}

export function resolveInitRoot(cwd: string, explicit: { dir?: string; env?: string }): InitRoot {
  const start = path.resolve(cwd);
  const dir = explicit.dir !== undefined && explicit.dir.trim() !== '' ? path.resolve(start, explicit.dir) : null;
  const env = explicit.env !== undefined && explicit.env.trim() !== '' ? path.resolve(start, explicit.env) : null;
  if (dir !== null && env !== null && !samePath(dir, env)) {
    return { kind: 'conflict', dir, env };
  }
  const chosen = dir ?? env;
  if (chosen !== null) {
    const source: InitRootSource = dir !== null && env !== null ? 'dir+env' : dir !== null ? 'dir' : 'env';
    return { kind: 'root', root: chosen, source, ancestor: installationIn(chosen) === null ? installedAncestor(chosen) : null };
  }
  const installed = installationIn(start);
  if (installed !== null) {
    return { kind: 'root', root: installed, source: 'installation', ancestor: null };
  }
  const ancestor = installedAncestor(start);
  if (ancestor !== null) {
    return { kind: 'ancestor', cwd: start, ancestor };
  }
  return { kind: 'root', root: start, source: 'cwd', ancestor: null };
}

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_NAME);
}

export function lockPath(dir: string): string {
  return path.join(dir, 'sync.lock.json');
}
