import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'schema', 'state.schema.json');
export const STATE_RELATIVE = '.planning/state.json';
export const LEGACY_PATHS_FILE = path.join(__dirname, '..', '..', '..', 'engine', 'legacy-paths.json');

export type Lane = 'assessment' | 'feature' | 'bug';

export interface ProjectState {
  version: 1;
  project: string;
  preset: string;
  activeChange: string | null;
  lane: Lane | null;
  phase: string;
  tasks: { total: number; done: number };
  branch: string | null;
  worktree: string | null;
  updatedAt: string;
}

export class StateNotFoundError extends Error {
  constructor(statePath: string) {
    super(`state.json no encontrado: ${statePath}. Ejecuta ai-hub init`);
    this.name = 'StateNotFoundError';
  }
}

export class StateSchemaError extends Error {
  readonly validationErrors: string[];
  constructor(errors: string[]) {
    super(`state.json no es válido:\n${errors.join('\n')}`);
    this.name = 'StateSchemaError';
    this.validationErrors = errors;
  }
}

let validateFn: ValidateFunction | null = null;

async function validator(): Promise<ValidateFunction> {
  if (validateFn) {
    return validateFn;
  }
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true });
  validateFn = ajv.compile(schema);
  return validateFn;
}

function describe(errors: ValidateFunction['errors']): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || '(root)'} ${error.message ?? 'inválido'}`,
  );
}

export function emptyState(project: string, preset: string): ProjectState {
  return {
    version: 1,
    project,
    preset,
    activeChange: null,
    lane: null,
    phase: 'idle',
    tasks: { total: 0, done: 0 },
    branch: null,
    worktree: null,
    updatedAt: new Date().toISOString(),
  };
}

export function statePath(root: string): string {
  return path.join(root, STATE_RELATIVE);
}

export async function readState(root: string): Promise<ProjectState> {
  const file = statePath(root);
  const raw = await fs.readFile(file, 'utf8').catch(() => {
    throw new StateNotFoundError(file);
  });
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new StateSchemaError([`(root) JSON inválido: ${(error as Error).message}`]);
  }
  const validate = await validator();
  if (!validate(data)) {
    throw new StateSchemaError(describe(validate.errors));
  }
  return data as ProjectState;
}

export async function writeState(root: string, state: ProjectState): Promise<void> {
  const validate = await validator();
  const next: ProjectState = { ...state, updatedAt: new Date().toISOString() };
  if (!validate(next)) {
    throw new StateSchemaError(describe(validate.errors));
  }
  const file = statePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export interface LegacyStatePaths {
  state: string;
  changes: string;
}

export async function legacyStatePaths(): Promise<LegacyStatePaths> {
  const raw = await fs.readFile(LEGACY_PATHS_FILE, 'utf8');
  const parsed = JSON.parse(raw) as Partial<LegacyStatePaths>;
  if (typeof parsed.state !== 'string' || typeof parsed.changes !== 'string') {
    throw new StateSchemaError(['legacy-paths.json no declara "state" y "changes"']);
  }
  return { state: parsed.state, changes: parsed.changes };
}

export async function migrateLegacyState(root: string, project: string, preset: string): Promise<ProjectState | null> {
  const paths = await legacyStatePaths();
  const raw = await fs.readFile(path.join(root, paths.state), 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  let legacy: Record<string, unknown>;
  try {
    legacy = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const activeChange = typeof legacy.active_change === 'string' ? legacy.active_change : null;
  const changes = Array.isArray(legacy.changes) ? (legacy.changes as Array<Record<string, unknown>>) : [];
  const active = activeChange ? changes.find((change) => change.name === activeChange) : null;
  const phase = active && typeof active.phase === 'string' ? active.phase : activeChange ? 'in-progress' : 'idle';
  let total = 0;
  let done = 0;
  if (activeChange) {
    const tasks = await fs.readFile(path.join(root, paths.changes, activeChange, 'tasks.md'), 'utf8').catch(() => '');
    total = tasks.split('\n').filter((line) => /^\s*-\s*\[[ x]\]/.test(line)).length;
    done = tasks.split('\n').filter((line) => /^\s*-\s*\[x\]/.test(line)).length;
  }
  const migrated: ProjectState = {
    ...emptyState(project, preset),
    activeChange,
    phase,
    tasks: { total, done },
  };
  await writeState(root, migrated);
  return migrated;
}
