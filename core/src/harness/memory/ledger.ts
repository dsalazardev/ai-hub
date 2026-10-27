import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, StateNotFoundError, type ProjectState } from './state.js';

export const LEDGER_RELATIVE = '.planning/memory.jsonl';
export const LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_RETENTION = 1000;

export const LEDGER_EVENTS = ['start', 'checkpoint', 'decision', 'end'] as const;
export type LedgerEventName = (typeof LEDGER_EVENTS)[number];

export interface LedgerDecision {
  id: string;
  choice: string;
  alternatives: string[];
}

export interface LedgerEvent {
  schemaVersion: 1;
  sessionId: string;
  changeId: string | null;
  event: LedgerEventName;
  branch: string | null;
  worktree: string | null;
  baselineHead: string | null;
  head: string | null;
  files: string[];
  commits: string[];
  toolCalls: number;
  decision?: LedgerDecision;
  timestamps: { at: string };
}

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerValidationError';
  }
}

function text(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new LedgerValidationError(`"${field}" debe ser texto`);
  }
  return value.length > 500 ? value.slice(0, 500) : value;
}

function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new LedgerValidationError(`"${field}" debe ser una lista de textos`);
  }
  return value.slice(0, 200);
}

function decision(value: unknown): LedgerDecision | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerValidationError('"decision" debe ser un objeto');
  }
  const data = value as Record<string, unknown>;
  const id = text(data.id, 'decision.id');
  const choice = text(data.choice, 'decision.choice');
  if (!id || !choice) {
    throw new LedgerValidationError('"decision.id" y "decision.choice" son obligatorios');
  }
  return { id, choice, alternatives: list(data.alternatives, 'decision.alternatives') };
}

/**
 * Closed schema: only the fields below survive. Prompts, responses, file
 * contents and secrets are dropped even if the caller sends them.
 */
export function sanitizeEvent(input: Record<string, unknown>, now: Date = new Date()): LedgerEvent {
  const sessionId = text(input.sessionId, 'sessionId');
  if (!sessionId) {
    throw new LedgerValidationError('"sessionId" es obligatorio');
  }
  const event = input.event ?? 'checkpoint';
  if (typeof event !== 'string' || !(LEDGER_EVENTS as readonly string[]).includes(event)) {
    throw new LedgerValidationError(`"event" debe ser uno de: ${LEDGER_EVENTS.join(', ')}`);
  }
  const toolCalls = input.toolCalls ?? 0;
  if (typeof toolCalls !== 'number' || !Number.isFinite(toolCalls) || toolCalls < 0) {
    throw new LedgerValidationError('"toolCalls" debe ser un número no negativo');
  }
  const base: LedgerEvent = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sessionId,
    changeId: text(input.changeId, 'changeId'),
    event: event as LedgerEventName,
    branch: text(input.branch, 'branch'),
    worktree: text(input.worktree, 'worktree'),
    baselineHead: text(input.baselineHead, 'baselineHead'),
    head: text(input.head, 'head'),
    files: list(input.files, 'files'),
    commits: list(input.commits, 'commits'),
    toolCalls: Math.trunc(toolCalls),
    timestamps: { at: now.toISOString() },
  };
  const decided = decision(input.decision);
  if (decided) {
    base.decision = decided;
  }
  return base;
}

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_RELATIVE);
}

export async function readLedger(root: string, limit?: number): Promise<LedgerEvent[]> {
  const raw = await fs.readFile(ledgerPath(root), 'utf8').catch(() => '');
  const events: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      continue;
    }
  }
  return limit === undefined ? events : events.slice(-limit);
}

export async function appendLedger(
  root: string,
  input: Record<string, unknown>,
  retention: number = DEFAULT_RETENTION,
): Promise<LedgerEvent> {
  const event = sanitizeEvent(input);
  const file = ledgerPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await readLedger(root);
  const next = [...existing, event];
  const kept = next.length > retention ? next.slice(-retention) : next;
  await fs.writeFile(file, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  return event;
}

export function queryLedger(
  events: LedgerEvent[],
  filter: { changeId?: string; sessionId?: string },
): LedgerEvent[] {
  return events.filter(
    (event) =>
      (filter.changeId === undefined || event.changeId === filter.changeId) &&
      (filter.sessionId === undefined || event.sessionId === filter.sessionId),
  );
}

export interface ResumeSummary {
  last: LedgerEvent | null;
  activeChange: string | null;
  phase: string;
  tasks: { total: number; done: number };
  state: ProjectState | null;
  /** Feature de Spec Kit activa y de dónde salió: `state` (versionado) o `local` (.specify/feature.json). */
  feature: { dir: string; source: 'state' | 'local'; pending: number } | null;
}

const FEATURE_PREFIX = 'specs/';

/**
 * Feature de Spec Kit: la nombra `.planning/state.json` (`activeChange: specs/<feature>`) o,
 * si no, el puntero local `.specify/feature.json`. Solo se referencia la ruta; nunca se copia
 * el contenido de la feature a `.planning/`.
 */
async function activeFeature(root: string, state: ProjectState | null): Promise<{ dir: string; source: 'state' | 'local' } | null> {
  if (state?.activeChange?.startsWith(FEATURE_PREFIX)) {
    return { dir: state.activeChange.replace(/\/+$/, ''), source: 'state' };
  }
  if (state?.activeChange) {
    return null;
  }
  const raw = await fs.readFile(path.join(root, '.specify', 'feature.json'), 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { feature_directory?: unknown };
    return typeof parsed.feature_directory === 'string' && parsed.feature_directory.startsWith(FEATURE_PREFIX)
      ? { dir: parsed.feature_directory.replace(/\/+$/, ''), source: 'local' }
      : null;
  } catch {
    return null;
  }
}

async function countTasks(root: string, dir: string): Promise<{ total: number; done: number } | null> {
  const text = await fs.readFile(path.join(root, ...dir.split('/'), 'tasks.md'), 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  return {
    total: lines.filter((line) => /^\s*-\s*\[[ xX]\]/.test(line)).length,
    done: lines.filter((line) => /^\s*-\s*\[[xX]\]/.test(line)).length,
  };
}

export async function resumeLedger(root: string): Promise<ResumeSummary> {
  const events = await readLedger(root, 1);
  const last = events.length > 0 ? events[events.length - 1] : null;
  let state: ProjectState | null = null;
  try {
    state = await readState(root);
  } catch (error) {
    if (!(error instanceof StateNotFoundError)) {
      throw error;
    }
  }
  const feature = await activeFeature(root, state);
  const featureTasks = feature === null ? null : await countTasks(root, feature.dir);
  const tasks = featureTasks ?? state?.tasks ?? { total: 0, done: 0 };
  return {
    last,
    activeChange: state?.activeChange ?? feature?.dir ?? null,
    phase: state?.phase ?? 'idle',
    tasks,
    state,
    feature: feature === null ? null : { ...feature, pending: tasks.total - tasks.done },
  };
}
