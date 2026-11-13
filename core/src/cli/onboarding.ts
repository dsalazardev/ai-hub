import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { stringify } from 'yaml';
import { createBackup } from '../backup/snapshots.js';
import { materializeHarnessLocal } from '../harness/local.js';
import { installGitHook } from './githooks.js';
import { readAiHubRc, resolveInitRoot, writeAiHubRc, type AiHubRc, type InitRoot } from '../paths.js';
import { detectPreset } from '../presets/detect.js';
import {
  materializeCatalog,
  materializePreset,
  materializeUniversalRules,
  removeOwned,
} from '../presets/materialize.js';
import { resolvePreset, type ResolvedPreset } from '../presets/resolve.js';
import { listPresetIds } from '../presets/schema.js';
import {
  loadManifestContext,
  validateManifestData,
  writeInventory,
  type ProjectManifest,
} from '../manifest/manifest.js';
import { emptyState, migrateLegacyState, readState, StateNotFoundError, writeState } from '../harness/memory/state.js';
import { runSync } from '../sync/sync.js';
import { TOOL_IDS, assertToolIds, TARGETS } from '../sync/targets.js';
import { sha256 } from '../sync/lock.js';
import { isEngineCheckout } from '../source-checkout.js';
import { assertExclusions, isInteractiveRequest, runAssistantInit, writeBacklogSeed } from './assistant.js';
import {
  IdeaCancelled,
  IdeaInputError,
  describeIdea,
  ideaFromEditor,
  processIdeaStdin,
  realEditorHost,
  resolveIdeaFromFlags,
  type IdeaOutcome,
} from './idea.js';
import { CONNECT_USAGE, TOKEN_FLAG_REFUSED, connectFromFlagsReport, contextHost, readStdin, validateConnectFlags } from '../control/onboard-step.js';
import { ENROLL_ACTION, RETAKE_ACTION, RETAKE_PROVIDE, isolate, printReports, type IntegrationReport } from './integrations.js';
import { connectionSaved } from '../control/onboard.js';
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
  target: { written: string[]; kept: string[]; updated: string[]; collisions: string[] },
  source: { written: string[]; kept: string[]; updated: string[]; collisions: string[] },
): void {
  target.written.push(...source.written);
  target.kept.push(...source.kept);
  target.updated.push(...source.updated);
  target.collisions.push(...source.collisions);
}

async function materializeSelection(
  root: string,
  preset: ResolvedPreset,
  selection: SelectionSpec,
): Promise<{ written: string[]; kept: string[]; updated: string[]; collisions: string[] }> {
  const result = { written: [] as string[], kept: [] as string[], updated: [] as string[], collisions: [] as string[] };
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
  areaCount = 0,
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
    destinations += selection.rules.length + 3; // reglas materializadas + preflight + regla de enlace de Spec Kit + lecciones (PD-2)
    destinations += areaCount; // una regla por área (E3)
    if (target.hookFormat === 'plugin') {
      destinations += 1; // hook ejecutable generado (G-01); los hooks en ajustes del usuario no van al lock
    }
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
  // Locales del arnés (PD-1/PD-2): credenciales y telemetría nunca se versionan.
  '.ai-hub/.env',
  '.ai-hub/runs/',
];

/** Memoria de agente (M-26): ignorada salvo `agentMemory: versioned`. */
export const AGENT_MEMORY_IGNORES = ['.claude/agent-memory/'];

async function ensureProjectIgnores(root: string, agentMemory?: 'versioned' | 'ignored'): Promise<void> {
  const file = path.join(root, '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const wanted = agentMemory === 'versioned' ? GENERATED_IGNORES : [...GENERATED_IGNORES, ...AGENT_MEMORY_IGNORES];
  const missing = wanted.filter((entry) => !present.has(entry));
  if (missing.length === 0) {
    return;
  }
  const base = current === '' ? '' : `${current.replace(/\s*$/, '')}\n`;
  await fs.writeFile(file, `${base}${missing.join('\n')}\n`, 'utf8');
}

async function installPostMergeHook(root: string): Promise<{ installed: boolean; reason: string }> {
  return installGitHook(root, 'post-merge');
}

async function resolveSelection(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<{ preset: ResolvedPreset; profilePackageManager?: string; targets: string[]; migrate: boolean }> {
  const rc = readAiHubRc(ctx.root);
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
  const id = projectId(ctx.root);
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
  const assets = await buildAssetPlan(spec, engine, selection.targets, includeMcp, selection.preset.paths.areas?.length ?? 0);
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

/** init-fiabilidad (DEV-05, `design.md` §8): la ruta absoluta va a stderr, fuera del JSON del plan y del hash. */
export function destinationLine(root: string): string {
  return `ai-hub: destino ${root}`;
}

/** init-fiabilidad (DEV-01a): dos destinos explícitos distintos; ninguno se descarta en silencio. */
export function conflictMessage(target: Extract<InitRoot, { kind: 'conflict' }>): string {
  return `init: dos destinos explícitos distintos: --dir → ${target.dir} y AI_HUB_DIR → ${target.env}. Quita AI_HUB_DIR o pasa la misma ruta a --dir; no se escribió nada`;
}

/** init-fiabilidad (DEV-02): un ancestro con manifest.yaml nunca se adopta por su cuenta. */
export function ancestorMessage(target: Extract<InitRoot, { kind: 'ancestor' }>): string {
  return `init: ${target.cwd} no tiene instalación, pero el ancestro ${target.ancestor} tiene manifest.yaml. init no escribe en un ancestro por su cuenta: elige con --dir (--dir . para ${target.cwd} o --dir ${target.ancestor} para el ancestro); no se escribió nada`;
}

/**
 * Raíz efectiva de `init` (init-fiabilidad, DEV-00…02): sustituye el walk-up de `resolveAiHubDir`, que sigue
 * valiendo para el resto de comandos. Devuelve el contexto con esa raíz o el código de salida.
 */
export function initTarget(
  args: ParsedArgs,
  ctx: CliContext,
): { ctx: CliContext; target: Exclude<InitRoot, { kind: 'conflict' }> } | { code: number } {
  if (args.flags.dir === true) {
    ctx.io.err('init: --dir necesita una ruta (--dir <ruta>); no se escribió nada');
    return { code: 2 };
  }
  const target = resolveInitRoot(ctx.cwd, { dir: flagString(args, 'dir') ?? undefined, env: process.env.AI_HUB_DIR });
  if (target.kind === 'conflict') {
    ctx.io.err(conflictMessage(target));
    return { code: 2 };
  }
  if (target.kind === 'ancestor') {
    return { ctx, target };
  }
  const sameRoot = path.resolve(target.root) === path.resolve(ctx.root);
  return { ctx: { ...ctx, root: target.root, source: sameRoot ? ctx.source : null }, target };
}

/** Entradas de la raíz que `init` escribe o puede escribir (medidas con `init --yes`, más Spec Kit, backlog y snapshots). */
export const INIT_WRITE_NAMES = [
  '.ai-hub',
  '.ai-hubrc.json',
  '.backups',
  '.claude',
  '.cursor',
  '.github',
  '.gitignore',
  '.mcp.json',
  '.opencode',
  '.pi',
  '.specify',
  '.vscode',
  'AGENTS.md',
  'IDEA.md',
  'backlog',
  'manifest.yaml',
  'opencode.json',
  'specs',
  'sync.lock.json',
] as const;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Enlaces (symlink o junction) bajo las rutas que escribe `init` que resuelven fuera de la raíz real. */
async function escapingLinks(realRoot: string): Promise<Array<{ link: string; target: string }>> {
  const found: Array<{ link: string; target: string }> = [];
  const check = async (entry: string): Promise<boolean> => {
    const stat = await fs.lstat(entry).catch(() => null);
    if (stat === null || !stat.isSymbolicLink()) {
      return false;
    }
    const target = await fs.realpath(entry).catch(async () => path.resolve(path.dirname(entry), await fs.readlink(entry)));
    if (!inside(realRoot, target)) {
      found.push({ link: entry, target });
    }
    return true;
  };
  for (const name of INIT_WRITE_NAMES) {
    const entry = path.join(realRoot, name);
    if (await check(entry)) {
      continue;
    }
    const stat = await fs.stat(entry).catch(() => null);
    if (stat?.isDirectory()) {
      for (const child of await fs.readdir(entry, { recursive: true, withFileTypes: true }).catch(() => [])) {
        if (child.isSymbolicLink()) {
          await check(path.join(child.parentPath, child.name));
        }
      }
    }
  }
  return found;
}

/**
 * init-fiabilidad (DEV-03): el destino existe, es un directorio y, si se va a escribir, admite escrituras y ninguna
 * ruta que `init` escribe sale de su ruta real. Nunca crea la raíz. Devuelve la raíz real o el código de salida.
 */
export type WriteProbe = (dir: string) => Promise<void>;

/** Sonda de escritura: crea y borra un archivo con nombre aleatorio (un `EEXIST` nunca se confunde con «no escribible»). */
export const defaultWriteProbe: WriteProbe = async (dir) => {
  const probe = path.join(dir, `.ai-hub-write-probe-${process.pid}-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(probe, '', { flag: 'wx' });
  await fs.rm(probe, { force: true });
};

export async function validateInitTarget(
  root: string,
  writing: boolean,
  io: CliContext['io'],
  writeProbe: WriteProbe = defaultWriteProbe,
): Promise<{ root: string } | { code: number }> {
  const stat = await fs.stat(root).catch(() => null);
  if (stat === null) {
    io.err(`init: el destino ${root} no existe; créalo o elige otro con --dir (init no crea la raíz); no se escribió nada`);
    return { code: 2 };
  }
  if (!stat.isDirectory()) {
    io.err(`init: el destino ${root} no es un directorio; elige otro con --dir; no se escribió nada`);
    return { code: 2 };
  }
  const real = await fs.realpath(root);
  if (!writing) {
    return { root: real };
  }
  try {
    await writeProbe(real);
  } catch (error) {
    io.err(`init: el destino ${real} no admite escritura (${(error as NodeJS.ErrnoException).code ?? 'error'}); no se escribió nada`);
    return { code: 2 };
  }
  const escapes = await escapingLinks(real);
  if (escapes.length > 0) {
    for (const { link, target } of escapes) {
      io.err(`init: ${link} apunta fuera de la raíz (${target}); init no escribe fuera de ${real}; no se escribió nada`);
    }
    return { code: 2 };
  }
  return { root: real };
}

/** init-fiabilidad (DEV-06): lo que falta de la instalación base en `root` (manifiesto, directorio del arnés, lock). */
export async function missingBase(root: string): Promise<string[]> {
  const missing: string[] = [];
  if (!(await exists(path.join(root, 'manifest.yaml')))) {
    missing.push('manifest.yaml');
  }
  if (!(await fs.stat(path.join(root, '.ai-hub')).then((stat) => stat.isDirectory(), () => false))) {
    missing.push('.ai-hub/');
  }
  if (!(await exists(path.join(root, 'sync.lock.json')))) {
    missing.push('sync.lock.json');
  }
  return missing;
}

/** init-fiabilidad (DEV-05, DEV-06): última línea de la base, solo tras verificarla. */
export function installedLine(root: string): string {
  return `init: instalado en ${root}`;
}

/** Ganchos internos del asistente: la idea ya capturada y los pasos opcionales que corren tras la base. */
export interface InitHooks {
  idea?: IdeaOutcome | null;
  /** Integraciones opcionales tras verificar la base; devuelve un informe por integración ofrecida (IO-02). */
  afterBase?: (ctx: CliContext) => Promise<IntegrationReport[]>;
}

export async function cmdInit(args: ParsedArgs, initialCtx: CliContext, hooks: InitHooks = {}): Promise<number> {
  if (args.flags['discord-token'] !== undefined) {
    initialCtx.io.err(TOKEN_FLAG_REFUSED);
    return 2;
  }
  const resolvedTarget = initTarget(args, initialCtx);
  if ('code' in resolvedTarget) {
    return resolvedTarget.code;
  }
  const { target } = resolvedTarget;
  let ctx = resolvedTarget.ctx;
  if (target.kind === 'ancestor') {
    // DEV-02: en interactivo se pregunta (nunca en el checkout del motor); con --yes o sin TTY, salida 2.
    if (isInteractiveRequest(args, ctx) && !(await isEngineCheckout(target.ancestor))) {
      return runAssistantInit({ ...ctx, root: target.cwd }, { ancestor: target });
    }
    ctx.io.err(ancestorMessage(target));
    return 2;
  }
  const writing = Boolean(args.flags.yes) && !args.flags['dry-run'];
  const validated = await validateInitTarget(ctx.root, writing, ctx.io, ctx.writeProbe);
  if ('code' in validated) {
    return validated.code;
  }
  ctx = { ...ctx, root: validated.root };
  if (target.ancestor !== null) {
    ctx.io.err(`ai-hub: aviso: ${target.ancestor} (ancestro de ${ctx.root}) ya tiene una instalación; init escribe solo en ${ctx.root}`);
  }
  if (!isInteractiveRequest(args, ctx)) {
    ctx.io.err(destinationLine(ctx.root));
  }
  // init-fiabilidad (CO-07): los argumentos de --connect-hermes se validan antes de escribir nada, y el token se
  // lee de la entrada estándar también antes del apply (vacío = salida 2 sin escribir).
  let connectToken: string | undefined;
  if (args.flags['webhook-owner'] !== undefined && !args.flags['connect-hermes']) {
    // webhook-operativo (design §D9): el consentimiento del dueño del listener solo tiene sentido al conectar.
    ctx.io.err(`--webhook-owner solo se admite junto a --connect-hermes\n${CONNECT_USAGE}`);
    return 2;
  }
  if (args.flags['connect-hermes'] && !args.flags['dry-run']) {
    const invalid = validateConnectFlags(args.flags);
    if (invalid !== null) {
      ctx.io.err(invalid);
      return 2;
    }
    if (args.flags.yes) {
      connectToken = (await (ctx.stdin ?? readStdin)()).trim();
      if (connectToken === '') {
        ctx.io.err('--discord-token-stdin: la entrada estándar está vacía; no se escribió nada');
        return 2;
      }
    }
  }
  const sourceCheckout = await isEngineCheckout(ctx.root);
  // Gate del asistente (design D3): sólo instalación, sólo TTY, sólo sin flags.
  // Ni una línea del asistente corre antes de esta comprobación (R2).
  if (!sourceCheckout && isInteractiveRequest(args, ctx)) {
    return runAssistantInit(ctx);
  }
  // idea-input (R12, D3): la idea por flags se lee y valida antes de cualquier escritura; nunca entra al plan.
  let idea: IdeaOutcome | null = null;
  try {
    const resolved = await resolveIdeaFromFlags(args.flags, {
      cwd: ctx.cwd,
      env: process.env,
      stdin: ctx.ideaStdin ?? processIdeaStdin(),
      editor: (maxBytes) => ideaFromEditor(ctx.editorHost ?? realEditorHost(ctx.root), maxBytes),
    });
    idea = hooks.idea !== undefined ? hooks.idea : resolved.outcome;
    if (resolved.notice !== null) {
      ctx.io.err(resolved.notice);
    }
  } catch (error) {
    if (error instanceof IdeaCancelled) {
      ctx.io.out('init cancelado; no se escribió nada');
      return 0;
    }
    if (error instanceof IdeaInputError) {
      ctx.io.err(error.message);
      return 2;
    }
    throw error;
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
    if (idea !== null) {
      // Fuera del JSON del plan (stdout): una línea en stderr, sin el texto (D12).
      ctx.io.err(describeIdea(idea));
    }
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
  await materializeHarnessLocal(ctx.root);
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
  // Campos opcionales del proyecto: re-ejecutar init no los pierde.
  if (prepared.existing?.tracker) {
    manifest.tracker = prepared.existing.tracker;
  }
  if (prepared.existing?.agentsMd !== undefined) {
    manifest.agentsMd = prepared.existing.agentsMd;
  }
  if (prepared.existing?.agentModels) {
    manifest.agentModels = prepared.existing.agentModels;
  }
  if (prepared.existing?.agentMemory) {
    manifest.agentMemory = prepared.existing.agentMemory;
  }
  if (prepared.existing?.control) {
    manifest.control = prepared.existing.control;
  }
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
  const existingRc = readAiHubRc(ctx.root);
  if (!existingRc || existingRc.version === 1 || args.flags.force) {
    writeAiHubRc(ctx.root, prepared.rc);
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
  await ensureProjectIgnores(ctx.root, manifest.agentMemory);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `init: ${prepared.selection.preset.id} · skills=${prepared.spec.modes.skills} agents=${prepared.spec.modes.agents} rules=${prepared.spec.modes.rules} · ${prepared.spec.skills.length} skills de proyecto + ${prepared.engine.commands.length} comandos Spec Kit · ${prepared.spec.agents.length} agentes · ${prepared.spec.rules.length + 1} reglas · ${prepared.assets.destinations} destinos · ${sync.written.length} sincronizados · ${materialized.written.length} nuevos, ${materialized.kept.length} conservados${materialized.updated.length > 0 ? `, ${materialized.updated.length} actualizados` : ''}, ${materialized.collisions.length} colisiones`,
  );
  if (materialized.collisions.length > 0) {
    ctx.io.err(`colisiones (no se sobrescribieron): ${materialized.collisions.join(', ')}`);
  }
  ctx.io.out(speckitSummary(prepared.speckitSettings, resolved));
  ctx.io.out(`plan: ${plan.hash}`);
  // idea-input (R12): la semilla se escribe solo tras el apply; antes de la conexión del plano de control.
  if (idea?.kind === 'idea') {
    // init-fiabilidad (SEED-03): si la idea no se puede guardar, la base falla (el arnés queda aplicado).
    let lines: string[];
    try {
      lines = await writeBacklogSeed(ctx, idea.text, idea.note);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      const file = failure.path ? path.relative(ctx.root, failure.path).split(path.sep).join('/') : 'backlog/';
      ctx.io.err(`init: no se pudo escribir ${file} (${failure.code ?? failure.message}); el arnés sigue aplicado en ${ctx.root}, pero la idea no se guardó; no se ofrece ninguna integración`);
      return 1;
    }
    for (const line of lines) {
      ctx.io.out(line);
    }
  }
  // init-fiabilidad (DEV-06): «instalado» solo tras comprobar la base; las integraciones opcionales, después.
  if (!sourceCheckout) {
    const missing = await missingBase(ctx.root);
    if (missing.length > 0) {
      ctx.io.err(`init: la instalación base no está completa en ${ctx.root}: falta ${missing.join(', ')}; no se ofrece ninguna integración`);
      return 1;
    }
  }
  ctx.io.out(installedLine(ctx.root));
  // init-fiabilidad (IO-01, DEV-08): con la base verificada, las integraciones opcionales nunca cambian el código de
  // salida; terminan en una línea de estado por integración (P-01: 0 también con --yes --connect-hermes).
  let reports: IntegrationReport[] = [];
  if (hooks.afterBase !== undefined) {
    reports = await hooks.afterBase(ctx);
  } else if (args.flags['connect-hermes']) {
    // control-onboarding (D7): conexión explícita sin preguntas, después del init aplicado; el plan no cambia.
    // Una excepción no prevista (o una interrupción simulada) se informa en la etapa en curso y con la acción que
    // corresponde a lo persistido (HC-12): antes del punto de guardado, retomar la conexión; después, enroll.
    const NEXT: Record<string, string> = {
      profile: 'identity',
      'identity-before-backup': 'identity',
      'identity-backup': 'identity',
      'identity-block': 'env',
      env: 'manifest',
      manifest: 'skill',
    };
    let stage = 'profile';
    const staged: CliContext = {
      ...ctx,
      onConnectStage: async (done) => {
        stage = NEXT[done] ?? stage;
        await ctx.onConnectStage?.(done);
      },
    };
    const report = await isolate(
      'control',
      () => stage,
      async () => (await connectFromFlagsReport(args.flags, staged, idea?.kind === 'idea' ? idea.text : null, connectToken)).report,
    );
    if (report !== null && report.state === 'fallida' && report.action === null) {
      const saved = await connectionSaved(ctx.root, contextHost(ctx));
      report.action = saved ? ENROLL_ACTION : RETAKE_ACTION;
      if (!saved) {
        report.provide = RETAKE_PROVIDE;
      }
    }
    reports = report === null ? [] : [report];
  }
  printReports(ctx.io, reports);
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
    // Tolerante a activos ausentes restaurables (F-01): install/repair autorreparan desde el
    // catálogo del motor. Los ids desconocidos siguen fallando aquí, antes de escribir.
    context = await loadManifestContext(ctx.root, { assets: 'tolerant' });
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
    const assets = await buildAssetPlan(spec, context.engine, context.manifest.targets, includeMcp, context.manifest.paths.areas?.length ?? 0);
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
  await materializeHarnessLocal(ctx.root);
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
  // Revalidación estricta (D3): tras materializar, el manifiesto nuevo debe pasar la misma
  // validación que doctor/list/sync. Si el catálogo no restauró algún activo, el arnés
  // incompleto no se escribe ni se proyecta a los destinos.
  try {
    await validateManifestData(next, ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
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
  await ensureProjectIgnores(ctx.root, next.agentMemory);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `install: skills=${spec.modes.skills} agents=${spec.modes.agents} rules=${spec.modes.rules} · ${spec.skills.length} skills de proyecto + ${context.engine.commands.length} comandos Spec Kit · ${spec.agents.length} agentes · ${spec.rules.length + 1} reglas · ${materialized.written.length} nuevos · ${materialized.kept.length} conservados${materialized.updated.length > 0 ? ` · ${materialized.updated.length} actualizados` : ''} · ${sync.written.length} sincronizados`,
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
