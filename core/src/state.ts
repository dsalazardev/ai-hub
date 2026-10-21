import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction, type ErrorObject } from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'state.schema.json');
const STATE_RELATIVE = 'openspec/state.json';

export interface ChangeEntry {
  id: number;
  name: string;
  phase: string;
  title?: string;
  scope?: string[];
  spec_path?: string;
  created_at?: string;
  archived_at?: string;
  retry_count?: number;
  notes?: string;
}

export interface StateRules {
  one_change_at_a_time?: boolean;
  require_human_approval_before_implement?: boolean;
  max_implementer_retries?: number;
  require_ears_notation?: boolean;
  require_rn_traceability?: boolean;
  valid_phases?: string[];
}

export interface StateV3 {
  version: 3;
  project?: string;
  updated_at?: string;
  active_change: string | null;
  rules?: StateRules;
  changes: ChangeEntry[];
}

export class StateNotFoundError extends Error {
  constructor(statePath: string) {
    super(`state.json no encontrado: ${statePath}. Ejecuta: openspec init`);
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

let _ajvInstance: InstanceType<typeof Ajv> | null = null;
let _validateFn: ValidateFunction | null = null;

async function getValidator(): Promise<ValidateFunction> {
  if (_validateFn) return _validateFn;
  const schemaRaw = await fs.readFile(SCHEMA_PATH, 'utf8');
  const schema: object = JSON.parse(schemaRaw) as object;
  _ajvInstance = new Ajv({ allErrors: true });
  _validateFn = _ajvInstance.compile(schema);
  return _validateFn;
}

function validate(data: unknown): asserts data is StateV3 {
  if (!_validateFn) {
    throw new Error('Validator not initialized — call readState first');
  }
  const valid = _validateFn(data);
  if (!valid && _validateFn.errors) {
    const errors = _validateFn.errors.map(
      (e: ErrorObject) => `  ${e.instancePath || '(root)'} ${e.message ?? ''}`
    );
    throw new StateSchemaError(errors);
  }
}

export async function readState(root: string): Promise<StateV3> {
  const statePath = path.join(root, STATE_RELATIVE);
  const validate = await getValidator();

  let raw: string;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch {
    throw new StateNotFoundError(statePath);
  }

  const data: unknown = JSON.parse(raw);
  const valid = validate(data);
  if (!valid && validate.errors) {
    const errors = validate.errors.map(
      (e: ErrorObject) => `  ${e.instancePath || '(root)'} ${e.message ?? ''}`
    );
    throw new StateSchemaError(errors);
  }
  return data as StateV3;
}

export async function writeState(root: string, state: StateV3): Promise<void> {
  const validate = await getValidator();
  const valid = validate(state);
  if (!valid && validate.errors) {
    const errors = validate.errors.map(
      (e: ErrorObject) => `  ${e.instancePath || '(root)'} ${e.message ?? ''}`
    );
    throw new StateSchemaError(errors);
  }

  const statePath = path.join(root, STATE_RELATIVE);
  const tmpPath = `${statePath}.tmp`;
  const serialized = JSON.stringify(state, null, 2);

  await fs.writeFile(tmpPath, serialized, 'utf8');
  await fs.rename(tmpPath, statePath);
}
