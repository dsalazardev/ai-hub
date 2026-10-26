import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PACKAGE_NAME } from '../package-info.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { ENGINE_COUNTS, ENGINE_SKILLS_DIR, loadEngine, type EngineManifest } from '../engine/engine.js';
import { frontmatterString, splitFrontmatter } from '../frontmatter.js';
import { resolvePreset, type ResolvedPreset } from '../presets/resolve.js';
import type { PresetDangerPattern } from '../presets/schema.js';
import type { SelectionMode } from '../catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'manifest.schema.json');
const ENGINE_AGENTS = path.join(__dirname, '..', '..', 'agents');

export const MANIFEST_FILE = 'manifest.yaml';
export const INVENTORY_RELATIVE = 'core/manifest.json';
export { ENGINE_COUNTS };

export interface ProjectManifest {
  version: 2;
  project: { id: string; name: string };
  preset: { id: string; version: number; source: 'package' };
  stack: { languages: string[]; frontend?: string; backend?: string; packageManager?: string };
  commands: Record<string, string>;
  paths: { source: string[]; tests: string[]; docs: string[] };
  targets: string[];
  policy: {
    trunk: 'auto' | 'closed' | 'open';
    guardMode: 'shadow' | 'enforce';
    worktrees: boolean;
    optOuts: string[];
    dangerPatterns?: PresetDangerPattern[];
  };
  skills: { source: string; publish: string[]; selection?: SelectionMode };
  agents: { source: string; publish: string[]; selection?: SelectionMode };
  rules: { source: string; publish: string[]; selection?: SelectionMode };
  catalog?: { version: string; hash: string };
  mcp?: { source: string };
}

export class ManifestError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`manifiesto inválido:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    this.name = 'ManifestError';
    this.errors = errors;
  }
}

let validateFn: ReturnType<Ajv['compile']> | null = null;

async function validator(): Promise<ReturnType<Ajv['compile']>> {
  if (validateFn) {
    return validateFn;
  }
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true });
  validateFn = ajv.compile(schema);
  return validateFn;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function validateCatalogFile(file: string, errors: string[]): Promise<void> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    errors.push(`no se puede leer ${file}`);
    return;
  }
  try {
    const { data } = splitFrontmatter(text, file);
    frontmatterString(data, 'name', file);
    frontmatterString(data, 'description', file);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

export async function readManifestFile(root: string): Promise<unknown> {
  const file = path.join(root, MANIFEST_FILE);
  const raw = await fs.readFile(file, 'utf8').catch(() => {
    throw new ManifestError([`no se encuentra ${MANIFEST_FILE} en ${root}`]);
  });
  try {
    return parse(raw) as unknown;
  } catch (error) {
    throw new ManifestError([`${MANIFEST_FILE} no es YAML válido: ${(error as Error).message}`]);
  }
}

export interface LoadedManifest {
  manifest: ProjectManifest;
  engine: EngineManifest;
  preset: ResolvedPreset;
}

export async function loadManifest(root: string): Promise<ProjectManifest> {
  return (await loadManifestContext(root)).manifest;
}

export async function loadManifestContext(root: string): Promise<LoadedManifest> {
  return validateManifestData(await readManifestFile(root), root);
}

export async function validateManifestData(
  data: unknown,
  root: string = process.cwd(),
): Promise<LoadedManifest> {
  const validate = await validator();
  if (!validate(data)) {
    throw new ManifestError(
      (validate.errors ?? []).map((error) => {
        const params = error.params as Record<string, unknown>;
        const property =
          typeof params.additionalProperty === 'string' ? ` "${params.additionalProperty}"` : '';
        return `${error.instancePath || '(root)'}${property} ${error.message ?? 'inválido'}`;
      }),
    );
  }
  const manifest = data as ProjectManifest;
  const engine = await loadEngine();
  let preset: ResolvedPreset;
  try {
    preset = await resolvePreset(manifest.preset.id);
  } catch (error) {
    throw new ManifestError([(error as Error).message]);
  }
  if (preset.version !== manifest.preset.version) {
    throw new ManifestError([
      `preset.version ${manifest.preset.version} no coincide con la versión ${preset.version} de "${preset.id}"`,
    ]);
  }
  const errors: string[] = [];
  for (const target of manifest.targets) {
    if (!engine.targets.includes(target)) {
      errors.push(`targets "${target}" no existe en el motor`);
    }
  }
  const skillFiles = new Set<string>();
  for (const skill of manifest.skills.publish) {
    const file = path.join(root, manifest.skills.source, skill, 'SKILL.md');
    skillFiles.add(file);
    if (!(await exists(file))) {
      errors.push(`skills.publish "${skill}" no existe en ${manifest.skills.source}`);
    }
  }
  for (const skill of new Set(engine.commands.map((command) => command.skill))) {
    const file = path.join(ENGINE_SKILLS_DIR, skill, 'SKILL.md');
    skillFiles.add(file);
    if (!(await exists(file))) {
      errors.push(`skill del motor "${skill}" no existe en ${ENGINE_SKILLS_DIR}`);
    }
  }
  for (const file of skillFiles) {
    if (await exists(file)) {
      await validateCatalogFile(file, errors);
    }
  }
  for (const agent of manifest.agents.publish) {
    const projectFile = path.join(root, manifest.agents.source, `${agent}.md`);
    const engineFile = path.join(ENGINE_AGENTS, `${agent}.md`);
    const file = (await exists(projectFile))
      ? projectFile
      : (await exists(engineFile))
        ? engineFile
        : null;
    if (file === null) {
      errors.push(`agents.publish "${agent}" no existe en ${manifest.agents.source} ni en el motor`);
      continue;
    }
    await validateCatalogFile(file, errors);
  }
  for (const rule of manifest.rules.publish) {
    const file = path.join(root, manifest.rules.source, `${rule}.md`);
    if (!(await exists(file))) {
      errors.push(`rules.publish "${rule}" no existe en ${manifest.rules.source}`);
    }
  }
  if (manifest.mcp && !(await exists(path.join(root, manifest.mcp.source)))) {
    const projectMcp = path.join(root, '.ai-hub', path.basename(manifest.mcp.source));
    if (!(await exists(projectMcp))) {
      errors.push(`mcp.source "${manifest.mcp.source}" no existe`);
    }
  }
  if (errors.length > 0) {
    throw new ManifestError(errors);
  }
  return { manifest, engine, preset };
}

export function inventoryPath(root: string): string {
  // En el checkout del motor el inventario vive en core/ porque ese es el paquete que se publica.
  // En un proyecto consumidor pertenece a .ai-hub/, junto al arnes instalado.
  const engineMarker = path.join(root, 'core', 'src', 'paths.ts');
  return existsSync(engineMarker)
    ? path.join(root, INVENTORY_RELATIVE)
    : path.join(root, '.ai-hub', 'manifest.json');
}

export interface ManifestInventory {
  version: 2;
  generatedBy: string;
  project: { id: string; name: string };
  preset: { id: string; version: number };
  engine: { roles: number; commands: number; labels: number };
  roles: string[];
  commands: Array<{ id: string; lane: string; role: string; skill: string }>;
  labels: string[];
  targets: string[];
  selection?: { skills: SelectionMode; agents: SelectionMode; rules: SelectionMode };
  catalog?: { version: string; hash: string } | null;
  agents: string[];
  skills: string[];
  rules: string[];
  counts: {
    roles: number;
    commands: number;
    labels: number;
    targets: number;
    agents: number;
    skills: number;
    rules: number;
  };
}

export function buildInventory(manifest: ProjectManifest, engine: EngineManifest): ManifestInventory {
  const roles = engine.roles.map((role) => role.id).sort();
  const commands = [...engine.commands]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((command) => ({ id: command.id, lane: command.lane, role: command.role, skill: command.skill }));
  const labels = [...engine.labels].sort();
  const skills = [...new Set([...engine.commands.map((command) => command.skill), ...manifest.skills.publish])].sort();
  const agents = [...manifest.agents.publish].sort();
  const rules = [...manifest.rules.publish].sort();
  return {
    version: 2,
    generatedBy: PACKAGE_NAME,
    project: manifest.project,
    preset: { id: manifest.preset.id, version: manifest.preset.version },
    engine: { roles: engine.roles.length, commands: engine.commands.length, labels: engine.labels.length },
    roles,
    commands,
    labels,
    targets: [...manifest.targets].sort(),
    ...(manifest.skills.selection !== undefined ||
    manifest.agents.selection !== undefined ||
    manifest.rules.selection !== undefined
      ? {
          selection: {
            skills: manifest.skills.selection ?? 'preset',
            agents: manifest.agents.selection ?? 'preset',
            rules: manifest.rules.selection ?? 'preset',
          },
        }
      : {}),
    ...(manifest.catalog !== undefined ? { catalog: manifest.catalog } : {}),
    agents,
    skills,
    rules,
    counts: {
      roles: roles.length,
      commands: commands.length,
      labels: labels.length,
      targets: manifest.targets.length,
      agents: agents.length,
      skills: skills.length,
      rules: rules.length,
    },
  };
}

export function serializeInventory(inventory: ManifestInventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export async function writeInventory(root: string): Promise<ManifestInventory> {
  const { manifest, engine } = await loadManifestContext(root);
  const inventory = buildInventory(manifest, engine);
  const file = inventoryPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeInventory(inventory), 'utf8');
  return inventory;
}

export async function checkInventory(
  root: string,
): Promise<{ ok: boolean; expected: string; actual: string | null }> {
  const { manifest, engine } = await loadManifestContext(root);
  const expected = serializeInventory(buildInventory(manifest, engine));
  const actual = await fs.readFile(inventoryPath(root), 'utf8').catch(() => null);
  return { ok: actual === expected, expected, actual };
}
