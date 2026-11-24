import fs from 'node:fs/promises';
import path from 'node:path';
import { git, readAssociations, save, type Association } from './association.js';

/**
 * Limpieza de lo propio e integrado (R-074, R-075): solo los recursos de la asociación, comparando con la cabeza de
 * origen integrada (nunca con el commit resultado de un squash o rebase). El worktree se retira solo limpio y con su
 * cabeza igual o anterior a esa cabeza, sin `--force`; la rama local solo si no está en otro worktree, con
 * `git update-ref -d` condicionado a su cabeza observada tras la misma comprobación. Lo demás se conserva y se
 * informa. Cada paso es idempotente. El borrado remoto exige una capacidad declarada (4.83); sin ella, se conserva.
 */

export type StepResult = 'removed' | 'deleted' | 'kept' | 'absent';

export interface CleanupReport {
  iid: number | null;
  remote: StepResult;
  worktree: StepResult;
  branch: StepResult;
  notes: string[];
}

export interface CleanupHooks {
  /** Punto de prueba: tras comprobar la rama local y antes de borrarla. */
  beforeBranchDelete?: () => Promise<void> | void;
  /** Punto de prueba: tras leer la cabeza remota y antes del push condicionado. */
  beforeRemoteDelete?: () => Promise<void> | void;
  /** Punto de prueba: tras el borrado remoto y antes de los pasos locales (interrupción). */
  afterRemoteDelete?: () => Promise<void> | void;
  /** Borrado remoto condicionado declarado (R-108): nombre del remoto; sin él, la rama remota se conserva. */
  remote?: { name: string };
}

export interface RemoteDeleteDeclaration {
  tracker: 'gitlab' | 'github';
  /** Transporte medido del remoto (`https` o `ssh`). */
  transport: 'https' | 'ssh';
  /** Versión mínima del cliente git medida. */
  git: string;
  evidence: string;
}

/**
 * Declaraciones de borrado remoto condicionado por tracker, transporte y versión de git, con evidencia citada (R-108,
 * D-60). Solo GitHub por HTTPS con git ≥ 2.56.1 (experimento 2.10: 10/10 rechazos con commit ajeno y control borrado).
 * GitLab sin medir (2.9): su rama remota se conserva.
 */
export const REMOTE_DELETE_DECLARATIONS: readonly RemoteDeleteDeclaration[] = [
  { tracker: 'github', transport: 'https', git: '2.56.1', evidence: '.planning/findings.md › Hito 2 › 2.10; decisions.md › D-60' },
];

export interface RemoteDeleteContext {
  transport: 'https' | 'ssh' | null;
  gitVersion: string | null;
}

function versionAtLeast(found: string, minimum: string): boolean {
  const a = found.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) > (b[index] ?? 0);
    }
  }
  return true;
}

/** Transporte del remoto y versión del cliente git del worktree (sin red). */
export function remoteDeleteContext(root: string, remote = 'origin'): RemoteDeleteContext {
  const url = git(root, ['remote', 'get-url', remote]);
  const version = git(root, ['--version']);
  const transport = !url.ok ? null : /^https:\/\//i.test(url.out) ? 'https' : /^(ssh:\/\/|[^/:]+@[^/:]+:)/i.test(url.out) ? 'ssh' : null;
  return { transport, gitVersion: version.ok ? (/(\d+\.\d+\.\d+)/.exec(version.out)?.[1] ?? null) : null };
}

/**
 * Borrado remoto con lease (D-60): el push lleva la cabeza esperada; si la rama se movió, git lo rechaza (`stale info`) y
 * la rama se conserva. Nunca un borrado simple. Devuelve si se borró.
 */
export function deleteRemoteBranchWithLease(root: string, remote: string, branch: string, expected: string): boolean {
  return git(root, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expected}`, remote, `:refs/heads/${branch}`]).ok;
}

/** ¿Hay borrado remoto condicionado medido para este tracker, transporte y versión de git? */
export function remoteDeleteCapability(tracker: 'gitlab' | 'github', context: RemoteDeleteContext, declarations: readonly RemoteDeleteDeclaration[] = REMOTE_DELETE_DECLARATIONS): boolean {
  return declarations.some(
    (item) => item.tracker === tracker && item.transport === context.transport && context.gitVersion !== null && versionAtLeast(context.gitVersion, item.git),
  );
}

function isAncestor(root: string, commit: string, of: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', commit, of]).ok;
}

function worktreesOf(root: string): Array<{ path: string; branch: string | null }> {
  return git(root, ['worktree', 'list', '--porcelain'])
    .out.split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1]?.trim() ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null,
    }));
}

const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Limpieza local de la asociación de `iid` cuyo cambio se integró con `sourceHead`. */
export async function cleanupAssociation(root: string, branch: string, iid: number, sourceHead: string, hooks: CleanupHooks = {}): Promise<CleanupReport> {
  const records = await readAssociations(root);
  const entry = Object.entries(records).find(([, item]) => item.branch === branch);
  const report: CleanupReport = { iid: null, remote: 'kept', worktree: 'kept', branch: 'kept', notes: [] };
  if (entry === undefined) {
    report.notes.push(`sin asociación para ${branch}: no se borra nada`);
    return report;
  }
  const [key, association] = entry;
  if (association.iid !== iid) {
    report.notes.push(`la rama ${branch} pertenece a la asociación de #${association.iid}, no a #${iid}: no se borra nada`);
    return report;
  }
  report.iid = iid;
  // Remoto (R-108): solo con capacidad declarada, por push con lease sobre la cabeza integrada; nunca un borrado simple.
  const previous = association.steps.cleanup.remote;
  if (previous === 'deleted' || previous === 'absent') {
    report.remote = previous;
  } else if (hooks.remote === undefined) {
    report.remote = 'kept';
    report.notes.push(`rama remota ${branch} conservada: branch_delete_unprotected (sin borrado condicionado verificado para este tracker)`);
  } else {
    const listed = git(root, ['ls-remote', '--heads', hooks.remote.name, `refs/heads/${branch}`]);
    if (listed.ok && listed.out === '') {
      report.remote = 'absent';
    } else {
      await hooks.beforeRemoteDelete?.();
      if (!deleteRemoteBranchWithLease(root, hooks.remote.name, branch, sourceHead)) {
        // `stale info` o revisión rechazada: la rama remota se movió; no se ejecutan los pasos locales.
        report.remote = 'kept';
        report.notes.push(`rama remota ${branch} conservada: branch_moved (el remoto ya no apunta a la cabeza integrada); los pasos locales esperan a una nueva comparación`);
        await save(root, key, { ...association, steps: { ...association.steps, cleanup: { ...association.steps.cleanup, remote: 'kept' } } });
        return report;
      }
      report.remote = 'deleted';
    }
    // El paso remoto se registra antes de los locales: una interrupción entre ambos no lo repite.
    await save(root, key, { ...association, steps: { ...association.steps, cleanup: { ...association.steps.cleanup, remote: report.remote } } });
    await hooks.afterRemoteDelete?.();
  }

  const dir = path.join(root, ...association.worktree.split('/'));
  const registered = worktreesOf(root).find((item) => same(item.path, dir));
  if (registered === undefined) {
    report.worktree = 'absent';
  } else {
    const head = git(dir, ['rev-parse', 'HEAD']).out;
    const dirty = git(dir, ['status', '--porcelain', '--untracked-files=all']).out !== '';
    if (dirty) {
      report.notes.push(`worktree ${association.worktree} con cambios sin commit: se conserva con su rama`);
    } else if (!isAncestor(root, head, sourceHead)) {
      report.notes.push(`worktree ${association.worktree} con commits posteriores a la cabeza integrada: se conserva`);
    } else {
      const removed = git(root, ['worktree', 'remove', dir]);
      report.worktree = removed.ok ? 'removed' : 'kept';
      if (!removed.ok) {
        report.notes.push(`git worktree remove no retiró ${association.worktree}: ${removed.err.split('\n')[0]}`);
      } else {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  if (report.worktree === 'kept') {
    report.branch = 'kept';
  } else if (!git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    report.branch = 'absent';
  } else {
    const elsewhere = worktreesOf(root).find((item) => item.branch === branch);
    const observed = git(root, ['rev-parse', `refs/heads/${branch}`]).out;
    if (elsewhere !== undefined) {
      report.notes.push(`la rama ${branch} está en otro worktree (${elsewhere.path}): se conserva`);
    } else if (!isAncestor(root, observed, sourceHead)) {
      report.notes.push(`la rama ${branch} tiene commits posteriores a la cabeza integrada: se conserva`);
    } else {
      await hooks.beforeBranchDelete?.();
      // Borrado condicionado a la cabeza observada: si alguien hizo commit entretanto, falla y la rama se conserva.
      const deleted = git(root, ['update-ref', '-d', `refs/heads/${branch}`, observed]);
      report.branch = deleted.ok ? 'deleted' : 'kept';
      if (!deleted.ok) {
        report.notes.push(`la rama ${branch} cambió entre la comprobación y el borrado: se conserva`);
      }
    }
  }
  const next: Association = {
    ...association,
    steps: { ...association.steps, cleanup: { remote: report.remote, worktree: report.worktree, branch: report.branch } },
  };
  await save(root, key, next);
  return report;
}

/** Cierre sin merge (R-075): la rama y el worktree se quedan; solo se informa. */
export async function reportClosedWithoutMerge(root: string, iid: number): Promise<string | null> {
  const association = Object.values(await readAssociations(root)).find((item) => item.iid === iid);
  if (association === undefined) {
    return null;
  }
  return `#${iid}: la petición de cambio se cerró sin merge; la rama ${association.branch} y el worktree ${association.worktree} se conservan (sin limpieza por tiempo)`;
}
