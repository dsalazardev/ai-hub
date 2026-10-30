import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { rangeBounds } from '../speckit/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(__dirname, '..', '..', 'engine', 'engine.yaml');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'engine.schema.json');
export const ENGINE_SKILLS_DIR = path.join(__dirname, '..', '..', 'skills', 'shared');

export const ENGINE_COUNTS = { roles: 9, commands: 17, labels: 7 } as const;
export const ENGINE_LANES = { assessment: 5, feature: 9, bug: 3 } as const;

export type Lane = keyof typeof ENGINE_LANES;

export interface EngineRole {
  id: string;
  canonical: string;
  derived: boolean;
  read_only?: boolean;
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
  /** Id canónico del comando en Spec Kit, en notación con punto (`speckit.bug.assess`). */
  speckit: string;
}

export type SpeckitScript = 'sh' | 'ps';

/** Dependencia de Spec Kit declarada por el paquete; un proyecto solo puede restringirla. */
export interface EngineSpeckit {
  package: string;
  /** Rango soportado; única fuente de versión: la resolución toma la última estable dentro de él. */
  supported: string;
  script: SpeckitScript;
  extensions: Record<string, string>;
}

/** Extensiones de Spec Kit que proveen los 8 comandos de assessment y bug fix. */
export const REQUIRED_SPECKIT_EXTENSIONS = ['assess', 'bug'] as const;

export interface EngineManifest {
  version: 2;
  roles: EngineRole[];
  commands: EngineCommand[];
  /** Efecto de cada estado de salida sobre las etiquetas; tabla única proyectada en la regla de enlace. */
  exit_effects: Record<string, string>;
  labels: string[];
  targets: string[];
  speckit: EngineSpeckit;
}

/** Estados de salida que el vocabulario normalizado de Spec Kit retiró. */
export const RETIRED_EXIT_STATES = ['ROOT_CAUSE', 'NEEDS_DATA', 'FIXED', 'RESOLVED', 'OPEN', 'DRAFT', 'READY'] as const;

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
  for (const role of engine.roles) {
    if (role.read_only === true && role.can_modify.length > 0) {
      errors.push(`roles "${role.id}" es read-only y no puede declarar can_modify`);
    }
  }
  for (const [lane, count] of Object.entries(ENGINE_LANES)) {
    const actual = engine.commands.filter((command) => command.lane === lane).length;
    if (actual !== count) {
      errors.push(`lane "${lane}" debe tener ${count} comandos (tiene ${actual})`);
    }
  }
  for (const id of findDuplicateIds(engine.commands.map((command) => command.speckit))) {
    errors.push(`id de Spec Kit duplicado: ${id}`);
  }
  const retired = new Set<string>(RETIRED_EXIT_STATES);
  const states = new Set<string>();
  for (const command of engine.commands) {
    for (const state of command.exit) {
      states.add(state);
      if (retired.has(state)) {
        errors.push(`commands "${command.id}".exit usa el estado retirado ${state}`);
      }
    }
  }
  const effects = engine.exit_effects ?? {};
  for (const state of [...states].sort()) {
    if (!(state in effects)) {
      errors.push(`exit_effects no define el efecto de ${state}`);
    }
  }
  for (const state of Object.keys(effects).sort()) {
    if (!states.has(state)) {
      errors.push(`exit_effects.${state} no corresponde a ningún estado de salida`);
    }
  }
  errors.push(...validateEngineSpeckit(engine.speckit));
  return errors;
}

/** Campos que el bloque `speckit` del motor admite; cualquier otro (un pin exacto, una fecha de resolución) está retirado o es desconocido. */
const ENGINE_SPECKIT_FIELDS = ['package', 'supported', 'script', 'extensions'] as const;

function validateEngineSpeckit(speckit: EngineSpeckit | undefined): string[] {
  if (speckit === undefined) {
    return ['falta el bloque speckit'];
  }
  const errors: string[] = [];
  const record = speckit as unknown as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!(ENGINE_SPECKIT_FIELDS as readonly string[]).includes(field)) {
      errors.push(`speckit.${field} está retirado o no pertenece al motor; la versión se resuelve desde speckit.supported`);
    }
  }
  for (const field of ['package', 'supported', 'script'] as const) {
    if (typeof speckit[field] !== 'string' || speckit[field] === '') {
      errors.push(`falta speckit.${field}`);
    }
  }
  for (const extension of REQUIRED_SPECKIT_EXTENSIONS) {
    if (typeof speckit.extensions?.[extension] !== 'string') {
      errors.push(`falta speckit.extensions.${extension}`);
    }
  }
  if (typeof speckit.supported === 'string' && rangeBounds(speckit.supported) === null) {
    errors.push(`speckit.supported "${speckit.supported}" no es un rango válido (se esperaba ">=x.y.z <a.b.c")`);
  }
  return errors;
}

export function commandById(engine: EngineManifest, id: string): EngineCommand | null {
  return engine.commands.find((command) => command.id === id) ?? null;
}

export function commandsByLane(engine: EngineManifest, lane: Lane): EngineCommand[] {
  return engine.commands.filter((command) => command.lane === lane);
}
