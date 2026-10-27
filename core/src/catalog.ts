import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_SKILLS_DIR, type EngineManifest } from './engine/engine.js';
import { PACKAGE_VERSION } from './package-info.js';
import { sha256 } from './sync/lock.js';
import { splitFrontmatter } from './frontmatter.js';
import type { ProjectManifest } from './manifest/manifest.js';
import type { ResolvedPreset } from './presets/resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Directorio de agentes dentro del paquete (core/agents). */
export const ENGINE_AGENTS_DIR = path.join(__dirname, '..', 'agents');
/** Directorio de reglas universales dentro del paquete (core/rules). */
export const ENGINE_RULES_DIR = path.join(__dirname, '..', 'rules');

export const RUBRIC_RULE_IDS = [
  'skill-quality/skill-rubric',
  'skill-quality/skill-behavior-rubric',
  'skill-quality/skill-harden-rubric',
  'skill-quality/skill-migration-brief',
] as const;

export const BASELINE_RULE_IDS = ['core'] as const;
export const UNIVERSAL_RULE_IDS = [...BASELINE_RULE_IDS, ...RUBRIC_RULE_IDS] as const;
export const PREFLIGHT_RULE_ID = 'preflight';
export const UNIVERSAL_TARGET_RULE_IDS = [...UNIVERSAL_RULE_IDS, PREFLIGHT_RULE_ID] as const;

export type SelectionMode = 'full' | 'preset' | 'custom';

export interface SelectionScope {
  selection?: SelectionMode;
}

export interface CatalogIndex {
  skills: string[];
  /** Skills del paquete que declaran `runtime: false`: siguen publicadas pero no son instalables. */
  retiredSkills: string[];
  agents: string[];
  skillFiles: Record<string, string[]>;
  ruleFiles: Record<string, string[]>;
  walkCount: number;
}

let indexPromise: Promise<CatalogIndex> | null = null;
let walkCount = 0;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

/** `true` si el frontmatter de la skill declara `runtime: false` (no instalable). */
async function isRuntimeSkill(skillDir: string): Promise<boolean> {
  const text = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8').catch(() => null);
  if (text === null) {
    return true;
  }
  try {
    return splitFrontmatter(text, skillDir).data.runtime !== false;
  } catch {
    return true;
  }
}

/**
 * Índice de las skills instalables de un directorio de catálogo. Las skills con
 * `runtime: false` siguen en el paquete pero no se listan, materializan ni proyectan.
 */
export async function buildCatalogIndexFrom(
  skillsDir: string,
): Promise<Pick<CatalogIndex, 'skills' | 'skillFiles' | 'retiredSkills'>> {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skillFiles: Record<string, string[]> = {};
  const retiredSkills: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(skillsDir, entry.name);
    if (!(await isRuntimeSkill(dir))) {
      retiredSkills.push(entry.name);
      continue;
    }
    skillFiles[entry.name] = await walk(dir);
  }
  return { skills: Object.keys(skillFiles).sort(), skillFiles, retiredSkills: retiredSkills.sort() };
}

async function buildCatalogIndex(): Promise<CatalogIndex> {
  walkCount += 1;
  const { skillFiles, retiredSkills } = await buildCatalogIndexFrom(ENGINE_SKILLS_DIR);
  const ruleFiles: Record<string, string[]> = {};
  for (const id of RUBRIC_RULE_IDS) {
    const file = path.join(ENGINE_RULES_DIR, `${id}.md`);
    ruleFiles[id] = (await fs.access(file).then(() => true, () => false)) ? [file] : [];
  }
  const agentFiles = await walk(ENGINE_AGENTS_DIR);
  return {
    skills: Object.keys(skillFiles).sort(),
    agents: agentFiles
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.basename(file, '.md'))
      .sort(),
    retiredSkills,
    skillFiles,
    ruleFiles,
    walkCount,
  };
}

async function readIndexFile(file: string): Promise<CatalogIndex | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<CatalogIndex>;
    if (
      !Array.isArray(parsed.skills) ||
      !Array.isArray(parsed.agents) ||
      typeof parsed.skillFiles !== 'object' ||
      parsed.skillFiles === null ||
      typeof parsed.ruleFiles !== 'object' ||
      parsed.ruleFiles === null
    ) {
      return null;
    }
    return {
      skills: parsed.skills,
      retiredSkills: Array.isArray(parsed.retiredSkills) ? parsed.retiredSkills : [],
      agents: parsed.agents,
      skillFiles: parsed.skillFiles,
      ruleFiles: parsed.ruleFiles,
      walkCount: typeof parsed.walkCount === 'number' ? parsed.walkCount : 1,
    };
  } catch {
    return null;
  }
}

/**
 * Índice memoizado por proceso. En tests, `AI_HUB_CATALOG_INDEX_FILE` apunta al
 * índice que construye `globalSetup`, de modo que todos los workers comparten un
 * único barrido. En producción se construye desde el paquete en ejecución.
 */
export async function catalogIndex(): Promise<CatalogIndex> {
  if (indexPromise === null) {
    indexPromise = (async () => {
      const cacheFile = process.env.AI_HUB_CATALOG_INDEX_FILE;
      if (cacheFile !== undefined && cacheFile !== '') {
        const cached = await readIndexFile(cacheFile);
        if (cached !== null) {
          walkCount = Math.max(walkCount, cached.walkCount);
          return cached;
        }
      }
      return buildCatalogIndex();
    })();
  }
  return indexPromise;
}

/** Reconstruye el índice ignorando la caché de archivo; lo usa el globalSetup. */
export async function rebuildCatalogIndex(): Promise<CatalogIndex> {
  indexPromise = buildCatalogIndex();
  return indexPromise;
}

export function catalogWalkCount(): number {
  return walkCount;
}

export function resetCatalogIndex(): void {
  indexPromise = null;
  walkCount = 0;
}

/** Skills instalables del catálogo; los 17 comandos los provee Spec Kit, no el catálogo. */
export async function listCatalogSkills(engine: EngineManifest): Promise<string[]> {
  void engine;
  return (await catalogIndex()).skills;
}

/** Agentes de catálogo publicados en el paquete. */
export async function listCatalogAgents(): Promise<string[]> {
  return (await catalogIndex()).agents;
}

/** Archivos de una skill del catálogo. */
export async function catalogSkillFiles(id: string): Promise<string[]> {
  return (await catalogIndex()).skillFiles[id] ?? [];
}

/** Archivos de una rúbrica universal. */
export async function universalRuleFiles(id: string): Promise<string[]> {
  return (await catalogIndex()).ruleFiles[id] ?? [];
}

export function normalizeRuleId(rule: string): string {
  return rule
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^rules\//, '')
    .replace(/\.md$/i, '');
}

export function presetRuleIds(preset: ResolvedPreset): string[] {
  return [...new Set(preset.rules.map(normalizeRuleId))].sort();
}

export function expectedRuleIds(mode: SelectionMode, preset: ResolvedPreset): string[] {
  if (mode === 'preset') {
    return presetRuleIds(preset);
  }
  return [...new Set([...UNIVERSAL_RULE_IDS, ...presetRuleIds(preset)])].sort();
}

export function selectionMode(scope: SelectionScope | undefined): SelectionMode {
  return scope?.selection ?? 'preset';
}

export function sameSelection(left: SelectionMode, right: SelectionMode): boolean {
  return left === right;
}

export function hasFullDimension(manifest: ProjectManifest): boolean {
  return (
    selectionMode(manifest.skills) === 'full' ||
    selectionMode(manifest.agents) === 'full' ||
    selectionMode(manifest.rules) === 'full'
  );
}

export function catalogHash(manifest: ProjectManifest): string {
  const payload: Record<string, string[]> = {};
  if (selectionMode(manifest.skills) === 'full') {
    payload.skills = [...manifest.skills.publish].sort();
  }
  if (selectionMode(manifest.agents) === 'full') {
    payload.agents = [...manifest.agents.publish].sort();
  }
  if (selectionMode(manifest.rules) === 'full') {
    payload.rules = [...manifest.rules.publish].sort();
  }
  return sha256(JSON.stringify(payload));
}

export function catalogSeal(manifest: ProjectManifest): { version: string; hash: string } {
  return { version: PACKAGE_VERSION, hash: catalogHash(manifest) };
}

export function expectedSkills(
  mode: SelectionMode,
  preset: ResolvedPreset,
  engine: EngineManifest,
  catalog: string[],
): string[] | null {
  if (mode === 'full') {
    return [...catalog].sort();
  }
  if (mode === 'preset') {
    return [...preset.skills].sort();
  }
  void engine;
  return null;
}

export function expectedAgents(
  mode: SelectionMode,
  preset: ResolvedPreset,
  catalog: string[],
): string[] | null {
  if (mode === 'full') {
    return [...catalog].sort();
  }
  if (mode === 'preset') {
    return [...preset.agents].sort();
  }
  return null;
}

export function expectedRulesFor(
  mode: SelectionMode,
  preset: ResolvedPreset,
): string[] | null {
  if (mode === 'custom') {
    return null;
  }
  return expectedRuleIds(mode, preset);
}

export function difference(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((id) => !actualSet.has(id)).sort(),
    extra: actual.filter((id) => !expectedSet.has(id)).sort(),
  };
}

export interface SelectionAudit {
  mode: SelectionMode;
  modes: { skills: SelectionMode; agents: SelectionMode; rules: SelectionMode };
  expectedSkills: string[] | null;
  expectedAgents: string[] | null;
  expectedRules: string[] | null;
  missing: string[];
  extra: string[];
  errors: string[];
  warnings: string[];
  newAssets: number;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function auditSelection(
  root: string,
  manifest: ProjectManifest,
  preset: ResolvedPreset,
  engine: EngineManifest,
): Promise<SelectionAudit> {
  const modes = {
    skills: selectionMode(manifest.skills),
    agents: selectionMode(manifest.agents),
    rules: selectionMode(manifest.rules),
  };
  const mode: SelectionMode =
    modes.skills === modes.agents && modes.agents === modes.rules ? modes.skills : 'custom';
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  const catalogSkills = await listCatalogSkills(engine);
  const catalogAgents = await listCatalogAgents();
  const expectedSkills = expectedSkillsFor(modes.skills, preset, engine, catalogSkills);
  const expectedAgents = expectedAgentsFor(modes.agents, preset, catalogAgents);
  const expectedRules = expectedRulesFor(modes.rules, preset);
  let newAssets = 0;

  const compare = (
    dimension: 'skill' | 'agent' | 'rule',
    expected: string[] | null,
    actual: string[],
  ): void => {
    if (expected === null) {
      return;
    }
    const diff = difference(expected, actual);
    missing.push(...diff.missing.map((id) => `${dimension}:${id}`));
    extra.push(...diff.extra.map((id) => `${dimension}:${id}`));
    if (diff.missing.length > 0) {
      errors.push(`${dimension}s.publish incompleto: faltan ${diff.missing.join(', ')}`);
    }
    if (diff.extra.length > 0) {
      errors.push(`${dimension}s.publish contiene ids fuera de la selección: ${diff.extra.join(', ')}`);
    }
  };

  compare('skill', expectedSkills, manifest.skills.publish);
  compare('agent', expectedAgents, manifest.agents.publish);
  compare('rule', expectedRules, manifest.rules.publish);

  const anyFull = Object.values(modes).includes('full');
  if (anyFull) {
    if (manifest.catalog === undefined) {
      errors.push('selección full sin catalog.version/catalog.hash; ejecuta install --full o init');
    } else {
      const currentHash = catalogHash(manifest);
      if (currentHash !== manifest.catalog.hash) {
        errors.push('full incompleto: publish editado; ejecuta install --full o restaura el manifest');
      } else if (manifest.catalog.version !== PACKAGE_VERSION) {
        const expectedFull = [
          ...(modes.skills === 'full' ? (expectedSkills ?? []) : []),
          ...(modes.agents === 'full' ? (expectedAgents ?? []) : []),
          ...(modes.rules === 'full' ? (expectedRules ?? []) : []),
        ];
        const actualFull = [
          ...(modes.skills === 'full' ? manifest.skills.publish : []),
          ...(modes.agents === 'full' ? manifest.agents.publish : []),
          ...(modes.rules === 'full' ? manifest.rules.publish : []),
        ];
        newAssets = difference(expectedFull, actualFull).missing.length;
        warnings.push(`full desactualizado: ${newAssets} activos nuevos; ejecuta upgrade`);
      }
    }
  }

  for (const skill of manifest.skills.publish) {
    const file = path.join(root, manifest.skills.source, skill, 'SKILL.md');
    if (!(await fileExists(file))) {
      missing.push(`skill:${skill}`);
      errors.push(`skills.publish "${skill}" no existe en ${manifest.skills.source}`);
    }
  }
  for (const agent of manifest.agents.publish) {
    const file = path.join(root, manifest.agents.source, `${agent}.md`);
    if (!(await fileExists(file))) {
      missing.push(`agent:${agent}`);
      errors.push(`agents.publish "${agent}" no existe en ${manifest.agents.source}`);
    }
  }
  for (const rule of manifest.rules.publish) {
    const file = path.join(root, manifest.rules.source, `${rule}.md`);
    if (!(await fileExists(file))) {
      missing.push(`rule:${rule}`);
      errors.push(`rules.publish "${rule}" no existe en ${manifest.rules.source}`);
    }
  }

  return {
    mode,
    modes,
    expectedSkills,
    expectedAgents,
    expectedRules,
    missing: [...new Set(missing)].sort(),
    extra: [...new Set(extra)].sort(),
    errors,
    warnings,
    newAssets,
  };
}

// Nombres internos para evitar colisión con las funciones exportadas de expectativas.
function expectedSkillsFor(
  mode: SelectionMode,
  preset: ResolvedPreset,
  engine: EngineManifest,
  catalog: string[],
): string[] | null {
  return expectedSkills(mode, preset, engine, catalog);
}

function expectedAgentsFor(
  mode: SelectionMode,
  preset: ResolvedPreset,
  catalog: string[],
): string[] | null {
  return expectedAgents(mode, preset, catalog);
}
