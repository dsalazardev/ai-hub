import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEALTH_FILE } from '../harness/state-store.js';
import { transactWrite } from '../writes/transaction.js';
import type { TrackerFailureClass } from './tracker.js';

/**
 * Salud del poll del tracker (R-009): estado cerrado y versionado en `.ai-hub/runs/health.json`, con identidad de
 * proyecto y job, fase del circuito, fallos consecutivos, clase del último fallo, horas de fallo y de éxito, próxima
 * sonda y si la caída ya se avisó. Se actualiza por la transacción X2 (lock exclusivo, temporal y rename). Un estado
 * ilegible o de una versión más nueva se conserva byte a byte, se informa una sola vez y detiene el poll hasta que
 * una persona lo recupere (`ai-hub control poll --reset-health`). Nunca guarda cuerpos de respuesta ni secretos.
 */

export const HEALTH_VERSION = 1;
export const CIRCUIT_THRESHOLD = 4;
export const HEALTH_PHASES = ['closed', 'open', 'half-open'] as const;
export type HealthPhase = (typeof HEALTH_PHASES)[number];

export interface PollHealth {
  v: number;
  project: string;
  job: string;
  phase: HealthPhase;
  failures: number;
  failureClass: TrackerFailureClass | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  nextProbeAt: string | null;
  notified: boolean;
}

const KEYS: ReadonlyArray<keyof PollHealth> = ['v', 'project', 'job', 'phase', 'failures', 'failureClass', 'lastFailureAt', 'lastSuccessAt', 'nextProbeAt', 'notified'];
const FAILURE_CLASSES = new Set(['network', 'timeout', 'http_4xx', 'http_5xx', 'auth', 'rate_limit', 'incomplete', 'parse', 'config']);
/** Huella del estado ilegible ya informado: evita repetir el aviso en cada ejecución del cron. */
export const HEALTH_NOTICE_FILE = `${HEALTH_FILE}.reported`;

export type HealthRead =
  | { kind: 'ok'; health: PollHealth }
  | { kind: 'absent' }
  | { kind: 'corrupt'; fingerprint: string }
  | { kind: 'newer'; version: number; fingerprint: string };

export function healthPath(root: string): string {
  return path.join(root, ...HEALTH_FILE.split('/'));
}

export function initialHealth(project: string, job: string): PollHealth {
  return { v: HEALTH_VERSION, project, job, phase: 'closed', failures: 0, failureClass: null, lastFailureAt: null, lastSuccessAt: null, nextProbeAt: null, notified: false };
}

const isDate = (value: unknown): boolean => value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));

/** Esquema cerrado: claves exactas y tipos; cualquier otra forma es ilegible. */
function valid(data: unknown): data is PollHealth {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === KEYS.length &&
    KEYS.every((key) => key in record) &&
    record.v === HEALTH_VERSION &&
    typeof record.project === 'string' &&
    typeof record.job === 'string' &&
    (HEALTH_PHASES as readonly string[]).includes(record.phase as string) &&
    Number.isInteger(record.failures) &&
    (record.failures as number) >= 0 &&
    (record.failureClass === null || FAILURE_CLASSES.has(record.failureClass as string)) &&
    isDate(record.lastFailureAt) &&
    isDate(record.lastSuccessAt) &&
    isDate(record.nextProbeAt) &&
    typeof record.notified === 'boolean'
  );
}

export async function readHealth(root: string): Promise<HealthRead> {
  const text = await fs.readFile(healthPath(root), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (text === null) {
    return { kind: 'absent' };
  }
  const fingerprint = createHash('sha256').update(text).digest('hex');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'corrupt', fingerprint };
  }
  const version = typeof data === 'object' && data !== null ? (data as { v?: unknown }).v : undefined;
  if (typeof version === 'number' && version > HEALTH_VERSION) {
    return { kind: 'newer', version, fingerprint };
  }
  return valid(data) ? { kind: 'ok', health: data } : { kind: 'corrupt', fingerprint };
}

export class HealthChangedError extends Error {
  constructor() {
    super('el estado de salud cambió o dejó de ser legible durante la actualización; no se reemplaza');
    this.name = 'HealthChangedError';
  }
}

/**
 * Actualización atómica y exclusiva (X1 + X2). `mutate` recibe el estado vigente (o el inicial si no existe).
 * Si el archivo pasa a ser ilegible o más nuevo entre la lectura y la escritura, no se reemplaza.
 */
export async function updateHealth(root: string, project: string, job: string, mutate: (health: PollHealth) => PollHealth): Promise<PollHealth> {
  let next: PollHealth | null = null;
  const result = await transactWrite({
    root,
    file: healthPath(root),
    module: 'control/health.ts',
    capture: false,
    retention: 0,
    transform: (current) => {
      let base: PollHealth;
      if (current === null) {
        base = initialHealth(project, job);
      } else {
        let data: unknown;
        try {
          data = JSON.parse(current);
        } catch {
          throw new HealthChangedError();
        }
        if (!valid(data)) {
          throw new HealthChangedError();
        }
        base = data;
      }
      next = mutate(base);
      return `${JSON.stringify(next, null, 2)}\n`;
    },
  });
  if (result.status === 'stopped') {
    throw new Error(`no se pudo actualizar la salud del poll (${result.reason}): ${result.detail}`);
  }
  return next ?? (await readHealthOrInitial(root, project, job));
}

async function readHealthOrInitial(root: string, project: string, job: string): Promise<PollHealth> {
  const read = await readHealth(root);
  return read.kind === 'ok' ? read.health : initialHealth(project, job);
}

/** ¿Ya se informó este estado ilegible? Lo marca si no; devuelve true si es la primera vez. */
export async function claimCorruptNotice(root: string, fingerprint: string): Promise<boolean> {
  const file = path.join(root, ...HEALTH_NOTICE_FILE.split('/'));
  const previous = await fs.readFile(file, 'utf8').catch(() => null);
  if (previous?.trim() === fingerprint) {
    return false;
  }
  await transactWrite({ root, file, module: 'control/health.ts', capture: false, retention: 0, transform: () => `${fingerprint}\n` });
  return true;
}

/** Recuperación explícita: aparta el estado ilegible (sin borrarlo) y empieza uno nuevo. */
export async function resetHealth(root: string, now: Date): Promise<string | null> {
  const file = healthPath(root);
  const read = await readHealth(root);
  if (read.kind === 'ok' || read.kind === 'absent') {
    return null;
  }
  const aside = `${file}.unreadable-${now.toISOString().replace(/[:.]/g, '-')}`;
  await fs.rename(file, aside);
  await fs.rm(path.join(root, ...HEALTH_NOTICE_FILE.split('/')), { force: true });
  return aside;
}
