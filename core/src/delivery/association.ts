import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, updateState } from '../harness/state-store.js';

/**
 * Asociación de entrega (R-068, R-069, R-077): una por (tracker, proyecto, iid), en el estado duradero
 * (`.ai-hub/runs/control/state/associations.json`, fuera de la poda de runs). Guarda la rama, su base, el worktree,
 * la petición de cambio y los pasos completados. Se crea solo después de que la transición pasó el WIP (quien llama
 * la invoca tras aplicar `ai::in-dev`). Cada paso se reconcilia con el estado real de git antes de repetirse.
 */

export const DEFAULT_BRANCH_PREFIX = 'ai/';
export const WORKTREES_DIR = '.worktrees';

export interface Association {
  kind: 'gitlab' | 'github';
  project: string;
  iid: number;
  slug: string;
  branch: string;
  base: string;
  worktree: string;
  changeRequest: { id: number; url?: string } | null;
  steps: { branch: boolean; worktree: boolean; changeRequest: boolean; cleanup: Record<string, string> };
  merge?: { sourceHead: string; result: string | null } | null;
  createdAt: string;
}

export class DeliveryError extends Error {
  constructor(
    readonly reasonCode: 'branch_foreign' | 'branch_shared' | 'base_unresolvable' | 'git_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export function associationKey(kind: string, project: string, iid: number): string {
  return `${kind}:${project}:${iid}`;
}

/** Slug fijo de la rama: ASCII en minúsculas, palabras unidas por guiones, como máximo 40 caracteres. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? 'issue' : slug;
}

export function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function branchExists(root: string, branch: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

export async function readAssociations(root: string): Promise<Record<string, Association>> {
  return (await readState<Association>(root, 'associations')).records;
}

export interface EnsureInput {
  kind: 'gitlab' | 'github';
  project: string;
  iid: number;
  title: string;
  /** Referencia de la base (p. ej. la rama por defecto); se resuelve a commit al crear la asociación. */
  base: string;
  prefix?: string;
  now?: Date;
  /** Punto de prueba: tras crear la rama y antes del worktree (interrupción). */
  afterBranch?: () => Promise<void> | void;
}

/** Crea o reutiliza la asociación y completa sus pasos de rama y worktree sin duplicar (R-068, R-069, R-077). */
export async function ensureAssociation(root: string, input: EnsureInput): Promise<Association> {
  const key = associationKey(input.kind, input.project, input.iid);
  const records = await readAssociations(root);
  let association = records[key];
  if (association === undefined) {
    const prefix = input.prefix ?? DEFAULT_BRANCH_PREFIX;
    const slug = slugOf(input.title);
    const branch = `${prefix}${input.iid}-${slug}`;
    const holder = Object.values(records).find((item) => item.branch === branch);
    if (holder !== undefined) {
      throw new DeliveryError('branch_shared', `la rama ${branch} ya pertenece a la asociación de #${holder.iid}; dos asociaciones nunca comparten rama`);
    }
    if (branchExists(root, branch)) {
      throw new DeliveryError('branch_foreign', `la rama ${branch} existe sin asociación; no se adopta en silencio: revísala o renómbrala`);
    }
    const base = git(root, ['rev-parse', '--verify', '--quiet', `${input.base}^{commit}`]);
    if (!base.ok) {
      throw new DeliveryError('base_unresolvable', `la base ${input.base} no se resuelve a un commit`);
    }
    association = {
      kind: input.kind,
      project: input.project,
      iid: input.iid,
      slug,
      branch,
      base: base.out,
      worktree: path.join(WORKTREES_DIR, `${input.iid}-${slug}`).split(path.sep).join('/'),
      changeRequest: null,
      steps: { branch: false, worktree: false, changeRequest: false, cleanup: {} },
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    await save(root, key, association);
  }
  // Paso 1: rama (reconciliada con git: si ya existe por una ejecución interrumpida, se reutiliza).
  if (!association.steps.branch) {
    if (!branchExists(root, association.branch)) {
      const created = git(root, ['branch', association.branch, association.base]);
      if (!created.ok) {
        throw new DeliveryError('git_failed', `no se pudo crear la rama ${association.branch}: ${created.err.split('\n')[0]}`);
      }
    }
    association = { ...association, steps: { ...association.steps, branch: true } };
    await save(root, key, association);
  }
  await input.afterBranch?.();
  // Paso 2: worktree propio de la rama.
  if (!association.steps.worktree) {
    const dir = path.join(root, ...association.worktree.split('/'));
    const listed = git(root, ['worktree', 'list', '--porcelain']).out;
    const present = listed.split('\n\n').some((block) => block.includes(`branch refs/heads/${association.branch}`));
    if (!present) {
      await fs.mkdir(path.dirname(dir), { recursive: true });
      const added = git(root, ['worktree', 'add', dir, association.branch]);
      if (!added.ok) {
        throw new DeliveryError('git_failed', `no se pudo crear el worktree de ${association.branch}: ${added.err.split('\n')[0]}`);
      }
    }
    association = { ...association, steps: { ...association.steps, worktree: true } };
    await save(root, key, association);
  }
  return association;
}

export async function save(root: string, key: string, association: Association): Promise<void> {
  await updateState<Association>(root, 'associations', (records) => ({ ...records, [key]: association }));
}
