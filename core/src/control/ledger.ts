import { createHash } from 'node:crypto';
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

interface LedgerLine {
  v: 1;
  ts: string;
  type: 'decision' | 'status' | 'event';
  decision?: Omit<Decision, 'updatedAt'>;
  id?: string;
  status?: DecisionStatus;
  approver?: string;
  reason?: string;
  key?: string;
}

export interface ControlSettings {
  approvers: string[];
  ttlHours: number;
  expire: 'block' | 'notify';
  pollMinutes: number;
}

export const DEFAULT_TTL_HOURS = 24;
export const DEFAULT_POLL_MINUTES = 15;

export function controlSettings(manifest: ProjectManifest): ControlSettings | null {
  const control = manifest.control;
  if (!control) {
    return null;
  }
  return {
    approvers: control.approvers ?? [],
    ttlHours: control.ttlHours ?? DEFAULT_TTL_HOURS,
    expire: control.expire ?? 'block',
    pollMinutes: control.pollMinutes ?? DEFAULT_POLL_MINUTES,
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

/** Estado actual de cada decisión (pliegue del registro). */
export async function readDecisions(root: string): Promise<Map<string, Decision>> {
  const decisions = new Map<string, Decision>();
  for (const line of await readLines(root)) {
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
  return decisions;
}

export async function recordDecision(root: string, decision: Omit<Decision, 'updatedAt'>): Promise<void> {
  await append(root, { v: 1, ts: decision.createdAt, type: 'decision', decision });
}

export async function recordStatus(
  root: string,
  id: string,
  status: DecisionStatus,
  now: Date,
  extra: { approver?: string; reason?: string } = {},
): Promise<void> {
  await append(root, { v: 1, ts: now.toISOString(), type: 'status', id, status, ...extra });
}

export async function hasSeenEvent(root: string, key: string): Promise<boolean> {
  return (await readLines(root)).some((line) => line.type === 'event' && line.key === key);
}

export async function recordEvent(root: string, key: string, now: Date): Promise<void> {
  await append(root, { v: 1, ts: now.toISOString(), type: 'event', key });
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
