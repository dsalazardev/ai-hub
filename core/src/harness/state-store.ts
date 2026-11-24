import fs from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_RUNS_DIR } from './local.js';
import { listRuns } from './runs.js';
import { transactWrite } from '../writes/transaction.js';
import type { LockOptions } from './lock.js';

/**
 * Estado duradero en su ubicación canónica (R-044, design › Ubicaciones canónicas):
 * - asociaciones, índice de ejecuciones y concesiones en `.ai-hub/runs/control/state/<tipo>.json`;
 * - salud del poll en `.ai-hub/runs/health.json` (excepción por el texto de #10, C-09).
 * Ninguno lo toca la retención de `runs` (0.12.0–0.17.0 tampoco: solo listan directorios y excluyen
 * `control/`). Cada archivo tiene versión; uno de versión más nueva se conserva byte a byte y las
 * decisiones que dependen de él se detienen con `state_version_newer` (R-045).
 */

export const STATE_DIR = `${HARNESS_RUNS_DIR}/control/state`;
export const HEALTH_FILE = `${HARNESS_RUNS_DIR}/health.json`;
export const STATE_TYPES = ['associations', 'execution-index', 'grants'] as const;
export type StateType = (typeof STATE_TYPES)[number];
export const STATE_VERSION = 1;

export class StateVersionError extends Error {
  readonly reasonCode = 'state_version_newer';
  constructor(
    readonly file: string,
    readonly version: number,
  ) {
    super(`${file} lo escribió una versión más nueva del arnés (v${version}); se conserva y no se decide sobre él`);
    this.name = 'StateVersionError';
  }
}

export class StateCorruptError extends Error {
  readonly reasonCode = 'state_corrupt';
  constructor(readonly file: string) {
    super(`${file} no es un estado válido; se conserva sin tocar`);
    this.name = 'StateCorruptError';
  }
}

export interface StateDocument<T> {
  v: number;
  records: Record<string, T>;
}

export function statePath(root: string, type: StateType): string {
  return path.join(root, ...STATE_DIR.split('/'), `${type}.json`);
}

function parseDocument<T>(file: string, text: string | null): StateDocument<T> {
  if (text === null) {
    return { v: STATE_VERSION, records: {} };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StateCorruptError(file);
  }
  const doc = data as Partial<StateDocument<T>>;
  if (typeof doc !== 'object' || doc === null || typeof doc.v !== 'number' || typeof doc.records !== 'object' || doc.records === null) {
    throw new StateCorruptError(file);
  }
  if (doc.v > STATE_VERSION) {
    throw new StateVersionError(file, doc.v);
  }
  return { v: doc.v, records: doc.records };
}

export async function readState<T>(root: string, type: StateType): Promise<StateDocument<T>> {
  const file = statePath(root, type);
  const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  return parseDocument<T>(file, text);
}

/** Actualiza registros bajo la transacción X2; un archivo más nuevo o corrupto nunca se reescribe. */
export async function updateState<T>(
  root: string,
  type: StateType,
  mutate: (records: Record<string, T>) => Record<string, T>,
  lock?: LockOptions,
): Promise<void> {
  const file = statePath(root, type);
  const result = await transactWrite({
    root,
    file,
    module: 'harness/state-store.ts',
    capture: false,
    ...(lock ? { lock } : {}),
    transform: (current) => {
      const doc = parseDocument<T>(file, current);
      const records = mutate({ ...doc.records });
      const next = `${JSON.stringify({ v: STATE_VERSION, records }, null, 2)}\n`;
      return current !== null && JSON.stringify(doc.records) === JSON.stringify(records) ? current : next;
    },
  });
  if (result.status === 'stopped') {
    throw new Error(`${file}: ${result.reason} (${result.detail})`);
  }
}

export interface ExecutionIndexEntry {
  run: string;
  issue?: number;
  createdAt: string;
}

/** Entradas del índice cuyo directorio de run ya no existe (podado): se informan, no son corrupción. */
export async function danglingIndexEntries(root: string): Promise<string[]> {
  const index = await readState<ExecutionIndexEntry>(root, 'execution-index');
  const runs = new Set(await listRuns(root));
  return Object.values(index.records)
    .map((entry) => entry.run)
    .filter((run) => !runs.has(run))
    .sort();
}
