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

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_NAME);
}

export function lockPath(dir: string): string {
  return path.join(dir, 'sync.lock.json');
}
