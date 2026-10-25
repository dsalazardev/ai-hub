import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(__dirname, '..', '..', 'engine', 'engine.yaml');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'engine.schema.json');
export const ENGINE_SKILLS_DIR = path.join(__dirname, '..', '..', 'skills', 'shared');

export const ENGINE_COUNTS = { roles: 8, commands: 17, labels: 7 } as const;
export const ENGINE_LANES = { assessment: 5, feature: 9, bug: 3 } as const;

export type Lane = keyof typeof ENGINE_LANES;

export interface EngineRole {
  id: string;
  canonical: string;
  derived: boolean;
  description?: string;
  can_modify: string[];
  cannot_modify: string[];
  commands: string[];
  gate: string;
}

export interface EngineCommand {
  id: string;
  name: string;
  lane: Lane;
  artifacts: string[];
  exit: string[];
  role: string;
  co_roles?: string[];
  skill: string;
}

export interface EngineManifest {
  version: 2;
  roles: EngineRole[];
  commands: EngineCommand[];
  labels: string[];
  targets: string[];
}

export class EngineError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`motor inválido:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    this.name = 'EngineError';
    this.errors = errors;
  }
}

let cache: EngineManifest | null = null;

export async function loadEngine(): Promise<EngineManifest> {
  if (cache) {
    return cache;
  }
  const raw = await fs.readFile(ENGINE_PATH, 'utf8').catch(() => {
    throw new EngineError([`no se encuentra ${ENGINE_PATH}`]);
  });
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    throw new EngineError([`engine.yaml no es YAML válido: ${(error as Error).message}`]);
  }
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    throw new EngineError(
      (validate.errors ?? []).map(
        (error) => `${error.instancePath || '(root)'} ${error.message ?? 'inválido'}`,
      ),
    );
  }
  const engine = data as EngineManifest;
  const errors = crossValidate(engine);
  if (errors.length > 0) {
    throw new EngineError(errors);
  }
  cache = engine;
  return engine;
}

export function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return [...duplicates].sort();
}

export function crossValidate(engine: EngineManifest): string[] {
  const errors: string[] = [];
  if (engine.roles.length !== ENGINE_COUNTS.roles) {
    errors.push(`deben existir ${ENGINE_COUNTS.roles} roles`);
  }
  if (engine.commands.length !== ENGINE_COUNTS.commands) {
    errors.push(`deben existir ${ENGINE_COUNTS.commands} comandos`);
  }
  if (engine.labels.length !== ENGINE_COUNTS.labels) {
    errors.push(`deben existir ${ENGINE_COUNTS.labels} etiquetas`);
  }
  for (const id of findDuplicateIds(engine.roles.map((role) => role.id))) {
    errors.push(`rol duplicado: ${id}`);
  }
  for (const id of findDuplicateIds(engine.commands.map((command) => command.id))) {
    errors.push(`comando duplicado: ${id}`);
  }
  for (const label of findDuplicateIds(engine.labels)) {
    errors.push(`etiqueta duplicada: ${label}`);
  }
  const roleIds = new Set(engine.roles.map((role) => role.id));
  for (const command of engine.commands) {
    if (!roleIds.has(command.role)) {
      errors.push(`commands "${command.id}".role "${command.role}" no existe`);
    }
    for (const coRole of command.co_roles ?? []) {
      if (!roleIds.has(coRole)) {
        errors.push(`commands "${command.id}".co_roles "${coRole}" no existe`);
      }
    }
  }
  for (const role of engine.roles) {
    const expected = engine.commands
      .filter((command) => command.role === role.id || (command.co_roles ?? []).includes(role.id))
      .map((command) => command.id)
      .sort();
    const declared = [...role.commands].sort();
    if (JSON.stringify(expected) !== JSON.stringify(declared)) {
      errors.push(`roles "${role.id}".commands no coincide con los comandos asignados`);
    }
  }
  for (const [lane, count] of Object.entries(ENGINE_LANES)) {
    const actual = engine.commands.filter((command) => command.lane === lane).length;
    if (actual !== count) {
      errors.push(`lane "${lane}" debe tener ${count} comandos (tiene ${actual})`);
    }
  }
  return errors;
}

export function commandById(engine: EngineManifest, id: string): EngineCommand | null {
  return engine.commands.find((command) => command.id === id) ?? null;
}

export function commandsByLane(engine: EngineManifest, lane: Lane): EngineCommand[] {
  return engine.commands.filter((command) => command.lane === lane);
}
