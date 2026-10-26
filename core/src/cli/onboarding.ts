import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { createBackup } from '../backup/snapshots.js';
import { readAiHubRc, writeAiHubRc, type AiHubRc } from '../paths.js';
import { detectPreset } from '../presets/detect.js';
import {
  materializeCatalog,
  materializePreset,
  materializeUniversalRules,
} from '../presets/materialize.js';
import { resolvePreset, type ResolvedPreset } from '../presets/resolve.js';
import { listPresetIds } from '../presets/schema.js';
import { loadManifestContext, writeInventory, type ProjectManifest } from '../manifest/manifest.js';
import { emptyState, migrateLegacyState, readState, StateNotFoundError, writeState } from '../harness/memory/state.js';
import { runSync } from '../sync/sync.js';
import { TOOL_IDS, assertToolIds, TARGETS } from '../sync/targets.js';
import { sha256 } from '../sync/lock.js';
import { isEngineCheckout } from '../source-checkout.js';
import {
  ENGINE_AGENTS_DIR,
  ENGINE_RULES_DIR,
  catalogIndex,
  catalogSeal,
  expectedRuleIds,
  hasFullDimension,
  listCatalogAgents,
  listCatalogSkills,
  type SelectionMode,
} from '../catalog.js';
import { loadEngine } from '../engine/engine.js';
import { flagList, flagString } from './args.js';
import type { CliContext, ParsedArgs } from './types.js';

const RC_NAME = '.ai-hubrc.json';

export async function cliVersion(): Promise<string> {
  const raw = await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

export interface AssetPlan {
  selection: SelectionMode;
  selections: { skills: SelectionMode; agents: SelectionMode; rules: SelectionMode };
  skills: string[];
  agents: string[];
  rules: string[];
  destinations: number;
  files: number;
  bytes: number;
}

export interface Plan extends AssetPlan {
  command: 'init';
  project: string;
  preset: string;
  targets: string[];
  skillCount: number;
  agentCount: number;
  ruleCount: number;
  mcp: boolean;
  migrate: boolean;
  write: string[];
  hash: string;
}

function projectId(root: string): string {
  const base = path.basename(path.resolve(root)).toLowerCase();
  const id = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return /^[a-z]/.test(id) ? id : `project-${id || 'root'}`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

interface SelectionSpec {
  modes: { skills: SelectionMode; agents: SelectionMode; rules: SelectionMode };
  skills: string[];
  agents: string[];
  rules: string[];
}

function overallMode(modes: SelectionSpec['modes']): SelectionMode {
  return modes.skills === modes.agents && modes.agents === modes.rules ? modes.skills : 'custom';
}

function parseExclusions(args: ParsedArgs): {
  skills: Set<string>;
  agents: Set<string>;
  rules: Set<string>;
} {
  const skills = new Set<string>();
  const agents = new Set<string>();
  const rules = new Set<string>();
  for (const item of flagList(args, 'exclude')) {
    const separator = item.indexOf(':');
    const kind = separator >= 0 ? item.slice(0, separator) : 'skill';
    const id = separator >= 0 ? item.slice(separator + 1) : item;
    if (id === '') {
      continue;
    }
    if (kind === 'agent') {
      agents.add(id);
    } else if (kind === 'rule') {
      if (id === 'core' || id === 'preflight') {
        throw new Error(`la regla base "${id}" no se puede excluir`);
      }
      rules.add(id);
    } else {
      skills.add(id);
    }
  }
  return { skills, agents, rules };
}

function filterRules(rules: string[], exclusions: Set<string>): string[] {
  return rules.filter((id) => {
    for (const excluded of exclusions) {
      if (excluded === id || (excluded === 'skill-quality' && id.startsWith('skill-quality/'))) {
        return false;
      }
    }
    return true;
  });
}

async function buildSelection(
  args: ParsedArgs,
  preset: ResolvedPreset,
  engine: Awaited<ReturnType<typeof loadEngine>>,
  existing?: ProjectManifest,
): Promise<SelectionSpec> {
  const fullFlag = Boolean(args.flags.full);
  const presetOnly = Boolean(args.flags['preset-only']);
  if (fullFlag && presetOnly) {
    throw new Error('--full y --preset-only son incompatibles');
  }
  const exclusions = parseExclusions(args);
  const hasExclusions =
    exclusions.skills.size > 0 || exclusions.agents.size > 0 || exclusions.rules.size > 0;
  if (existing && !fullFlag && !presetOnly && !hasExclusions) {
    return {
      modes: {
        skills: existing.skills.selection ?? 'preset',
        agents: existing.agents.selection ?? 'preset',
        rules: existing.rules.selection ?? 'preset',
      },
      skills: [...existing.skills.publish],
      agents: [...existing.agents.publish],
      rules: [...existing.rules.publish],
    };
  }

  const catalogSkills = await listCatalogSkills(engine);
  const catalogAgents = await listCatalogAgents();
  const defaultMode: SelectionMode = presetOnly
    ? 'preset'
    : fullFlag
      ? 'full'
      : existing
        ? (existing.skills.selection ?? 'preset')
        : 'full';
  const modes: SelectionSpec['modes'] = {
    skills: exclusions.skills.size > 0 ? 'custom' : defaultMode,
    agents: exclusions.agents.size > 0 ? 'custom' : defaultMode,
    rules: exclusions.rules.size > 0 ? 'custom' : defaultMode,
  };
  const skillsBase =
    modes.skills === 'preset'
      ? [...preset.skills]
      : modes.skills === 'custom' && existing
        ? [...existing.skills.publish]
        : [...catalogSkills];
  const agentsBase =
    modes.agents === 'preset'
      ? [...preset.agents]
      : modes.agents === 'custom' && existing
        ? [...existing.agents.publish]
        : [...catalogAgents];
  const rulesBase =
    modes.rules === 'preset'
      ? expectedRuleIds('preset', preset)
      : modes.rules === 'custom' && existing
        ? [...existing.rules.publish]
        : expectedRuleIds('full', preset);
  return {
    modes,
    skills: [...new Set(skillsBase.filter((id) => !exclusions.skills.has(id)))].sort(),
    agents: [...new Set(agentsBase.filter((id) => !exclusions.agents.has(id)))].sort(),
    rules: [...new Set(filterRules(rulesBase, exclusions.rules))].sort(),
  };
}

function manifestFromSelection(
  id: string,
  preset: ResolvedPreset,
  targets: string[],
  profilePackageManager: string | undefined,
  guardMode: 'shadow' | 'enforce',
  includeMcp: boolean,
  selection: SelectionSpec,
): ProjectManifest {
  const manifest: ProjectManifest = {
    version: 2,
    project: { id, name: id },
    preset: { id: preset.id, version: preset.version, source: 'package' },
    stack: {
      ...preset.stack,
      packageManager: profilePackageManager ?? preset.stack.packageManager,
    },
    commands: preset.commands,
    paths: preset.paths,
    targets,
    policy: {
      trunk: preset.policy.trunk,
      guardMode,
      worktrees: preset.policy.worktrees,
      optOuts: preset.policy.optOuts,
      ...(preset.policy.dangerPatterns.length > 0
        ? { dangerPatterns: preset.policy.dangerPatterns }
        : {}),
    },
    skills: { source: '.ai-hub/skills', publish: selection.skills, selection: selection.modes.skills },
    agents: { source: '.ai-hub/agents', publish: selection.agents, selection: selection.modes.agents },
    rules: { source: '.ai-hub/rules', publish: selection.rules, selection: selection.modes.rules },
    ...(includeMcp ? { mcp: { source: 'mcp-manifest.yaml' } } : {}),
  };
  if (hasFullDimension(manifest)) {
    manifest.catalog = catalogSeal(manifest);
  }
  return manifest;
}

function mergeMaterialized(
  target: { written: string[]; kept: string[]; collisions: string[] },
  source: { written: string[]; kept: string[]; collisions: string[] },
): void {
  target.written.push(...source.written);
  target.kept.push(...source.kept);
  target.collisions.push(...source.collisions);
}

async function materializeSelection(
  root: string,
  preset: ResolvedPreset,
  selection: SelectionSpec,
): Promise<{ written: string[]; kept: string[]; collisions: string[] }> {
  const result = { written: [] as string[], kept: [] as string[], collisions: [] as string[] };
  mergeMaterialized(result, await materializePreset(root, preset, selection.rules));
  if (selection.modes.rules !== 'preset') {
    mergeMaterialized(result, await materializeUniversalRules(root, preset, selection.rules));
  }
  if (selection.modes.skills !== 'preset' || selection.modes.agents !== 'preset') {
    const presetSkills = new Set(preset.skills);
    const presetAgents = new Set(preset.agents);
    mergeMaterialized(
      result,
      await materializeCatalog(
        root,
        selection.modes.skills === 'preset'
          ? []
          : selection.skills.filter((id) => !presetSkills.has(id)),
        selection.modes.agents === 'preset'
          ? []
          : selection.agents.filter((id) => !presetAgents.has(id)),
      ),
    );
  }
  return result;
}

async function buildAssetPlan(
  selection: SelectionSpec,
  engine: Awaited<ReturnType<typeof loadEngine>>,
  targets: string[],
  includeMcp: boolean,
): Promise<AssetPlan> {
  const index = await catalogIndex();
  const engineSkills = engine.commands.map((command) => command.skill);
  const allSkills = [...new Set([...engineSkills, ...selection.skills])];
  const projectSkillFiles = selection.skills.reduce(
    (total, id) => total + (index.skillFiles[id]?.length ?? 0),
    0,
  );
  const skillFiles = allSkills.reduce(
    (total, id) => total + (index.skillFiles[id]?.length ?? 0),
    0,
  );
  let destinations = 1; // opencode.json
  for (const tool of targets as Array<keyof typeof TARGETS>) {
    const target = TARGETS[tool];
    destinations += target.skillShape === 'file' ? allSkills.length : skillFiles;
    if (target.agents) {
      destinations += selection.agents.length;
    }
    destinations += selection.rules.length + 1; // reglas materializadas + preflight
  }
  if (includeMcp) {
    destinations += 3;
  }

  const materializedFiles =
    projectSkillFiles + selection.agents.length + selection.rules.length + 2;
  const files = materializedFiles + destinations;
  let bytes = 0;
  const stat = async (file: string): Promise<number> =>
    fs.stat(file).then((value) => value.size, () => 0);
  for (const id of allSkills) {
    for (const file of index.skillFiles[id] ?? []) {
      bytes += await stat(file);
    }
  }
  for (const id of selection.agents) {
    bytes += await stat(path.join(ENGINE_AGENTS_DIR, `${id}.md`));
  }
  for (const id of selection.rules) {
    if (id.startsWith('skill-quality/')) {
      bytes += await stat(path.join(ENGINE_RULES_DIR, `${id}.md`));
    }
  }
  return {
    selection: overallMode(selection.modes),
    selections: selection.modes,
    skills: selection.skills,
    agents: selection.agents,
    rules: selection.rules,
    destinations,
    files,
    bytes,
  };
}

export async function writeManifest(root: string, manifest: ProjectManifest): Promise<void> {
  await fs.writeFile(path.join(root, 'manifest.yaml'), stringify(manifest), 'utf8');
}

const GENERATED_IGNORES = [
  '.worktrees/',
  '.claude/',
  '.opencode/',
  '.pi/',
  '.cursor/',
  '.github/skills/',
  '.github/agents/',
  '.github/instructions/',
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  'opencode.json',
];

async function ensureProjectIgnores(root: string): Promise<void> {
  const file = path.join(root, '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = GENERATED_IGNORES.filter((entry) => !present.has(entry));
  if (missing.length === 0) {
    return;
  }
  const base = current === '' ? '' : `${current.replace(/\s*$/, '')}\n`;
  await fs.writeFile(file, `${base}${missing.join('\n')}\n`, 'utf8');
}

async function installPostMergeHook(root: string): Promise<{ installed: boolean; reason: string }> {
  if (!(await exists(path.join(root, '.git')))) {
    return { installed: false, reason: 'not a git repository' };
  }
  const hook = path.join(root, '.git', 'hooks', 'post-merge');
  if (await exists(hook)) {
    return { installed: false, reason: 'a post-merge hook already exists; chain ai-hub manually' };
  }
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(
    hook,
    '#!/bin/sh\n# ai-hub managed worktree cleanup\nnpx --no-install ai-hub worktrees reap --auto >/dev/null 2>&1 || true\n',
    'utf8',
  );
  await fs.chmod(hook, 0o755);
  return { installed: true, reason: 'installed' };
}

async function resolveSelection(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<{ preset: ResolvedPreset; profilePackageManager?: string; targets: string[]; migrate: boolean }> {
  const rc = readAiHubRc(ctx.cwd);
  const explicit = flagString(args, 'preset') ?? rc?.preset;
  const detected = await detectPreset(ctx.root);
  if (!explicit && detected.ambiguous.length > 0) {
    throw new Error(
      `detección ambigua entre ${detected.ambiguous.join(', ')}; elige con --preset <id>`,
    );
  }
  const presetId = explicit ?? detected.id;
  const preset = await resolvePreset(presetId);
  const requested = flagList(args, 'targets');
  const targets =
    requested.length > 0
      ? assertToolIds(requested)
      : rc?.targets && rc.targets.length > 0
        ? assertToolIds(rc.targets)
        : [...TOOL_IDS];
  return {
    preset,
    profilePackageManager: detected.profile.packageManagers[0],
    targets,
    migrate: Boolean(args.flags.migrate),
  };
}

export async function cmdInit(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const sourceCheckout = await isEngineCheckout(ctx.root);
  let selection;
  try {
    selection = await resolveSelection(args, ctx);
    if (selection.migrate && !sourceCheckout) {
      throw new Error('--migrate solo aplica en el checkout de desarrollo; la instalación no tiene .planning/');
    }
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  const id = projectId(ctx.cwd);
  const rc: AiHubRc = {
    version: 2,
    dir: '.',
    preset: selection.preset.id,
    targets: selection.targets,
    guardMode: 'shadow',
  };
  const engine = await loadEngine();
  let existing: ProjectManifest | undefined;
  if (await exists(path.join(ctx.root, 'manifest.yaml'))) {
    existing = (await loadManifestContext(ctx.root).catch(() => null))?.manifest;
  }
  let spec: SelectionSpec;
  try {
    spec = await buildSelection(args, selection.preset, engine, existing);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  const includeMcp = await exists(path.join(ctx.root, 'mcp-manifest.yaml'));
  const assets = await buildAssetPlan(spec, engine, selection.targets, includeMcp);
  const write: string[] = [RC_NAME, 'manifest.yaml', '.gitignore', '.ai-hub/'];
  if (selection.migrate) {
    write.push('.planning/state.json');
  }
  const planBody: Omit<Plan, 'hash'> = {
    command: 'init',
    project: id,
    preset: selection.preset.id,
    targets: selection.targets,
    ...assets,
    skillCount: 17 + spec.skills.length,
    agentCount: spec.agents.length,
    ruleCount: spec.rules.length + 1,
    mcp: includeMcp,
    migrate: selection.migrate,
    write,
  };
  const plan: Plan = { ...planBody, hash: sha256(JSON.stringify(planBody)) };

  if (!args.flags.yes || args.flags['dry-run']) {
    ctx.io.out(JSON.stringify(plan, null, 2));
    if (!args.flags['dry-run']) {
      ctx.io.out('Nada escrito. Repite con --yes para aplicar este plan.');
    }
    return 0;
  }

  if (existing) {
    await createBackup(ctx.root, 'init');
  }
  const materialized = await materializeSelection(ctx.root, selection.preset, spec);
  const manifest = manifestFromSelection(
    id,
    selection.preset,
    selection.targets,
    selection.profilePackageManager,
    rc.guardMode ?? 'shadow',
    includeMcp,
    spec,
  );
  await writeManifest(ctx.root, manifest);
  await writeInventory(ctx.root);
  const sync = await runSync(ctx.root, { check: false });
  const existingRc = readAiHubRc(ctx.cwd);
  if (!existingRc || existingRc.version === 1 || args.flags.force) {
    writeAiHubRc(ctx.cwd, rc);
  }
  if (sourceCheckout) {
    try {
      await readState(ctx.root);
    } catch (error) {
      if (error instanceof StateNotFoundError) {
        await writeState(ctx.root, emptyState(id, selection.preset.id));
      } else {
        throw error;
      }
    }
    if (selection.migrate) {
      await migrateLegacyState(ctx.root, id, selection.preset.id);
    }
  }
  await ensureProjectIgnores(ctx.root);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `init: ${selection.preset.id} · skills=${spec.modes.skills} agents=${spec.modes.agents} rules=${spec.modes.rules} · ${spec.skills.length + 17} skills · ${spec.agents.length} agentes · ${spec.rules.length + 1} reglas · ${assets.destinations} destinos · ${sync.written.length} sincronizados · ${materialized.written.length} nuevos, ${materialized.kept.length} conservados, ${materialized.collisions.length} colisiones`,
  );
  if (materialized.collisions.length > 0) {
    ctx.io.err(`colisiones (no se sobrescribieron): ${materialized.collisions.join(', ')}`);
  }
  ctx.io.out(`plan: ${plan.hash}`);
  return 0;
}

async function selectionForInstall(
  args: ParsedArgs,
  manifest: ProjectManifest,
  preset: ResolvedPreset,
  engine: Awaited<ReturnType<typeof loadEngine>>,
): Promise<SelectionSpec> {
  const fullFlag = Boolean(args.flags.full);
  const presetOnly = Boolean(args.flags['preset-only']);
  if (fullFlag && presetOnly) {
    throw new Error('--full y --preset-only son incompatibles');
  }
  const exclusions = parseExclusions(args);
  const modes: SelectionSpec['modes'] = {
    skills: exclusions.skills.size > 0
      ? 'custom'
      : presetOnly
        ? 'preset'
        : fullFlag
          ? 'full'
          : (manifest.skills.selection ?? 'preset'),
    agents: exclusions.agents.size > 0
      ? 'custom'
      : presetOnly
        ? 'preset'
        : fullFlag
          ? 'full'
          : (manifest.agents.selection ?? 'preset'),
    rules: exclusions.rules.size > 0
      ? 'custom'
      : presetOnly
        ? 'preset'
        : fullFlag
          ? 'full'
          : (manifest.rules.selection ?? 'preset'),
  };
  const catalogSkills = await listCatalogSkills(engine);
  const catalogAgents = await listCatalogAgents();
  const skills =
    modes.skills === 'full'
      ? catalogSkills
      : modes.skills === 'preset'
        ? [...preset.skills]
        : [...manifest.skills.publish];
  const agents =
    modes.agents === 'full'
      ? catalogAgents
      : modes.agents === 'preset'
        ? [...preset.agents]
        : [...manifest.agents.publish];
  const rulesBase =
    modes.rules === 'full'
      ? expectedRuleIds('full', preset)
      : modes.rules === 'preset'
        ? expectedRuleIds('preset', preset)
        : [...manifest.rules.publish];
  return {
    modes,
    skills: [...new Set(skills.filter((id) => !exclusions.skills.has(id)))].sort(),
    agents: [...new Set(agents.filter((id) => !exclusions.agents.has(id)))].sort(),
    rules: [...new Set(filterRules(rulesBase, exclusions.rules))].sort(),
  };
}

export async function cmdInstall(args: ParsedArgs, ctx: CliContext): Promise<number> {
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  let spec: SelectionSpec;
  try {
    spec = await selectionForInstall(args, context.manifest, context.preset, context.engine);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  const includeMcp = await exists(path.join(ctx.root, 'mcp-manifest.yaml'));
  if (args.flags['dry-run']) {
    const assets = await buildAssetPlan(spec, context.engine, context.manifest.targets, includeMcp);
    ctx.io.out(
      JSON.stringify(
        {
          dryRun: true,
          action: 'install',
          preset: context.preset.id,
          targets: context.manifest.targets,
          selection: spec.modes,
          skills: spec.skills.length,
          agents: spec.agents.length,
          rules: spec.rules.length + 1,
          destinations: assets.destinations,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const materialized = await materializeSelection(ctx.root, context.preset, spec);
  const next: ProjectManifest = {
    ...context.manifest,
    skills: { ...context.manifest.skills, publish: spec.skills, selection: spec.modes.skills },
    agents: { ...context.manifest.agents, publish: spec.agents, selection: spec.modes.agents },
    rules: { ...context.manifest.rules, publish: spec.rules, selection: spec.modes.rules },
  };
  if (includeMcp) {
    next.mcp = { source: 'mcp-manifest.yaml' };
  } else {
    delete next.mcp;
  }
  if (hasFullDimension(next)) {
    next.catalog = catalogSeal(next);
  } else {
    delete next.catalog;
  }
  await writeManifest(ctx.root, next);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  await ensureProjectIgnores(ctx.root);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `install: skills=${spec.modes.skills} agents=${spec.modes.agents} rules=${spec.modes.rules} · ${spec.skills.length + 17} skills · ${spec.agents.length} agentes · ${spec.rules.length + 1} reglas · ${materialized.written.length} nuevos · ${materialized.kept.length} conservados · ${sync.written.length} sincronizados`,
  );
  if (!Object.values(spec.modes).includes('full')) {
    ctx.io.out('full: no aplica; usa install --full para expandir el catálogo');
  }
  return 0;
}

export async function cmdRepair(args: ParsedArgs, ctx: CliContext): Promise<number> {
  return cmdInstall(args, ctx);
}

export async function availablePresets(): Promise<string[]> {
  return listPresetIds();
}
