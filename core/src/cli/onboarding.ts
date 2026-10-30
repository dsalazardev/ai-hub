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
  removeOwned,
} from '../presets/materialize.js';
import { resolvePreset, type ResolvedPreset } from '../presets/resolve.js';
import { listPresetIds } from '../presets/schema.js';
import { loadManifestContext, writeInventory, type ProjectManifest } from '../manifest/manifest.js';
import { emptyState, migrateLegacyState, readState, StateNotFoundError, writeState } from '../harness/memory/state.js';
import { runSync } from '../sync/sync.js';
import { TOOL_IDS, assertToolIds, TARGETS } from '../sync/targets.js';
import { sha256 } from '../sync/lock.js';
import { isEngineCheckout } from '../source-checkout.js';
import { assertExclusions, isInteractiveRequest, runAssistantInit } from './assistant.js';
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
import { loadEngine, type EngineManifest, type SpeckitScript } from '../engine/engine.js';
import {
  probeEnvironment,
  runSpeckitSequence,
  speckitPreflight,
  type PreflightResult,
  type SpeckitEnvironment,
} from '../speckit/commands.js';
import { DEFAULT_SPECKIT_SCRIPTS, effectiveSpeckit, type ProjectSpeckit, type SpeckitSettings } from '../speckit/settings.js';
import { checkExtensions, checkIntegrations, readSpeckitState } from '../speckit/state.js';
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
  speckitCommands: number;
  agentCount: number;
  ruleCount: number;
  mcp: boolean;
  migrate: boolean;
  write: string[];
  speckit: SpeckitPlan;
  hash: string;
}

/** Intención de Spec Kit dentro del hash del plan; el entorno (uv, shell) queda fuera. */
export interface SpeckitPlan {
  managed: boolean;
  package: string;
  /** Versión que la instalación fija: la resuelta, o el rango cuando no hay resolución (design D5). */
  version: string | null;
  /** Rango soportado declarado por el paquete; única fuente de versión. */
  supported: string;
  script: string;
  /** Conjunto elegido; sólo cuando difiere de los tres por defecto (design D4). */
  scripts?: string[];
  defaultIntegration: string | null;
  integrations: string[];
  extensions: Record<string, string>;
}

function speckitPlan(settings: SpeckitSettings, resolved: string | null): SpeckitPlan {
  // D4: el conjunto entra al cuerpo hasheado sólo cuando difiere de los tres por defecto
  // (mismo orden) — así toda invocación existente queda byte a byte igual y
  // `--scripts sh,ps,py` explícito ≡ bare. Una permutación sí difiere: otra orden de
  // init es otra intención.
  const isDefault =
    settings.scripts.length === DEFAULT_SPECKIT_SCRIPTS.length &&
    settings.scripts.every((script, index) => script === DEFAULT_SPECKIT_SCRIPTS[index]);
  return {
    managed: settings.managed,
    package: settings.package,
    version: resolved,
    supported: settings.supported,
    script: settings.script,
    ...(isDefault ? {} : { scripts: settings.scripts }),
    defaultIntegration: settings.defaultIntegration,
    integrations: settings.integrations,
    extensions: settings.extensions,
  };
}

/**
 * Bloque `speckit` a escribir: conserva las restricciones del proyecto y fija `managed`, el
 * script explícito y el conjunto explícito (design D3: persistencia espejo — `script` sólo con
 * `--script`, `scripts` sólo con `--scripts`; sin flag, el valor del manifest existente viaja).
 */
function speckitBlock(
  existing: ProjectSpeckit | undefined,
  managed: boolean,
  script?: SpeckitScript,
  scripts?: SpeckitScript[],
): ProjectSpeckit {
  return {
    ...(existing ?? {}),
    managed,
    ...(script !== undefined ? { script } : {}),
    ...(scripts !== undefined ? { scripts: [...scripts] } : {}),
  };
}

/**
 * Lee `--script <sh|ps|py>` (design D3): valida antes de cualquier sondeo y nombra el comando concreto.
 * Devuelve `undefined` cuando la bandera no se usó y `null` cuando es inválida (ya reportado).
 */
function parseScriptFlag(
  args: ParsedArgs,
  ctx: CliContext,
  command: 'init' | 'install',
): SpeckitScript | undefined | null {
  try {
    return scriptFromArgs(args, command);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return null;
  }
}

/** Análogo de `parseScriptFlag` para `--scripts`: `null` cuando es inválida (ya reportado). */
function parseScriptsFlag(
  args: ParsedArgs,
  ctx: CliContext,
  command: 'init' | 'install',
): SpeckitScript[] | undefined | null {
  try {
    return scriptsFromArgs(args, command);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return null;
  }
}

/** Validación pura de `--script`; lanza con el mensaje canónico. Compartida por init e install. */
function scriptFromArgs(args: ParsedArgs, command: 'init' | 'install'): SpeckitScript | undefined {
  if (!('script' in args.flags)) {
    return undefined;
  }
  const value = flagString(args, 'script');
  if (value === 'sh' || value === 'ps' || value === 'py') {
    return value;
  }
  throw new Error(
    `--script acepta sh, ps o py${value === null ? ' y necesita un valor' : ` (recibido: ${value})`}; ` +
      `ejecuta ai-hub ${command} --script sh, ai-hub ${command} --script ps o ai-hub ${command} --script py`,
  );
}

/**
 * Validación pura de `--scripts` (design D3): lista comma-separated de sh, ps, py,
 * mínimo un valor, sin duplicados. Compartida por init e install.
 */
function scriptsFromArgs(args: ParsedArgs, command: 'init' | 'install'): SpeckitScript[] | undefined {
  if (!('scripts' in args.flags)) {
    return undefined;
  }
  const items = flagList(args, 'scripts');
  if (items.length === 0) {
    throw new Error(
      `--scripts necesita una lista sh, ps, py separada por comas, mínimo un valor; ` +
        `ejecuta ai-hub ${command} --scripts py o ai-hub ${command} --scripts sh,ps,py`,
    );
  }
  const scripts: SpeckitScript[] = [];
  for (const item of items) {
    if (item !== 'sh' && item !== 'ps' && item !== 'py') {
      throw new Error(
        `--scripts acepta sh, ps, py (recibido: ${item}); ` +
          `ejecuta ai-hub ${command} --scripts py o ai-hub ${command} --scripts sh,ps,py`,
      );
    }
    if (scripts.includes(item)) {
      throw new Error(
        `--scripts no admite duplicados y acepta sh, ps, py (recibido repetido: ${item}); ` +
          `ejecuta ai-hub ${command} --scripts py o ai-hub ${command} --scripts sh,ps,py`,
      );
    }
    scripts.push(item);
  }
  return scripts;
}

/**
 * Coherencia explícita de activo y conjunto (design D3): el activo resuelto por
 * precedencia (flag → manifest) no puede caer fuera del conjunto efectivo
 * (flag → manifest → los tres) cuando fue elegido por flag o declarado en el
 * manifest; sólo el default del engine (ni flag ni manifest) coacciona dentro
 * del conjunto en `effectiveSpeckit`. Un `--script` explícito pisa al
 * `speckit.script` del manifest, así la migración `--scripts py --script py`
 * sobre un manifest `sh` procede; `--scripts py` solo sobre ese manifest falla
 * porque cambiaría el activo declarado en silencio.
 */
function assertScriptCoherence(
  script: SpeckitScript | undefined,
  scripts: SpeckitScript[] | undefined,
  existing: ProjectSpeckit | undefined,
  command: 'init' | 'install',
): void {
  const effectiveSet = scripts ?? existing?.scripts;
  const active = script ?? existing?.script;
  if (effectiveSet === undefined || active === undefined || effectiveSet.includes(active)) {
    return;
  }
  const setSource =
    scripts !== undefined
      ? `--scripts [${scripts.join(', ')}]`
      : `speckit.scripts [${effectiveSet.join(', ')}] del manifest`;
  const activeSource =
    script !== undefined ? `--script ${script}` : `speckit.script ${existing?.script} del manifest`;
  throw new Error(
    `${activeSource} queda fuera del conjunto ${setSource}; el activo debe ser uno del conjunto elegido — ` +
      `inclúyelo con ai-hub ${command} --scripts ${[...effectiveSet, active].join(',')} ` +
      `o elige el activo dentro de [${effectiveSet.join(', ')}]`,
  );
}

function speckitSettingsFor(
  targets: string[],
  block: ProjectSpeckit,
  engine: EngineManifest,
): SpeckitSettings {
  return effectiveSpeckit({ targets, speckit: block }, engine);
}

async function environmentFor(
  settings: SpeckitSettings,
  ctx: CliContext,
): Promise<SpeckitEnvironment | { skipped: string }> {
  if (!settings.managed) {
    return { skipped: 'Spec Kit no gestionado (--no-speckit)' };
  }
  return probeEnvironment(settings, ctx.exec, ctx.root);
}

/** Preflight de Spec Kit; devuelve el resultado (con la versión resuelta) o null si no corre. */
async function preflightOrReport(
  settings: SpeckitSettings,
  ctx: CliContext,
  command: 'init' | 'install',
): Promise<PreflightResult | null> {
  if (!settings.managed) {
    return null;
  }
  const preflight = await speckitPreflight(settings, ctx.exec, ctx.root, command);
  if (!preflight.ok) {
    ctx.io.err('preflight de Spec Kit fallido; no se escribió nada:');
    for (const problem of preflight.problems) {
      ctx.io.err(`  - ${problem}`);
    }
  }
  return preflight;
}

/** Ejecuta la secuencia de Spec Kit; devuelve `false` y explica cómo restaurar si falla. */
async function installSpeckit(
  settings: SpeckitSettings,
  ctx: CliContext,
  backupId: string | null,
): Promise<boolean> {
  const result = await runSpeckitSequence(settings, ctx.exec, ctx.root);
  const problems: string[] = [];
  if (!result.ok) {
    problems.push(result.failure ?? 'fallo desconocido');
  } else {
    // Paso 9d: la secuencia solo cuenta si deja las integraciones y extensiones esperadas.
    const state = await readSpeckitState(ctx.root);
    problems.push(...checkIntegrations(settings, state), ...(await checkExtensions(ctx.root, settings, state)));
  }
  if (problems.length > 0) {
    ctx.io.err('Spec Kit no quedó instalado como se esperaba:');
    for (const problem of problems) {
      ctx.io.err(`  - ${problem}`);
    }
    if (backupId !== null) {
      ctx.io.err(`restaura el estado previo con: ai-hub restore ${backupId}`);
    }
    return false;
  }
  return true;
}

function speckitSummary(settings: SpeckitSettings, resolved: string | null): string {
  return settings.managed
    ? `Spec Kit ${resolved ?? `rango ${settings.supported}`} · script ${settings.script} · integraciones ${settings.integrations.join(', ')}`
    : 'Spec Kit no gestionado (--no-speckit): el arnés queda degradado; ejecuta ai-hub install para activarlo';
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

export interface SelectionSpec {
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
  const items = flagList(args, 'exclude');
  // Regla compartida con el asistente (R1): un exclude válido en flags lo es en la TUI.
  assertExclusions(items);
  const skills = new Set<string>();
  const agents = new Set<string>();
  const rules = new Set<string>();
  for (const item of items) {
    const separator = item.indexOf(':');
    const kind = separator >= 0 ? item.slice(0, separator) : 'skill';
    const id = separator >= 0 ? item.slice(separator + 1) : item;
    if (id === '') {
      continue;
    }
    if (kind === 'agent') {
      agents.add(id);
    } else if (kind === 'rule') {
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
    const retired = new Set(await retiredCatalogSkills(existing.skills.publish));
    return {
      modes: {
        skills: existing.skills.selection ?? 'preset',
        agents: existing.agents.selection ?? 'preset',
        rules: existing.rules.selection ?? 'preset',
      },
      skills: existing.skills.publish.filter((id) => !retired.has(id)),
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
  speckit: ProjectSpeckit,
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
    speckit,
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
  // Los 17 comandos los proyecta Spec Kit; AI-Hub solo proyecta las skills de proyecto.
  void engine;
  const allSkills = [...new Set(selection.skills)];
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
    destinations += selection.rules.length + 2; // reglas materializadas + preflight + regla de enlace de Spec Kit
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

/**
 * Todo lo que `cmdInit` resuelve antes de decidir si imprime o aplica: un solo constructor
 * de plan (R1). El asistente y el camino de flags pasan por aquí, así que el mismo input
 * da el mismo plan y el mismo hash por construcción (design D2/D4).
 */
export interface PreparedInit {
  id: string;
  rc: AiHubRc;
  engine: EngineManifest;
  selection: { preset: ResolvedPreset; profilePackageManager?: string; targets: string[]; migrate: boolean };
  spec: SelectionSpec;
  includeMcp: boolean;
  assets: AssetPlan;
  speckit: ProjectSpeckit;
  speckitSettings: SpeckitSettings;
  /** El taller nunca ejecuta Spec Kit: su .specify/ es del mantenedor. */
  runSpeckit: boolean;
  existing: ProjectManifest | undefined;
  write: string[];
  planBodyFor(resolved: string | null): Omit<Plan, 'hash'>;
}

/**
 * Resuelve el plan de init sin imprimir ni escribir. Lanza `Error` con el mensaje canónico
 * cuando el input es inválido (quien llama decide imprimirlo y el código de salida).
 */
export async function prepareInit(args: ParsedArgs, ctx: CliContext): Promise<PreparedInit> {
  const scriptFlag = scriptFromArgs(args, 'init');
  const scriptsFlag = scriptsFromArgs(args, 'init');
  const sourceCheckout = await isEngineCheckout(ctx.root);
  const selection = await resolveSelection(args, ctx);
  if (selection.migrate && !sourceCheckout) {
    throw new Error('--migrate solo aplica en el checkout de desarrollo; la instalación no tiene .planning/');
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
  assertScriptCoherence(scriptFlag, scriptsFlag, existing?.speckit, 'init');
  const spec = await buildSelection(args, selection.preset, engine, existing);
  const includeMcp = await exists(path.join(ctx.root, 'mcp-manifest.yaml'));
  const assets = await buildAssetPlan(spec, engine, selection.targets, includeMcp);
  const speckit = speckitBlock(existing?.speckit, !args.flags['no-speckit'], scriptFlag, scriptsFlag);
  const speckitSettings = speckitSettingsFor(selection.targets, speckit, engine);
  // El taller nunca ejecuta Spec Kit: su .specify/ es del mantenedor.
  const runSpeckit = speckitSettings.managed && !sourceCheckout;
  const write: string[] = [RC_NAME, 'manifest.yaml', '.gitignore', '.ai-hub/'];
  if (runSpeckit) {
    write.push('.specify/');
  }
  if (selection.migrate) {
    write.push('.planning/state.json');
  }
  const planBodyFor = (resolved: string | null): Omit<Plan, 'hash'> => ({
    command: 'init',
    project: id,
    preset: selection.preset.id,
    targets: selection.targets,
    ...assets,
    skillCount: spec.skills.length,
    speckitCommands: engine.commands.length,
    agentCount: spec.agents.length,
    ruleCount: spec.rules.length + 1,
    mcp: includeMcp,
    migrate: selection.migrate,
    write,
    speckit: speckitPlan(speckitSettings, resolved),
  });
  return {
    id,
    rc,
    engine,
    selection,
    spec,
    includeMcp,
    assets,
    speckit,
    speckitSettings,
    runSpeckit,
    existing,
    write,
    planBodyFor,
  };
}

/** Imprime el plan con su entorno, el mismo JSON que `--dry-run`; devuelve el plan sellado. */
export function printInitPlan(
  prepared: PreparedInit,
  ctx: CliContext,
  environment: SpeckitEnvironment | { skipped: string },
): Plan {
  const resolved = 'version' in environment ? environment.version : null;
  const planBody = prepared.planBodyFor(resolved);
  const plan: Plan = { ...planBody, hash: sha256(JSON.stringify(planBody)) };
  ctx.io.out(JSON.stringify({ ...plan, environment }, null, 2));
  return plan;
}

export async function cmdInit(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const sourceCheckout = await isEngineCheckout(ctx.root);
  // Gate del asistente (design D3): sólo instalación, sólo TTY, sólo sin flags.
  // Ni una línea del asistente corre antes de esta comprobación (R2).
  if (!sourceCheckout && isInteractiveRequest(args, ctx)) {
    return runAssistantInit(ctx);
  }
  let prepared: PreparedInit;
  try {
    prepared = await prepareInit(args, ctx);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }

  if (!args.flags.yes || args.flags['dry-run']) {
    const environment = await environmentFor(prepared.speckitSettings, ctx);
    printInitPlan(prepared, ctx, environment);
    if (!args.flags['dry-run']) {
      ctx.io.out('Nada escrito. Repite con --yes para aplicar este plan.');
    }
    return 0;
  }

  const preflight = prepared.runSpeckit ? await preflightOrReport(prepared.speckitSettings, ctx, 'init') : null;
  if (preflight !== null && !preflight.ok) {
    return 2;
  }
  // Backup restaurable antes de que Spec Kit toque un proyecto existente (constitución incluida).
  const backupId =
    prepared.existing || (await exists(path.join(ctx.root, '.specify')))
      ? (await createBackup(ctx.root, 'init')).id
      : null;
  const materialized = await materializeSelection(ctx.root, prepared.selection.preset, prepared.spec);
  const manifest = manifestFromSelection(
    prepared.id,
    prepared.selection.preset,
    prepared.selection.targets,
    prepared.selection.profilePackageManager,
    prepared.rc.guardMode ?? 'shadow',
    prepared.includeMcp,
    prepared.spec,
    prepared.speckit,
  );
  await writeManifest(ctx.root, manifest);
  await writeInventory(ctx.root);
  if (prepared.runSpeckit && !(await installSpeckit(prepared.speckitSettings, ctx, backupId))) {
    return 1;
  }
  // El hash describe la instalación real: la versión que quedó registrada tras instalar (design D5).
  let resolved = preflight?.version ?? null;
  if (prepared.runSpeckit) {
    resolved = (await readSpeckitState(ctx.root)).initOptions?.speckit_version ?? resolved;
  }
  const planBody = prepared.planBodyFor(resolved);
  const plan: Plan = { ...planBody, hash: sha256(JSON.stringify(planBody)) };
  const sync = await runSync(ctx.root, { check: false });
  const existingRc = readAiHubRc(ctx.cwd);
  if (!existingRc || existingRc.version === 1 || args.flags.force) {
    writeAiHubRc(ctx.cwd, prepared.rc);
  }
  if (sourceCheckout) {
    try {
      await readState(ctx.root);
    } catch (error) {
      if (error instanceof StateNotFoundError) {
        await writeState(ctx.root, emptyState(prepared.id, prepared.selection.preset.id));
      } else {
        throw error;
      }
    }
    if (prepared.selection.migrate) {
      await migrateLegacyState(ctx.root, prepared.id, prepared.selection.preset.id);
    }
  }
  await ensureProjectIgnores(ctx.root);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `init: ${prepared.selection.preset.id} · skills=${prepared.spec.modes.skills} agents=${prepared.spec.modes.agents} rules=${prepared.spec.modes.rules} · ${prepared.spec.skills.length} skills de proyecto + ${prepared.engine.commands.length} comandos Spec Kit · ${prepared.spec.agents.length} agentes · ${prepared.spec.rules.length + 1} reglas · ${prepared.assets.destinations} destinos · ${sync.written.length} sincronizados · ${materialized.written.length} nuevos, ${materialized.kept.length} conservados, ${materialized.collisions.length} colisiones`,
  );
  if (materialized.collisions.length > 0) {
    ctx.io.err(`colisiones (no se sobrescribieron): ${materialized.collisions.join(', ')}`);
  }
  ctx.io.out(speckitSummary(prepared.speckitSettings, resolved));
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
  const retired = new Set(await retiredCatalogSkills(skills));
  return {
    modes,
    skills: [...new Set(skills.filter((id) => !exclusions.skills.has(id) && !retired.has(id)))].sort(),
    agents: [...new Set(agents.filter((id) => !exclusions.agents.has(id)))].sort(),
    rules: [...new Set(filterRules(rulesBase, exclusions.rules))].sort(),
  };
}

/** Ids de `ids` que el catálogo publica con `runtime: false` (no instalables). */
async function retiredCatalogSkills(ids: string[]): Promise<string[]> {
  const retired = new Set((await catalogIndex()).retiredSkills);
  return ids.filter((id) => retired.has(id));
}

export async function cmdInstall(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const scriptFlag = parseScriptFlag(args, ctx, 'install');
  if (scriptFlag === null) {
    return 2;
  }
  const scriptsFlag = parseScriptsFlag(args, ctx, 'install');
  if (scriptsFlag === null) {
    return 2;
  }
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  try {
    assertScriptCoherence(scriptFlag, scriptsFlag, context.manifest.speckit, 'install');
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  let spec: SelectionSpec;
  try {
    spec = await selectionForInstall(args, context.manifest, context.preset, context.engine);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  const includeMcp = await exists(path.join(ctx.root, 'mcp-manifest.yaml'));
  // install sin --no-speckit reactiva Spec Kit en un arnés degradado; con la bandera lo mantiene apagado.
  const speckit = speckitBlock(context.manifest.speckit, !args.flags['no-speckit'], scriptFlag, scriptsFlag);
  const speckitSettings = speckitSettingsFor(context.manifest.targets, speckit, context.engine);
  const runSpeckit = speckitSettings.managed && !(await isEngineCheckout(ctx.root));
  if (args.flags['dry-run']) {
    const assets = await buildAssetPlan(spec, context.engine, context.manifest.targets, includeMcp);
    const environment = await environmentFor(speckitSettings, ctx);
    const resolved = 'version' in environment ? environment.version : null;
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
          speckit: speckitPlan(speckitSettings, resolved),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const preflight = runSpeckit ? await preflightOrReport(speckitSettings, ctx, 'install') : null;
  if (preflight !== null && !preflight.ok) {
    return 2;
  }
  const backupId = runSpeckit ? (await createBackup(ctx.root, 'install')).id : null;
  const materialized = await materializeSelection(ctx.root, context.preset, spec);
  // Migración: las skills `runtime: false` salen de .ai-hub/ si las escribió ai-hub;
  // sync retira después sus copias de los destinos.
  for (const id of await retiredCatalogSkills(context.manifest.skills.publish)) {
    await removeOwned(ctx.root, path.join(context.manifest.skills.source, id), true);
  }
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
  next.speckit = speckit;
  await writeManifest(ctx.root, next);
  if (runSpeckit && !(await installSpeckit(speckitSettings, ctx, backupId))) {
    return 1;
  }
  // El resumen informa la versión que quedó registrada, no la declarada (design D5).
  let resolved = preflight?.version ?? null;
  if (runSpeckit) {
    resolved = (await readSpeckitState(ctx.root)).initOptions?.speckit_version ?? resolved;
  }
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  await ensureProjectIgnores(ctx.root);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `install: skills=${spec.modes.skills} agents=${spec.modes.agents} rules=${spec.modes.rules} · ${spec.skills.length} skills de proyecto + ${context.engine.commands.length} comandos Spec Kit · ${spec.agents.length} agentes · ${spec.rules.length + 1} reglas · ${materialized.written.length} nuevos · ${materialized.kept.length} conservados · ${sync.written.length} sincronizados`,
  );
  if (!Object.values(spec.modes).includes('full')) {
    ctx.io.out('full: no aplica; usa install --full para expandir el catálogo');
  }
  ctx.io.out(speckitSummary(speckitSettings, resolved));
  return 0;
}

export async function cmdRepair(args: ParsedArgs, ctx: CliContext): Promise<number> {
  return cmdInstall(args, ctx);
}

export async function availablePresets(): Promise<string[]> {
  return listPresetIds();
}
