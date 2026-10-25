import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_DIR = path.join(__dirname, '..', '..', 'presets');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'preset.schema.json');

export type DangerDecision = 'ask' | 'deny';

export interface PresetDangerPattern {
  id: string;
  pattern: string;
  decision: DangerDecision;
  reason: string;
}

export interface PresetDetect {
  files?: string[];
  dependencies?: string[];
}

export interface PresetPolicy {
  trunk?: 'auto' | 'closed' | 'open';
  guardMode?: 'shadow' | 'enforce';
  worktrees?: boolean;
  optOuts?: string[];
  dangerPatterns?: PresetDangerPattern[];
}

export interface Preset {
  id: string;
  version: number;
  extends?: string;
  description: string;
  detect?: PresetDetect;
  stack?: {
    languages?: string[];
    frontend?: string;
    backend?: string;
    packageManager?: string;
  };
  commands?: Record<string, string>;
  paths?: { source?: string[]; tests?: string[]; docs?: string[] };
  policy?: PresetPolicy;
  rules?: string[];
  agents?: { publish?: string[] };
  skills?: { publish?: string[] };
  mcp?: { source?: string };
}

export class PresetError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`preset inválido:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    this.name = 'PresetError';
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

export function presetDir(id: string): string {
  return path.join(PRESETS_DIR, id);
}

export async function listPresetIds(): Promise<string[]> {
  const entries = await fs.readdir(PRESETS_DIR, { withFileTypes: true }).catch(() => []);
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(PRESETS_DIR, entry.name, 'preset.yaml');
    if (await fs.access(file).then(() => true, () => false)) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

export async function loadPreset(id: string): Promise<Preset> {
  const file = path.join(presetDir(id), 'preset.yaml');
  const raw = await fs.readFile(file, 'utf8').catch(() => {
    throw new PresetError([`no existe el preset "${id}" en ${PRESETS_DIR}`]);
  });
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    throw new PresetError([`${id}/preset.yaml no es YAML válido: ${(error as Error).message}`]);
  }
  const preset = await validatePresetData(data, id);
  if (preset.id !== id) {
    throw new PresetError([`${id}/preset.yaml declara id "${preset.id}", se esperaba "${id}"`]);
  }
  return preset;
}

export async function validatePresetData(data: unknown, label = 'preset'): Promise<Preset> {
  const validate = await validator();
  if (!validate(data)) {
    throw new PresetError(
      (validate.errors ?? []).map(
        (error) => `${label}/preset.yaml ${error.instancePath || '(root)'} ${error.message ?? 'inválido'}`,
      ),
    );
  }
  return data as Preset;
}
