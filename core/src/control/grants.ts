import { withLock, projectLockPath } from '../harness/lock.js';
import { readState, StateCorruptError, StateVersionError, updateState } from '../harness/state-store.js';
import { requestHash, type ExecutionRequest } from './requests.js';

/**
 * Lado del runner sobre las concesiones (R-093, R-094). Verificación: solo una concesión que el registro de control
 * tiene como aprobada, por un aprobador vigente, sin cambios en lo que vincula su hash, del mismo proyecto y
 * worktree, con efectos dentro de los concedidos, vigente, no revocada ni consumida por otro run, y con el sello
 * actual igual al vinculado. Consumo: exclusivo bajo el lock de la concesión, una sola vez; el mismo run puede
 * reanudar; revocar y consumir compiten bajo el mismo lock con un único ganador. Un registro ilegible o de una
 * versión más nueva nunca autoriza: se trata como consumido.
 */

export type GrantRefusal =
  | 'grant_invalid'
  | 'grant_unauthorized'
  | 'grant_modified'
  | 'grant_effects'
  | 'grant_scope'
  | 'grant_expired'
  | 'grant_revoked'
  | 'grant_consumed'
  | 'grant_seal'
  | 'grant_registry';

export interface RunClaim {
  iid: number;
  grantId: string;
  project: string;
  worktree: string;
  effects: string[];
  /** Sello actual de la feature, o null si no implementa una feature sellada. */
  seal: string | null;
  approvers: readonly string[];
  now?: Date;
}

export type GrantCheck = { ok: true; grant: ExecutionRequest & { consumedBy?: string } } | { ok: false; reason: GrantRefusal; detail: string };

type GrantRecord = ExecutionRequest & { consumedBy?: string };

async function records(root: string): Promise<Record<string, GrantRecord> | GrantCheck> {
  try {
    return (await readState<GrantRecord>(root, 'grants')).records;
  } catch (error) {
    if (error instanceof StateCorruptError || error instanceof StateVersionError) {
      return { ok: false, reason: 'grant_registry', detail: `${error.message}; ninguna concesión se considera válida` };
    }
    throw error;
  }
}

function refuse(reason: GrantRefusal, detail: string): GrantCheck {
  return { ok: false, reason, detail };
}

/** Verificación completa de una concesión para un run (5.8). No escribe nada. */
export async function verifyGrantForRun(root: string, claim: RunClaim): Promise<GrantCheck> {
  const all = await records(root);
  if ('ok' in all) {
    return all as GrantCheck;
  }
  const grant = (all as Record<string, GrantRecord>)[claim.grantId];
  const now = claim.now ?? new Date();
  if (grant === undefined || grant.iid !== claim.iid) {
    return refuse('grant_invalid', `#${claim.iid}: el registro de control no tiene la concesión ${claim.grantId.slice(0, 8)}; el runner no ejecuta`);
  }
  if (grant.status === 'revoked' || grant.status === 'rejected') {
    return refuse('grant_revoked', `#${claim.iid}: la concesión ${grant.id.slice(0, 8)} está ${grant.status === 'revoked' ? 'revocada' : 'rechazada'}`);
  }
  if (grant.status === 'consumed') {
    return refuse('grant_consumed', `#${claim.iid}: la concesión ${grant.id.slice(0, 8)} ya la consumió el run ${grant.consumedBy ?? '?'}`);
  }
  if (grant.status !== 'approved') {
    return refuse('grant_invalid', `#${claim.iid}: la petición ${grant.id.slice(0, 8)} no está aprobada (${grant.status})`);
  }
  if (grant.approver === undefined || !claim.approvers.includes(grant.approver)) {
    return refuse('grant_unauthorized', `#${claim.iid}: el aprobador de la concesión no está en manifest.control.approvers`);
  }
  if (requestHash(grant) !== grant.id) {
    return refuse('grant_modified', `#${claim.iid}: la petición cambió después de aprobarse (su hash ya no coincide)`);
  }
  if (grant.project !== claim.project || grant.worktree !== claim.worktree) {
    return refuse('grant_scope', `#${claim.iid}: la concesión es para otro proyecto o worktree`);
  }
  const extra = claim.effects.filter((effect) => !grant.effects.includes(effect));
  if (extra.length > 0) {
    return refuse('grant_effects', `#${claim.iid}: efectos no concedidos: ${extra.join(', ')}`);
  }
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    return refuse('grant_expired', `#${claim.iid}: la concesión caducó el ${grant.expiresAt}`);
  }
  if (grant.seal !== null && grant.seal !== claim.seal) {
    return refuse('grant_seal', `#${claim.iid}: el sello actual no es el vinculado a la concesión`);
  }
  return { ok: true, grant };
}

function grantLock(root: string, id: string): string {
  return projectLockPath(root, `grant-${id.slice(0, 32)}`);
}

/**
 * Consumo exclusivo (5.9): bajo el lock de la concesión, una vez. El mismo run reanuda; otro run es rechazado
 * nombrando el que la consumió.
 */
export async function consumeGrant(root: string, claim: RunClaim, run: string): Promise<GrantCheck> {
  return withLock(grantLock(root, claim.grantId), `concesión ${claim.grantId.slice(0, 8)}`, async () => {
    const all = await records(root);
    if ('ok' in all) {
      return all as GrantCheck;
    }
    const current = (all as Record<string, GrantRecord>)[claim.grantId];
    if (current?.status === 'consumed') {
      return current.consumedBy === run
        ? { ok: true, grant: current }
        : refuse('grant_consumed', `#${claim.iid}: la concesión ${claim.grantId.slice(0, 8)} ya la consumió el run ${current.consumedBy ?? '?'}; no se reproduce`);
    }
    const check = await verifyGrantForRun(root, claim);
    if (!check.ok) {
      return check;
    }
    let consumed: GrantRecord | null = null;
    await updateState<GrantRecord>(root, 'grants', (items) => {
      const latest = items[claim.grantId];
      if (latest === undefined || latest.status !== 'approved') {
        throw new Error('la concesión cambió bajo el lock');
      }
      consumed = { ...latest, status: 'consumed', consumedBy: run, updatedAt: (claim.now ?? new Date()).toISOString() };
      return { ...items, [claim.grantId]: consumed };
    });
    return { ok: true, grant: consumed as unknown as GrantRecord };
  }, { waitMs: 10_000 });
}

/** Revocación coordinada (5.9): bajo el mismo lock; una concesión ya consumida no se revoca. */
export async function revokeGrant(root: string, id: string, now: Date = new Date()): Promise<'revoked' | 'already_consumed' | 'unknown'> {
  return withLock(grantLock(root, id), `concesión ${id.slice(0, 8)}`, async () => {
    let outcome: 'revoked' | 'already_consumed' | 'unknown' = 'unknown';
    await updateState<GrantRecord>(root, 'grants', (items) => {
      const current = items[id];
      if (current === undefined) {
        return items;
      }
      if (current.status === 'consumed') {
        outcome = 'already_consumed';
        return items;
      }
      outcome = 'revoked';
      return { ...items, [id]: { ...current, status: 'revoked', updatedAt: now.toISOString() } };
    });
    return outcome;
  }, { waitMs: 10_000 });
}
