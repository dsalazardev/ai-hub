import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPreset, PresetError, presetDir, type Preset, type PresetDangerPattern } from './schema.js';

export interface ResolvedPreset {
  id: string;
  version: number;
  description: string;
  chain: string[];
  stack: { languages: string[]; frontend?: string; backend?: string; packageManager?: string };
  commands: Record<string, string>;
  paths: { source: string[]; tests: string[]; docs: string[] };
  policy: {
    trunk: 'auto' | 'closed' | 'open';
    guardMode: 'shadow' | 'enforce';
    worktrees: boolean;
    optOuts: string[];
    dangerPatterns: PresetDangerPattern[];
  };
  rules: string[];
  agents: string[];
  skills: string[];
  mcp: { source: string };
}

function mergeList(base: string[] | undefined, child: string[] | undefined): string[] {
  return [...new Set([...(base ?? []), ...(child ?? [])])];
}

function mergePatterns(
  base: PresetDangerPattern[] | undefined,
  child: PresetDangerPattern[] | undefined,
): PresetDangerPattern[] {
  const byId = new Map<string, PresetDangerPattern>();
  for (const pattern of [...(base ?? []), ...(child ?? [])]) {
    byId.set(pattern.id, pattern);
  }
  return [...byId.values()];
}

type PresetLoader = (id: string) => Promise<Preset>;

export async function resolvePreset(id: string): Promise<ResolvedPreset> {
  return resolvePresetWith(id, loadPreset);
}

export async function resolvePresetWith(
  id: string,
  loader: PresetLoader,
): Promise<ResolvedPreset> {
  const chain: Preset[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current) {
    if (seen.has(current)) {
      throw new PresetError([`ciclo de herencia detectado: ${[...seen, current].join(' -> ')}`]);
    }
    seen.add(current);
    const preset = await loader(current);
    chain.unshift(preset);
    current = preset.extends ?? null;
  }

  const resolved: ResolvedPreset = {
    id: chain[chain.length - 1].id,
    version: chain[chain.length - 1].version,
    description: chain[chain.length - 1].description,
    chain: chain.map((preset) => preset.id),
    stack: { languages: [] },
    commands: {},
    paths: { source: [], tests: [], docs: [] },
    policy: {
      trunk: 'auto',
      guardMode: 'shadow',
      worktrees: true,
      optOuts: [],
      dangerPatterns: [],
    },
    rules: [],
    agents: [],
    skills: [],
    mcp: { source: 'mcp-manifest.yaml' },
  };

  for (const preset of chain) {
    resolved.stack = { ...resolved.stack, ...(preset.stack ?? {}) };
    resolved.stack.languages = mergeList(resolved.stack.languages, preset.stack?.languages);
    resolved.commands = { ...resolved.commands, ...(preset.commands ?? {}) };
    resolved.paths = {
      source: mergeList(resolved.paths.source, preset.paths?.source),
      tests: mergeList(resolved.paths.tests, preset.paths?.tests),
      docs: mergeList(resolved.paths.docs, preset.paths?.docs),
    };
    resolved.policy = {
      trunk: preset.policy?.trunk ?? resolved.policy.trunk,
      guardMode: preset.policy?.guardMode ?? resolved.policy.guardMode,
      worktrees: preset.policy?.worktrees ?? resolved.policy.worktrees,
      optOuts: mergeList(resolved.policy.optOuts, preset.policy?.optOuts),
      dangerPatterns: mergePatterns(resolved.policy.dangerPatterns, preset.policy?.dangerPatterns),
    };
    resolved.rules = mergeList(resolved.rules, preset.rules);
    resolved.agents = mergeList(resolved.agents, preset.agents?.publish);
    resolved.skills = mergeList(resolved.skills, preset.skills?.publish);
    if (preset.mcp?.source) {
      resolved.mcp.source = preset.mcp.source;
    }
  }

  return resolved;
}

export async function findPresetAsset(chain: string[], relative: string): Promise<string | null> {
  for (const id of [...chain].reverse()) {
    const candidate = path.join(presetDir(id), ...relative.split('/'));
    if (await fs.access(candidate).then(() => true, () => false)) {
      return candidate;
    }
  }
  return null;
}
