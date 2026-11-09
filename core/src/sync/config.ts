import fs from 'node:fs/promises';
import type { AreaSpec } from '../engine/scopes.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifestContext } from '../manifest/manifest.js';
import { TARGETS, assertToolIds, type SkillShape, type ToolId } from './targets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CORE_ROOT = path.join(__dirname, '..', '..');
export const ENGINE_SKILLS_SOURCE = '@engine/skills/shared';

export function resolveSourcePath(root: string, source: string): string {
  if (source.startsWith('@engine/')) {
    return path.join(CORE_ROOT, ...source.slice('@engine/'.length).split('/'));
  }
  return path.join(root, ...source.split('/'));
}

export interface SkillSource {
  source: string;
  publish: string[];
}

export interface SkillTarget {
  path: string;
  shape: SkillShape;
}

export interface AgentTarget {
  path: string;
}

export interface RuleTarget {
  path: string;
  shape: 'md' | 'mdc' | 'instructions';
}

export interface SyncConfig {
  tools: ToolId[];
  skills: { sources: SkillSource[]; targets: SkillTarget[] };
  agents: { source: string; publish: string[]; targets: Record<string, AgentTarget> };
  rules: { source: string; publish: string[]; targets: Record<string, RuleTarget> };
  mcp: { source: string } | null;
  opencode: { instructions: string[] };
  /** `manifest.agentModels.<target>.<tier>` (A3): el modelo lo pone el proyecto, nunca el motor. */
  agentModels: Record<string, Record<string, string>>;
  /** Knobs restrictivos del proyecto (E4) que la regla ai-hub-speckit proyecta. */
  projectPolicy: ProjectPolicyKnobs;
  /** Áreas de implementación (E3): una regla por área y destino. */
  areas: AreaSpec[];
  /** Escribir la región reservada de AGENTS.md (E2). */
  agentsMd: boolean;
  /** Valores de `manifest.stack` para `{{stack.*}}` en fuentes del preset (M-27). */
  stack: Record<string, string>;
}

export interface ProjectPolicyKnobs {
  wip?: number;
  maxRounds?: number;
  requireEars?: boolean;
  requireTraceability?: boolean;
}

export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConfigError';
  }
}

export const MANIFEST_PATH = 'manifest.yaml';

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function loadSyncConfig(root: string): Promise<SyncConfig> {
  let context;
  try {
    context = await loadManifestContext(root);
  } catch (error) {
    throw new SyncConfigError((error as Error).message);
  }
  const { manifest, engine } = context;
  const tools = assertToolIds(manifest.targets);

  const skillTargets: SkillTarget[] = [];
  const seenSkillTargets = new Set<string>();
  for (const tool of tools) {
    const spec = TARGETS[tool];
    if (!seenSkillTargets.has(spec.skills)) {
      seenSkillTargets.add(spec.skills);
      skillTargets.push({ path: spec.skills, shape: spec.skillShape });
    }
  }

  const agentTargets: Record<string, AgentTarget> = {};
  for (const tool of tools) {
    const spec = TARGETS[tool];
    if (spec.agents) {
      agentTargets[tool] = { path: spec.agents };
    }
  }

  const ruleTargets: Record<string, RuleTarget> = {};
  for (const tool of tools) {
    const spec = TARGETS[tool];
    ruleTargets[tool] = { path: spec.rules, shape: spec.ruleShape };
  }

  // Los 17 comandos los provee Spec Kit en cada destino; AI-Hub no proyecta sus cuerpos.
  void engine;
  const sources: SkillSource[] = [];
  if (manifest.skills.publish.length > 0) {
    sources.push({ source: manifest.skills.source, publish: manifest.skills.publish });
  }

  let mcp: { source: string } | null = null;
  if (manifest.mcp) {
    const direct = manifest.mcp.source;
    const project = path.join('.ai-hub', path.basename(direct));
    if (await exists(path.join(root, direct))) {
      mcp = { source: direct };
    } else if (await exists(path.join(root, project))) {
      mcp = { source: project };
    }
  }

  const instructions: string[] = [];
  const coreRule = path.posix.join(manifest.rules.source.replace(/\\/g, '/'), 'core.md');
  if (await exists(path.join(root, ...coreRule.split('/')))) {
    instructions.push(coreRule);
  }

  return {
    tools,
    skills: { sources, targets: skillTargets },
    agents: { source: manifest.agents.source, publish: manifest.agents.publish, targets: agentTargets },
    agentModels: manifest.agentModels ?? {},
    areas: manifest.paths.areas ?? [],
    agentsMd: manifest.agentsMd === true,
    stack: Object.fromEntries(
      Object.entries(manifest.stack).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]),
    ),
    projectPolicy: {
      ...(manifest.policy.wip !== undefined ? { wip: manifest.policy.wip } : {}),
      ...(manifest.policy.maxRounds !== undefined ? { maxRounds: manifest.policy.maxRounds } : {}),
      ...(manifest.policy.requireEars !== undefined ? { requireEars: manifest.policy.requireEars } : {}),
      ...(manifest.policy.requireTraceability !== undefined ? { requireTraceability: manifest.policy.requireTraceability } : {}),
    },
    rules: { source: manifest.rules.source, publish: manifest.rules.publish, targets: ruleTargets },
    mcp,
    opencode: { instructions },
  };
}
