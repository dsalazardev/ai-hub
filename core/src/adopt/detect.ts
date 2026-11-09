import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * F0 de `ai-hub adopt` (factory-evolution E1, M-08): detecta un arnés heredado copiado dentro del
 * repositorio (núcleo vendorizado, manifiesto y lock v1, MCP local, metodología anterior…). Solo lee.
 */
export type LegacyItemId =
  | 'vendored-core'
  | 'manifest-v1'
  | 'lock-v1'
  | 'harness-mcp'
  | 'openspec'
  | 'planning'
  | 'ai-scripts'
  | 'githooks';

export interface LegacyItem {
  id: LegacyItemId;
  path: string;
  detail: string;
}

export interface LegacyDetection {
  /** `true` si hay un arnés heredado que adoptar (núcleo vendorizado o manifiesto v1). */
  legacy: boolean;
  items: LegacyItem[];
  manifest: Record<string, unknown> | null;
  scripts: Record<string, string>;
}

export const LEGACY_MANIFEST = '.ai-hub/manifest.yaml';
export const LEGACY_LOCK = '.ai-hub/sync.lock.json';
export const LEGACY_MCP = '.ai-hub/mcp-manifest.yaml';
export const LEGACY_CORE = '.ai-hub/core';

async function readText(root: string, rel: string): Promise<string | null> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8').catch(() => null);
}

async function isDir(root: string, rel: string): Promise<boolean> {
  return fs.stat(path.join(root, ...rel.split('/'))).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tracked(root: string, rel: string): boolean {
  const result = spawnSync('git', ['ls-files', '--', rel], { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 && (result.stdout ?? '').trim() !== '';
}

export async function detectLegacy(root: string): Promise<LegacyDetection> {
  const items: LegacyItem[] = [];
  const corePackage = await readText(root, `${LEGACY_CORE}/package.json`);
  if (corePackage !== null) {
    let name = 'desconocido';
    let version = '?';
    try {
      const data = JSON.parse(corePackage) as { name?: unknown; version?: unknown };
      name = typeof data.name === 'string' ? data.name : name;
      version = typeof data.version === 'string' ? data.version : version;
    } catch {
      // Un package.json ilegible sigue siendo un núcleo vendorizado.
    }
    items.push({ id: 'vendored-core', path: LEGACY_CORE, detail: `${name}@${version} copiado dentro del repositorio` });
  }
  let manifest: Record<string, unknown> | null = null;
  const manifestText = await readText(root, LEGACY_MANIFEST);
  if (manifestText !== null) {
    try {
      const data: unknown = parse(manifestText);
      if (isRecord(data) && (data.version === 1 || data.schema === 'ai-hub-manifest')) {
        manifest = data;
        items.push({ id: 'manifest-v1', path: LEGACY_MANIFEST, detail: 'manifiesto v1 (agents.can_modify, rule_sources, references…)' });
      }
    } catch {
      items.push({ id: 'manifest-v1', path: LEGACY_MANIFEST, detail: 'manifiesto heredado ilegible' });
    }
  }
  const lockText = await readText(root, LEGACY_LOCK);
  if (lockText !== null) {
    try {
      const data = JSON.parse(lockText) as { version?: unknown };
      if (data.version === 1) {
        items.push({ id: 'lock-v1', path: LEGACY_LOCK, detail: 'lock v1 dentro de .ai-hub/' });
      }
    } catch {
      items.push({ id: 'lock-v1', path: LEGACY_LOCK, detail: 'lock heredado ilegible' });
    }
  }
  if ((await readText(root, LEGACY_MCP)) !== null) {
    items.push({ id: 'harness-mcp', path: LEGACY_MCP, detail: 'manifiesto MCP dentro de .ai-hub/ (el actual vive en la raíz)' });
  }
  if (await isDir(root, 'openspec')) {
    items.push({ id: 'openspec', path: 'openspec/', detail: 'metodología anterior; queda como histórico de solo lectura' });
  }
  if (await isDir(root, '.planning')) {
    items.push({
      id: 'planning',
      path: '.planning/',
      detail: tracked(root, '.planning') ? 'versionado (en la instalación el estado vive en .ai-hub/work/)' : 'local',
    });
  }
  const scripts: Record<string, string> = {};
  const packageText = await readText(root, 'package.json');
  if (packageText !== null) {
    try {
      const data = JSON.parse(packageText) as { scripts?: Record<string, unknown> };
      for (const [name, command] of Object.entries(data.scripts ?? {})) {
        if (name.startsWith('ai:') && typeof command === 'string') {
          scripts[name] = command;
        }
      }
    } catch {
      // package.json ilegible: no hay scripts que sugerir.
    }
  }
  if (Object.keys(scripts).length > 0) {
    items.push({ id: 'ai-scripts', path: 'package.json', detail: `scripts ${Object.keys(scripts).join(', ')}` });
  }
  if (await isDir(root, '.githooks')) {
    items.push({ id: 'githooks', path: '.githooks/', detail: 'hooks de git propios (no se editan)' });
  }
  const legacy = items.some((item) => item.id === 'vendored-core' || item.id === 'manifest-v1');
  return { legacy, items, manifest, scripts };
}
