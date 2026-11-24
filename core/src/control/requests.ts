import { createHash } from 'node:crypto';
import { readState, updateState } from '../harness/state-store.js';

/**
 * Peticiones de ejecución y concesiones (R-005, R-093). Solo `ai-hub control` escribe este registro, separado del
 * ledger de decisiones (`.ai-hub/runs/control/state/grants.json`). Una petición pasa a concesión únicamente cuando
 * un aprobador responde `aprobar <iid> <prefijo>` con un prefijo de su hash; `rechazar` la deja rechazada y nunca
 * consumible. Aprobar una spec no crea ni implica una concesión. El hash vincula contenido, proyecto, worktree,
 * efectos permitidos, commit base, sello, límites del run y caducidad.
 */

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'revoked';

export interface ExecutionRequestInput {
  project: string;
  iid: number;
  summary: string;
  worktree: string;
  effects: string[];
  base: string;
  seal: string | null;
  limits: { maxMinutes: number };
  expiresAt: string;
}

export interface ExecutionRequest extends ExecutionRequestInput {
  id: string;
  status: RequestStatus;
  approver?: string;
  createdAt: string;
  updatedAt: string;
}

export function requestHash(input: ExecutionRequestInput): string {
  const canonical = JSON.stringify({
    project: input.project,
    iid: input.iid,
    summary: input.summary,
    worktree: input.worktree,
    effects: [...input.effects].sort(),
    base: input.base,
    seal: input.seal,
    limits: { maxMinutes: input.limits.maxMinutes },
    expiresAt: input.expiresAt,
  });
  return createHash('sha256').update(`ai-hub-request\n${canonical}`).digest('hex');
}

export async function readRequests(root: string): Promise<Record<string, ExecutionRequest>> {
  return (await readState<ExecutionRequest>(root, 'grants')).records;
}

/** Registra una petición pendiente (idempotente por hash). */
export async function submitRequest(root: string, input: ExecutionRequestInput, now: Date = new Date()): Promise<ExecutionRequest> {
  const id = requestHash(input);
  let stored: ExecutionRequest | null = null;
  await updateState<ExecutionRequest>(root, 'grants', (records) => {
    stored = records[id] ?? { ...input, id, status: 'pending', createdAt: now.toISOString(), updatedAt: now.toISOString() };
    return { ...records, [id]: stored };
  });
  return stored as unknown as ExecutionRequest;
}

/** Peticiones pendientes y vigentes de una issue. */
export async function openRequests(root: string, iid: number, now: Date): Promise<ExecutionRequest[]> {
  return Object.values(await readRequests(root)).filter(
    (request) => request.iid === iid && request.status === 'pending' && Date.parse(request.expiresAt) > now.getTime(),
  );
}

export async function setRequestStatus(root: string, id: string, status: 'approved' | 'rejected', approver: string, now: Date): Promise<void> {
  await updateState<ExecutionRequest>(root, 'grants', (records) => {
    const current = records[id];
    if (current === undefined || current.status !== 'pending') {
      throw new Error(`la petición ${id.slice(0, 8)} ya no está pendiente; no se cambia`);
    }
    return { ...records, [id]: { ...current, status, approver, updatedAt: now.toISOString() } };
  });
}

/**
 * Verificación del runner: solo una concesión aprobada, vigente y de esa issue autoriza ejecutar. Una spec aprobada
 * sin petición aprobada no basta, y un id que el registro no tiene como aprobado se rechaza.
 */
export async function verifyGrant(root: string, iid: number, id: string | null, now: Date = new Date()): Promise<{ ok: true; grant: ExecutionRequest } | { ok: false; reason: 'grant_invalid'; detail: string }> {
  const grants = Object.values(await readRequests(root)).filter((item) => item.iid === iid && item.status === 'approved' && Date.parse(item.expiresAt) > now.getTime());
  const grant = id === null ? grants[0] : grants.find((item) => item.id === id);
  if (grant === undefined) {
    return { ok: false, reason: 'grant_invalid', detail: `#${iid}: no hay una concesión aprobada y vigente${id === null ? '' : ` con el id ${id.slice(0, 8)}`}; el runner no ejecuta` };
  }
  return { ok: true, grant };
}
