import { createHash } from 'node:crypto';
import { projectLockPath, withLock } from '../harness/lock.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectManifest } from '../manifest/manifest.js';

/**
 * Registro de decisiones del plano de control: `.ai-hub/runs/control/decisions.jsonl` (ignorado por
 * git, escritor único `ai-hub control`). Esquema cerrado: identificadores, etiquetas, estados, hashes,
 * ids de aprobador y códigos de motivo. Nunca títulos, cuerpos de notas, prompts ni credenciales.
 */
export const CONTROL_DIR = '.ai-hub/runs/control';
const DECISIONS_FILE = 'decisions.jsonl';

export const DECISION_KINDS = ['transition', 'closing', 'spec-approval', 'preapproved'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_STATUSES = ['pending', 'approved', 'applied', 'rejected', 'superseded', 'expired', 'failed'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const EVIDENCE_SOURCES = ['local', 'remote', 'pipeline', 'tracker'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface Decision {
  id: string;
  kind: DecisionKind;
  iid: number;
  feature: string;
  from: string | null;
  to: string;
  state: string | null;
  source: EvidenceSource;
  seal: string | null;
  /** Lo que la persona teclea tras `aprobar <iid>`: el sello en `spec-approval`, el id en el resto. */
  hash: string;
  createdAt: string;
  expiresAt: string;
  status: DecisionStatus;
  approver?: string;
  reason?: string;
  updatedAt: string;
}

/** Versión de línea que este binario escribe y entiende. */
export const LEDGER_VERSION = 1;

interface LedgerLine {
  v: number;
  ts: string;
  type: 'decision' | 'status' | 'event' | 'conflict';
  decision?: Omit<Decision, 'updatedAt'>;
  id?: string;
  status?: DecisionStatus;
  approver?: string;
  reason?: string;
  key?: string;
}

export interface ControlSettings {
  approvers: string[];
  channelId?: string;
  ttlHours: number;
  expire: 'block' | 'notify';
  pollMinutes: number;
  /** Nombre del job de cron del poll (R-011): de la configuración, nunca un id del host. */
  pollJob: string;
}

export const DEFAULT_TTL_HOURS = 24;
export const DEFAULT_POLL_MINUTES = 15;
export const DEFAULT_POLL_JOB = 'ai-hub-control-poll';

export function controlSettings(manifest: ProjectManifest): ControlSettings | null {
  const control = manifest.control;
  if (!control) {
    return null;
  }
  return {
    approvers: control.approvers ?? [],
    ...(control.channelId !== undefined ? { channelId: control.channelId } : {}),
    ttlHours: control.ttlHours ?? DEFAULT_TTL_HOURS,
    expire: control.expire ?? 'block',
    pollMinutes: control.pollMinutes ?? DEFAULT_POLL_MINUTES,
    pollJob: control.pollJob ?? DEFAULT_POLL_JOB,
  };
}

const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const APPROVER_ID = /^[0-9]{5,25}$/;

function file(root: string): string {
  return path.join(root, CONTROL_DIR, DECISIONS_FILE);
}

async function append(root: string, line: LedgerLine): Promise<void> {
  if (line.reason !== undefined && !REASON_CODE.test(line.reason)) {
    throw new Error(`motivo no admitido en el registro de control: debe ser un código [a-z0-9_]`);
  }
  if (line.approver !== undefined && !APPROVER_ID.test(line.approver)) {
    throw new Error('aprobador no admitido en el registro de control: debe ser un id numérico de Discord');
  }
  await fs.mkdir(path.dirname(file(root)), { recursive: true });
  await fs.appendFile(file(root), `${JSON.stringify(line)}\n`, 'utf8');
}

async function readLines(root: string): Promise<LedgerLine[]> {
  const text = await fs.readFile(file(root), 'utf8').catch(() => '');
  const lines: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      continue;
    }
    try {
      lines.push(JSON.parse(raw) as LedgerLine);
    } catch {
      // Una línea corrupta no invalida el resto del registro.
    }
  }
  return lines;
}

/**
 * Barrera ante líneas de versión más nueva (R-045, D-66): una línea que este binario no entiende
 * puede invalidar una decisión anterior (rechazo, sustitución). Ignorarla haría reaparecer esa
 * decisión, así que detiene las decisiones de la issue que nombra, o las de todo el proyecto si su
 * issue no se puede determinar. Los bytes del registro nunca se reescriben.
 */
export interface LedgerBarrier {
  issues: Set<number>;
  project: boolean;
  /** Números de línea (desde 1) con versión más nueva. */
  lines: number[];
  /** Números de línea (desde 1) que no son JSON (R-025): detienen todo el proyecto. */
  corrupt: number[];
}

/**
 * Texto de la barrera para `apply`, `tick` y `doctor`, o null si no hay. Nunca incluye el contenido de las
 * líneas: solo sus números. El registro se conserva byte a byte.
 */
export function describeBarrier(barrier: LedgerBarrier): string | null {
  const parts: string[] = [];
  if (barrier.corrupt.length > 0) {
    parts.push(`ledger_corrupt: líneas ilegibles ${barrier.corrupt.join(', ')} en ${DECISIONS_FILE}; se conserva sin tocar y no se aplica ninguna decisión del proyecto hasta que una persona lo revise`);
  }
  if (barrier.lines.length > 0) {
    const scope = barrier.project ? 'del proyecto' : `de las issues ${[...barrier.issues].sort((a, b) => a - b).map((iid) => `#${iid}`).join(', ')}`;
    parts.push(`state_version_newer: líneas ${barrier.lines.join(', ')} de una versión más nueva del arnés; se detienen las decisiones ${scope}`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

export async function ledgerBarrier(root: string): Promise<LedgerBarrier> {
  const barrier: LedgerBarrier = { issues: new Set(), project: false, lines: [], corrupt: [] };
  const iidById = new Map<string, number>();
  const text = await fs.readFile(file(root), 'utf8').catch(() => '');
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') {
      return;
    }
    let line: Partial<LedgerLine> & Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Partial<LedgerLine> & Record<string, unknown>;
    } catch {
      // R-025: una línea ilegible pudo ser un rechazo o una sustitución; no se puede saber de qué issue, así
      // que detiene todo el proyecto (fallo cerrado). Los bytes no se tocan.
      barrier.corrupt.push(index + 1);
      barrier.project = true;
      return;
    }
    const known = line.decision && typeof line.decision === 'object' ? (line.decision as { id?: unknown; iid?: unknown }) : null;
    if (known && typeof known.id === 'string' && typeof known.iid === 'number') {
      iidById.set(known.id, known.iid);
    }
    if (typeof line.v === 'number' && line.v > LEDGER_VERSION) {
      barrier.lines.push(index + 1);
      const iid =
        typeof line.iid === 'number'
          ? line.iid
          : known && typeof known.iid === 'number'
            ? known.iid
            : typeof line.id === 'string'
              ? iidById.get(line.id)
              : undefined;
      if (typeof iid === 'number' && Number.isInteger(iid)) {
        barrier.issues.add(iid);
      } else {
        barrier.project = true;
      }
    }
  });
  return barrier;
}

export function barred(barrier: LedgerBarrier, iid: number): boolean {
  return barrier.project || barrier.issues.has(iid);
}

/** Estado actual de cada decisión (pliegue del registro), sin las que una barrera detiene. */
export async function readDecisions(root: string): Promise<Map<string, Decision>> {
  const barrier = await ledgerBarrier(root);
  const decisions = new Map<string, Decision>();
  for (const line of await readLines(root)) {
    if (typeof line.v === 'number' && line.v > LEDGER_VERSION) {
      continue;
    }
    if (line.type === 'decision' && line.decision) {
      decisions.set(line.decision.id, { ...line.decision, updatedAt: line.ts });
    } else if (line.type === 'status' && line.id && line.status) {
      const current = decisions.get(line.id);
      if (current) {
        decisions.set(line.id, {
          ...current,
          status: line.status,
          updatedAt: line.ts,
          ...(line.approver ? { approver: line.approver } : {}),
          ...(line.reason ? { reason: line.reason } : {}),
        });
      }
    }
  }
  for (const [id, decision] of decisions) {
    if (barred(barrier, decision.iid)) {
      decisions.delete(id);
    }
  }
  return decisions;
}

export async function recordDecision(root: string, decision: Omit<Decision, 'updatedAt'>): Promise<void> {
  await append(root, { v: LEDGER_VERSION, ts: decision.createdAt, type: 'decision', decision });
}

export async function recordStatus(
  root: string,
  id: string,
  status: DecisionStatus,
  now: Date,
  extra: { approver?: string; reason?: string } = {},
): Promise<void> {
  await append(root, { v: LEDGER_VERSION, ts: now.toISOString(), type: 'status', id, status, ...extra });
}

/** Registro tipado de conflictos y abortos de escritura de etiquetas (R-112): código, nunca texto libre. */
export async function recordConflict(root: string, id: string, reason: 'label_conflict' | 'label_lock_timeout', now: Date): Promise<void> {
  await append(root, { v: LEDGER_VERSION, ts: now.toISOString(), type: 'conflict', id, reason });
}

export async function readConflicts(root: string): Promise<Array<{ id: string; reason: string; ts: string }>> {
  return (await readLines(root))
    .filter((line) => line.type === 'conflict' && typeof line.id === 'string' && typeof line.reason === 'string')
    .map((line) => ({ id: line.id as string, reason: line.reason as string, ts: line.ts }));
}

/**
 * Serializa a los escritores del registro (R-008, X1): leer, decidir y publicar ocurre bajo un único lock del
 * proyecto, para que dos publicadores concurrentes no dejen dos decisiones abiertas ni un evento duplicado
 * se registre dos veces. No es reentrante: quien lo toma no llama a otro escritor que también lo tome.
 */
export async function withLedgerLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withLock(projectLockPath(root, 'control-ledger'), 'registro de decisiones', fn, { waitMs: 30000 });
}

/** Comprueba y registra un evento en una sola sección crítica; devuelve false si ya estaba visto. */
export async function claimEvent(root: string, key: string, now: Date): Promise<boolean> {
  return withLedgerLock(root, async () => {
    if (await hasSeenEvent(root, key)) {
      return false;
    }
    await recordEvent(root, key, now);
    return true;
  });
}

export async function hasSeenEvent(root: string, key: string): Promise<boolean> {
  return (await readLines(root)).some((line) => line.type === 'event' && line.key === key);
}

export async function recordEvent(root: string, key: string, now: Date): Promise<void> {
  await append(root, { v: LEDGER_VERSION, ts: now.toISOString(), type: 'event', key });
}

export const OPEN_STATUSES: readonly DecisionStatus[] = ['pending', 'approved'];

export function openDecisionsFor(decisions: Map<string, Decision>, iid: number): Decision[] {
  return [...decisions.values()].filter((decision) => decision.iid === iid && OPEN_STATUSES.includes(decision.status));
}

/** Id determinista: mismo contenido, mismo id (D1). */
export function decisionId(input: Pick<Decision, 'kind' | 'iid' | 'from' | 'to' | 'state' | 'source' | 'seal'>): string {
  const canon = JSON.stringify([input.kind, input.iid, input.from, input.to, input.state, input.source, input.seal]);
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}
