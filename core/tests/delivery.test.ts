import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { associationKey, DeliveryError, ensureAssociation, readAssociations, slugOf } from '../src/delivery/association.js';
import { cleanupAssociation, reportClosedWithoutMerge } from '../src/delivery/cleanup.js';
import { appendRunEvent, listRuns, pruneRuns } from '../src/harness/runs.js';
import { gitUnavailable } from './git.js';

/** Entrega local (4.57, 4.59, 4.60, 4.65, 4.66; R-068, R-069, R-074, R-075, R-077) con repositorios temporales. */

const skip = gitUnavailable() !== null;
let root: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, windowsHide: true, encoding: 'utf8' });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-delivery-'));
  if (skip) {
    return;
  }
  git(root, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(root, '.gitignore'), '.worktrees/\n.ai-hub/runs/\n');
  await fs.writeFile(path.join(root, 'a.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const input = (iid: number, title: string) => ({ kind: 'gitlab' as const, project: 'grp/demo', iid, title, base: 'main' });

/** Trabajo en el worktree de la asociación: un commit. Devuelve su cabeza. */
async function work(iid: number, file = 'feature.txt'): Promise<{ branch: string; dir: string; head: string }> {
  const association = (await readAssociations(root))[associationKey('gitlab', 'grp/demo', iid)];
  const dir = path.join(root, ...association.worktree.split('/'));
  await fs.writeFile(path.join(dir, file), `trabajo ${iid}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `feat ${iid}`);
  return { branch: association.branch, dir, head: git(dir, 'rev-parse', 'HEAD') };
}

describe.skipIf(skip)('asociación duradera y rama estable (4.57, 4.59, R-068, R-069)', () => {
  it('una asociación por issue con rama y worktree; la poda de runs no la toca', async () => {
    const association = await ensureAssociation(root, input(42, 'Añadir exportación CSV'));
    expect(association).toMatchObject({ branch: 'ai/42-anadir-exportacion-csv', steps: { branch: true, worktree: true } });
    for (let index = 0; index < 4; index += 1) {
      await appendRunEvent(root, { ts: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), run: `2026010${index + 1}-000000Z-r${index}`, kind: 'start' });
    }
    await pruneRuns(root, 1);
    expect((await listRuns(root)).length).toBeLessThanOrEqual(1);
    expect(Object.keys(await readAssociations(root))).toEqual([associationKey('gitlab', 'grp/demo', 42)]);
  });

  it('títulos iguales dan ramas distintas por iid y un cambio de título no renombra', async () => {
    const a = await ensureAssociation(root, input(42, 'Mismo título'));
    const b = await ensureAssociation(root, input(43, 'Mismo título'));
    expect(a.branch).not.toBe(b.branch);
    const again = await ensureAssociation(root, input(42, 'Título editado después'));
    expect(again.branch).toBe(a.branch);
    expect(git(root, 'branch', '--list', 'ai/42-*').split('\n')).toHaveLength(1);
  });

  it('una rama ajena con el nombre esperado detiene sin adoptarla', async () => {
    git(root, 'branch', `ai/44-${slugOf('Rama ajena')}`);
    await expect(ensureAssociation(root, input(44, 'Rama ajena'))).rejects.toMatchObject({ reasonCode: 'branch_foreign' });
    expect(await readAssociations(root)).toEqual({});
  });

  it('el prefijo de rama es configurable', async () => {
    expect((await ensureAssociation(root, { ...input(45, 'Con prefijo'), prefix: 'feature/' })).branch).toBe('feature/45-con-prefijo');
  });
});

describe.skipIf(skip)('pasos reanudables (4.60, R-077)', () => {
  it('una interrupción tras crear la rama se reanuda creando el worktree, sin segunda rama', async () => {
    await expect(
      ensureAssociation(root, {
        ...input(50, 'Interrumpida'),
        afterBranch: () => {
          throw new Error('proceso detenido');
        },
      }),
    ).rejects.toThrow('proceso detenido');
    const partial = (await readAssociations(root))[associationKey('gitlab', 'grp/demo', 50)];
    expect(partial.steps).toMatchObject({ branch: true, worktree: false });
    const resumed = await ensureAssociation(root, input(50, 'Interrumpida'));
    expect(resumed.steps).toMatchObject({ branch: true, worktree: true });
    expect(git(root, 'branch', '--list', 'ai/50-*').split('\n')).toHaveLength(1);
    expect(git(root, 'worktree', 'list').split('\n').filter((line) => line.includes('50-interrumpida'))).toHaveLength(1);
  });
});

describe.skipIf(skip)('limpieza de lo propio e integrado (4.65, R-074)', () => {
  it('merge commit: retira worktree y rama local; el remoto se conserva sin capacidad', async () => {
    await ensureAssociation(root, input(60, 'Merge commit'));
    const { branch, dir, head } = await work(60);
    git(root, 'merge', '--no-ff', '-q', '-m', 'merge', branch);
    const report = await cleanupAssociation(root, branch, 60, head);
    expect(report).toMatchObject({ worktree: 'removed', branch: 'deleted', remote: 'kept' });
    expect(report.notes.join('\n')).toContain('branch_delete_unprotected');
    await expect(fs.access(dir)).rejects.toThrow();
    // Reintento idempotente tras una limpieza parcial o completa.
    expect(await cleanupAssociation(root, branch, 60, head)).toMatchObject({ worktree: 'absent', branch: 'absent' });
  });

  it('squash o rebase: compara con la cabeza de origen integrada, no con el commit resultado', async () => {
    await ensureAssociation(root, input(61, 'Squash'));
    const { branch, head } = await work(61);
    git(root, 'merge', '--squash', '-q', branch);
    git(root, 'commit', '-q', '-m', 'squash');
    expect(await cleanupAssociation(root, branch, 61, head)).toMatchObject({ worktree: 'removed', branch: 'deleted' });
  });

  it('rebase: la base guarda commits reescritos y la limpieza usa solo la cabeza de origen', async () => {
    await ensureAssociation(root, input(69, 'Rebase'));
    const { branch, head } = await work(69);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'avance de main');
    git(root, 'cherry-pick', head);
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(await cleanupAssociation(root, branch, 69, head)).toMatchObject({ worktree: 'removed', branch: 'deleted' });
  });

  it('worktree sucio: se conservan worktree y rama', async () => {
    await ensureAssociation(root, input(62, 'Sucio'));
    const { branch, dir, head } = await work(62);
    await fs.writeFile(path.join(dir, 'sin-commit.txt'), 'pendiente\n');
    const report = await cleanupAssociation(root, branch, 62, head);
    expect(report).toMatchObject({ worktree: 'kept', branch: 'kept' });
    expect(report.notes.join('\n')).toContain('sin commit');
  });

  it('commits posteriores a la cabeza integrada: se conserva y se informa', async () => {
    await ensureAssociation(root, input(63, 'Posteriores'));
    const { branch, head } = await work(63);
    await work(63, 'mas.txt');
    const report = await cleanupAssociation(root, branch, 63, head);
    expect(report).toMatchObject({ worktree: 'kept', branch: 'kept' });
    expect(report.notes.join('\n')).toContain('commits posteriores');
  });

  it('rama local por detrás de la cabeza integrada: se borra condicionada a su cabeza observada', async () => {
    await ensureAssociation(root, input(64, 'Detras'));
    const { branch, dir } = await work(64);
    const behind = git(dir, 'rev-parse', 'HEAD~1');
    git(dir, 'reset', '-q', '--hard', behind);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'integrado');
    const integrated = git(root, 'rev-parse', 'HEAD');
    expect(await cleanupAssociation(root, branch, 64, integrated)).toMatchObject({ worktree: 'removed', branch: 'deleted' });
  });

  it('rama en otro worktree: se conserva y se nombra ese worktree', async () => {
    await ensureAssociation(root, input(65, 'Otro worktree'));
    const { branch, dir, head } = await work(65);
    git(root, 'worktree', 'remove', dir);
    const other = path.join(root, '.worktrees', 'otro');
    git(root, 'worktree', 'add', '-q', other, branch);
    const report = await cleanupAssociation(root, branch, 65, head);
    expect(report).toMatchObject({ worktree: 'absent', branch: 'kept' });
    expect(report.notes.join('\n')).toContain('otro worktree');
  });

  it('un commit entre la comprobación y el borrado local hace fallar el borrado y conserva la rama', async () => {
    await ensureAssociation(root, input(66, 'Carrera'));
    const { branch, head } = await work(66);
    const report = await cleanupAssociation(root, branch, 66, head, {
      beforeBranchDelete: () => {
        git(root, 'commit-tree', '-m', 'x', `${head}^{tree}`);
        const extra = git(root, 'commit-tree', '-p', head, '-m', 'trabajo nuevo', `${head}^{tree}`);
        git(root, 'update-ref', `refs/heads/${branch}`, extra, head);
      },
    });
    expect(report).toMatchObject({ worktree: 'removed', branch: 'kept' });
    expect(git(root, 'rev-parse', '--verify', `refs/heads/${branch}`)).not.toBe(head);
  });

  it('sin asociación o de otra issue: no se borra nada', async () => {
    await ensureAssociation(root, input(67, 'Propia'));
    const { branch, head } = await work(67);
    expect((await cleanupAssociation(root, 'ai/999-ajena', 999, head)).notes.join('\n')).toContain('sin asociación');
    expect((await cleanupAssociation(root, branch, 68, head)).notes.join('\n')).toContain('pertenece a la asociación de #67');
    expect(git(root, 'rev-parse', '--verify', `refs/heads/${branch}`)).toBe(head);
  });
});

describe.skipIf(skip)('cierre sin merge (4.66, R-075)', () => {
  it('rama y worktree persisten y se informa', async () => {
    const association = await ensureAssociation(root, input(70, 'Cerrada'));
    const message = await reportClosedWithoutMerge(root, 70);
    expect(message).toContain('se conservan');
    expect(git(root, 'rev-parse', '--verify', `refs/heads/${association.branch}`)).toBeTruthy();
    await fs.access(path.join(root, ...association.worktree.split('/')));
  });
});

describe('errores tipados de entrega', () => {
  it('DeliveryError lleva su código', () => {
    expect(new DeliveryError('branch_shared', 'x').reasonCode).toBe('branch_shared');
  });
});

describe.skipIf(skip)('asociación al aplicar ai::in-dev tras el WIP (4.58, R-068)', () => {
  it('con WIP lleno no se crea nada; al aplicar la entrada en desarrollo nace una asociación', async () => {
    const { harness, issue, APPROVER, NOW } = await import('./control-harness.js');
    const { fakeGitlab } = await import('./control-fake.js');
    const { featureSeal } = await import('../src/speckit/seal.js');
    const { runDecide } = await import('../src/control/decide.js');
    const h = await harness();
    try {
      await h.consumer();
      await h.feature('001-alpha');
      const manifest = path.join(h.root, 'manifest.yaml');
      await fs.writeFile(manifest, `${await fs.readFile(manifest, 'utf8')}delivery:\n  branchPrefix: ai/\n`);
      git(h.root, 'init', '-q', '-b', 'main');
      git(h.root, 'add', '-A');
      git(h.root, 'commit', '-q', '-m', 'consumidor');
      const seal = await featureSeal(h.root, 'specs/001-alpha');
      const gitlab = fakeGitlab([issue(3, '001-alpha', 'ai::in-spec'), issue(8, null, 'ai::in-dev')]);
      h.use(gitlab);
      await h.cli(['control', 'decide', '--online']);
      expect((await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '3', seal.slice(0, 10)])).code).toBe(0);
      await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
      const waiting = await h.cli(['control', 'apply', '--preapproved']);
      expect(waiting.err).toContain('WIP lleno');
      expect(await readAssociations(h.root)).toEqual({});
      expect(git(h.root, 'branch', '--list', 'ai/*')).toBe('');
      gitlab.issues.get(8)!.labels = ['ai::in-review'];
      const started = await h.cli(['control', 'apply', '--preapproved']);
      expect(started.code, started.err).toBe(0);
      expect(started.out).toContain('rama ai/3-issue-3');
      const associations = Object.values(await readAssociations(h.root));
      expect(associations).toHaveLength(1);
      expect(associations[0]).toMatchObject({ iid: 3, branch: 'ai/3-issue-3', project: 'grp/demo', steps: { branch: true, worktree: true } });
    } finally {
      await h.dispose();
    }
  });
});

describe('dueño y evidencia de merge por adaptador (3.19, R-018)', () => {
  it('dueños: patrón de bot de token, atributo bot documentado y «no disponible» sin campo', async () => {
    const { GitlabTracker } = await import('../src/control/tracker.js');
    const { fakeGitlab } = await import('./control-fake.js');
    const gitlab = fakeGitlab([], {
      members: [
        { id: 1, username: 'ana', access_level: 50 },
        { id: 2, username: 'project_9_bot_abc123', access_level: 50 },
        { id: 3, username: 'svc-deploy', access_level: 50 },
        { id: 4, username: 'dev', access_level: 30 },
      ],
      users: { 1: { bot: false } },
    });
    const owners = await new GitlabTracker('https://gitlab.test', 'grp/demo', 'x', gitlab.fetch).repositoryOwners();
    expect(owners).toEqual([
      { id: 1, username: 'ana', bot: false },
      { id: 2, username: 'project_9_bot_abc123', bot: true },
      { id: 3, username: 'svc-deploy', bot: null },
    ]);
  });

  it('merge: squash registra cabeza y resultado por separado; sin commit resultante, «no disponible»', async () => {
    const { GitlabTracker } = await import('../src/control/tracker.js');
    const { fakeGitlab } = await import('./control-fake.js');
    const gitlab = fakeGitlab([], {
      mergeRequests: {
        5: { state: 'merged', sha: 'a'.repeat(40), squash_on_merge: true, squash_commit_sha: 'b'.repeat(40), merge_commit_sha: 'c'.repeat(40) },
        6: { state: 'merged', sha: 'd'.repeat(40), merge_commit_sha: null, squash_commit_sha: '' },
      },
    });
    const tracker = new GitlabTracker('https://gitlab.test', 'grp/demo', 'x', gitlab.fetch);
    expect(await tracker.mergeEvidence(5)).toEqual({ state: 'merged', sourceHead: 'a'.repeat(40), result: 'b'.repeat(40), squash: true });
    expect(await tracker.mergeEvidence(6)).toMatchObject({ sourceHead: 'd'.repeat(40), result: null });
  });
});

describe.skipIf(skip)('evidencia de merge en la asociación y reconciliación (4.64, 4.67, R-073, R-076)', () => {
  async function withChangeRequest(iid: number, title: string): Promise<{ branch: string; head: string }> {
    const { save } = await import('../src/delivery/association.js');
    await ensureAssociation(root, input(iid, title));
    const done = await work(iid);
    const key = associationKey('gitlab', 'grp/demo', iid);
    await save(root, key, { ...(await readAssociations(root))[key], changeRequest: { id: iid + 100 } });
    return done;
  }

  it('squash: la asociación guarda la cabeza integrada y el resultado por separado; tracker inalcanzable no registra', async () => {
    const { recordMergeEvidence } = await import('../src/delivery/reconcile.js');
    const { TrackerError } = await import('../src/control/tracker.js');
    const { head } = await withChangeRequest(80, 'Squash evidencia');
    const down = { mergeEvidence: async () => { throw new TrackerError('caído', 503, null, { failureClass: 'http_5xx' }); } };
    expect(await recordMergeEvidence(root, 80, down)).toMatchObject({ recorded: false });
    expect((await readAssociations(root))[associationKey('gitlab', 'grp/demo', 80)].merge).toBeUndefined();
    const up = { mergeEvidence: async () => ({ state: 'merged', sourceHead: head, result: 'f'.repeat(40), squash: true }) };
    expect(await recordMergeEvidence(root, 80, up)).toMatchObject({ recorded: true });
    expect((await readAssociations(root))[associationKey('gitlab', 'grp/demo', 80)].merge).toEqual({ sourceHead: head, result: 'f'.repeat(40) });
  });

  it('un merge ocurrido con el host apagado se limpia una sola vez al reconciliar', async () => {
    const { reconcileDeliveries } = await import('../src/delivery/reconcile.js');
    const { branch, head } = await withChangeRequest(81, 'Host apagado');
    git(root, 'merge', '--no-ff', '-q', '-m', 'merge', branch);
    const source = { mergeEvidence: async () => ({ state: 'merged', sourceHead: head, result: git(root, 'rev-parse', 'HEAD'), squash: false }) };
    const first = await reconcileDeliveries(root, source);
    expect(first.join('\n')).toContain('worktree removed, rama deleted');
    expect(await reconcileDeliveries(root, source)).toEqual([]);
  });

  it('cerrado sin merge: se informa y no se limpia', async () => {
    const { reconcileDeliveries } = await import('../src/delivery/reconcile.js');
    const { branch } = await withChangeRequest(82, 'Cerrado');
    const lines = await reconcileDeliveries(root, { mergeEvidence: async () => ({ state: 'closed', sourceHead: null, result: null, squash: null }) });
    expect(lines.join('\n')).toContain('se conservan');
    expect(git(root, 'rev-parse', '--verify', `refs/heads/${branch}`)).toBeTruthy();
  });
});

describe('revisor elegible (4.62, R-071)', () => {
  it('autor bot: se pide al owner con el motivo; autor que aprobó la spec: sigue siendo el revisor', async () => {
    const { chooseReviewers } = await import('../src/delivery/change-request.js');
    const members = new Map([[1, 50], [2, 30], [3, 40], [9, 50]]);
    const owners = [{ id: 1, username: 'owner', bot: false }];
    const bot = chooseReviewers({ id: 3, username: 'project_5_bot_x', bot: true }, owners, 9, [], members);
    expect(bot).toMatchObject({ reviewerIds: [1], intervention: false });
    expect(bot.reason).toContain('cuenta bot');
    const author = chooseReviewers({ id: 2, username: 'ana', bot: false }, owners, 9, [], members);
    expect(author).toMatchObject({ reviewerIds: [2], intervention: false });
  });

  it('owner igual a la identidad del arnés: intervención necesaria y sin revisores; un configurado complementa al owner', async () => {
    const { chooseReviewers } = await import('../src/delivery/change-request.js');
    const members = new Map([[1, 50], [9, 50], [7, 30]]);
    const harnessOnly = chooseReviewers({ id: 4, username: 'sin-acceso', bot: false }, [{ id: 9, username: 'harness', bot: null }], 9, [], members);
    expect(harnessOnly).toMatchObject({ reviewerIds: [], intervention: true });
    expect(harnessOnly.reason).toContain('no tiene acceso');
    const complemented = chooseReviewers(null, [{ id: 1, username: 'owner', bot: false }], 9, [7], members);
    expect(complemented.reviewerIds).toEqual([1, 7]);
  });
});

describe.skipIf(skip)('MR en draft una sola vez (4.61, R-070)', () => {
  it('primera convergencia abre un draft con enlace y marcador; la segunda ejecución no crea otro', async () => {
    const { GitlabTracker } = await import('../src/control/tracker.js');
    const { fakeGitlab } = await import('./control-fake.js');
    const { openChangeRequest } = await import('../src/delivery/change-request.js');
    await ensureAssociation(root, input(90, 'Exportar CSV'));
    const gitlab = fakeGitlab([{ iid: 90, title: 'Exportar CSV', labels: ['ai::in-dev'], description: '', notes: [], author: { id: 2, username: 'ana' } }], {
      members: [{ id: 2, username: 'ana', access_level: 30 }, { id: 1, username: 'owner', access_level: 50 }],
      users: { 1: { bot: false } },
    });
    const tracker = new GitlabTracker('https://gitlab.test', 'grp/demo', 'x', gitlab.fetch);
    const open = { iid: 90, title: 'Exportar CSV', target: 'main', summary: 'Exporta el informe a CSV.', testEvidence: 'npm test (verde)', issueUrl: 'https://gitlab.test/grp/demo/-/issues/90' };
    const first = await openChangeRequest(root, tracker, open);
    expect(first.created).toBe(true);
    const mr = gitlab.mergeRequests.get(first.iid)!;
    expect(mr).toMatchObject({ source_branch: 'ai/90-exportar-csv', target_branch: 'main', reviewer_ids: [2] });
    expect(String(mr.title)).toMatch(/^Draft: Exportar CSV \(#90\)$/);
    expect(String(mr.description)).toContain('https://gitlab.test/grp/demo/-/issues/90');
    expect(String(mr.description)).toContain('ai-hub:delivery=gitlab:grp/demo:90');
    expect((await openChangeRequest(root, tracker, open)).created).toBe(false);
    // Caída tras crear el MR y antes de guardarlo: se reencuentra por rama y marcador.
    const { save } = await import('../src/delivery/association.js');
    const key = associationKey('gitlab', 'grp/demo', 90);
    const current = (await readAssociations(root))[key];
    await save(root, key, { ...current, changeRequest: null, steps: { ...current.steps, changeRequest: false } });
    expect((await openChangeRequest(root, tracker, open)).created).toBe(false);
    expect(gitlab.mergeRequests.size).toBe(1);
    // Inventario: ninguna petición de entrega aprueba ni fusiona.
    expect(gitlab.requests.filter((request) => /\/(approve|merge)\b/.test(request.path) || request.method === 'PUT')).toEqual([]);
  });
});

describe('guardia de entrega (4.63, R-072)', () => {
  it('un rol implementer que invoca la entrega se deniega nombrando el rol; otros roles no', async () => {
    const { classifyDelivery } = await import('../src/harness/guards/delivery.js');
    expect(classifyDelivery('npx --no-install ai-hub control deliver 42 --target main', 'implementer-backend')).toMatchObject({ decision: 'deny', rule: 'delivery:role' });
    expect(classifyDelivery('npx --no-install ai-hub control deliver 42 --target main', 'implementer-backend')?.reason).toContain('implementer-backend');
    expect(classifyDelivery('npx --no-install ai-hub control deliver 42', null)).toBeNull();
    expect(classifyDelivery('npm test', 'implementer-frontend')).toBeNull();
  });

  it('el cliente del tracker no tiene endpoints de aprobación ni de merge', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '..', 'src', 'control', 'tracker.ts'), 'utf8');
    expect(source).not.toMatch(/\/approve|\/merge['`]|merge_when_pipeline_succeeds|'PUT', this\.url\(`\/merge_requests/);
  });
});

describe('guardia de entrega en el hook pre (4.63)', () => {
  it('el host recibe deny nombrando el rol, también en shadow', async () => {
    const { runHook } = await import('../src/cli/hook.js');
    const { seedFixture } = await import('./fixtures.js');
    const { writeInventory } = await import('../src/manifest/manifest.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-deliver-hook-'));
    try {
      await seedFixture(dir);
      await writeInventory(dir);
      const payload = JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', agent_type: 'implementer-backend', tool_name: 'Bash', tool_input: { command: 'npx --no-install ai-hub control deliver 42 --target main' }, cwd: dir });
      const outcome = await runHook('pre', payload, dir);
      const specific = outcome.output.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
      expect(specific.permissionDecision).toBe('deny');
      expect(specific.permissionDecisionReason).toContain('implementer-backend');
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe.skipIf(skip)('borrado remoto con lease (4.83, R-108)', () => {
  let bare: string;
  beforeEach(async () => {
    bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-delivery-remote-'));
    git(bare, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'main');
  });
  afterEach(async () => {
    await fs.rm(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const remoteHas = (branch: string): boolean => git(root, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`) !== '';

  async function integrated(iid: number, title: string): Promise<{ branch: string; head: string }> {
    await ensureAssociation(root, input(iid, title));
    const done = await work(iid);
    git(root, 'push', '-q', 'origin', done.branch);
    git(root, 'merge', '--no-ff', '-q', '-m', 'merge', done.branch);
    return done;
  }

  it('sin capacidad no se envía ningún borrado y los pasos locales siguen', async () => {
    const { branch, head } = await integrated(100, 'Sin capacidad');
    const report = await cleanupAssociation(root, branch, 100, head);
    expect(report).toMatchObject({ remote: 'kept', worktree: 'removed', branch: 'deleted' });
    expect(report.notes.join('\n')).toContain('branch_delete_unprotected');
    expect(remoteHas(branch)).toBe(true);
  });

  it('con capacidad declarada: borra con lease sobre la cabeza integrada', async () => {
    const { branch, head } = await integrated(101, 'Con capacidad');
    expect(await cleanupAssociation(root, branch, 101, head, { remote: { name: 'origin' } })).toMatchObject({ remote: 'deleted', worktree: 'removed', branch: 'deleted' });
    expect(remoteHas(branch)).toBe(false);
  });

  it('un commit publicado tras leer la cabeza: stale info conserva la rama como branch_moved y no hay pasos locales', async () => {
    const { branch, head, dir } = await integrated(102, 'Movida');
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-delivery-other-'));
    try {
      const report = await cleanupAssociation(root, branch, 102, head, {
        remote: { name: 'origin' },
        beforeRemoteDelete: () => {
          git(other, 'clone', '-q', '-b', branch, bare, 'c');
          const clone = path.join(other, 'c');
          git(clone, 'commit', '-q', '--allow-empty', '-m', 'publicado por otra persona');
          git(clone, 'push', '-q', 'origin', branch);
        },
      });
      expect(report.remote).toBe('kept');
      expect(report.notes.join('\n')).toContain('branch_moved');
      expect(remoteHas(branch)).toBe(true);
      await fs.access(dir);
      expect(git(root, 'rev-parse', '--verify', `refs/heads/${branch}`)).toBe(head);
    } finally {
      await fs.rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('rama remota ya borrada: el paso remoto cuenta como hecho y los locales siguen', async () => {
    const { branch, head } = await integrated(103, 'Ya borrada');
    git(root, 'push', '-q', 'origin', `:refs/heads/${branch}`);
    expect(await cleanupAssociation(root, branch, 103, head, { remote: { name: 'origin' } })).toMatchObject({ remote: 'absent', worktree: 'removed', branch: 'deleted' });
  });

  it('interrupción tras el borrado remoto: se reanuda completando solo los pasos locales', async () => {
    const { branch, head } = await integrated(104, 'Interrumpida remota');
    await expect(
      cleanupAssociation(root, branch, 104, head, {
        remote: { name: 'origin' },
        afterRemoteDelete: () => {
          throw new Error('proceso detenido');
        },
      }),
    ).rejects.toThrow('proceso detenido');
    expect(remoteHas(branch)).toBe(false);
    expect((await readAssociations(root))[associationKey('gitlab', 'grp/demo', 104)].steps.cleanup.remote).toBe('deleted');
    expect(await cleanupAssociation(root, branch, 104, head, { remote: { name: 'origin' } })).toMatchObject({ remote: 'deleted', worktree: 'removed', branch: 'deleted' });
  });
});

describe('capacidad de borrado remoto declarada (4.83, 5.19)', () => {
  it('solo GitHub por HTTPS con git ≥ 2.56.1 (2.10); GitLab, SSH o un git anterior conservan la rama', async () => {
    const { remoteDeleteCapability } = await import('../src/delivery/cleanup.js');
    const https = { transport: 'https' as const, gitVersion: '2.56.1' };
    expect(remoteDeleteCapability('github', https)).toBe(true);
    expect(remoteDeleteCapability('github', { ...https, gitVersion: '2.57.0' })).toBe(true);
    expect(remoteDeleteCapability('github', { ...https, gitVersion: '2.55.9' })).toBe(false);
    expect(remoteDeleteCapability('github', { ...https, transport: 'ssh' })).toBe(false);
    expect(remoteDeleteCapability('github', { transport: null, gitVersion: null })).toBe(false);
    expect(remoteDeleteCapability('gitlab', https)).toBe(false);
    expect(remoteDeleteCapability('gitlab', https, [{ tracker: 'gitlab', transport: 'https', git: '2.40.0', evidence: 'prueba' }])).toBe(true);
  });

  it('el contexto se lee del remoto y del cliente git del worktree', async () => {
    const { remoteDeleteContext } = await import('../src/delivery/cleanup.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-delete-ctx-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'remote', 'add', 'origin', 'https://example.invalid/o/r.git');
      expect(remoteDeleteContext(dir)).toMatchObject({ transport: 'https', gitVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
      git(dir, 'remote', 'set-url', 'origin', 'git@example.invalid:o/r.git');
      expect(remoteDeleteContext(dir).transport).toBe('ssh');
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/**
 * E2E opt-in de 5.19 contra el repositorio desechable del experimento 2.10: `AI_HUB_DELETE_E2E_REPO=propietario/repo`
 * (credenciales del cliente git del equipo; nunca en el test). Omitido por defecto.
 */
const DELETE_E2E_REPO = process.env.AI_HUB_DELETE_E2E_REPO ?? '';
describe.skipIf(DELETE_E2E_REPO === '')('borrado remoto con lease contra GitHub real (5.19, opt-in)', () => {
  it('rama movida por otro: se conserva; cabeza esperada: se borra; la capacidad se reconoce en ese remoto', async () => {
    const { deleteRemoteBranchWithLease, remoteDeleteCapability, remoteDeleteContext } = await import('../src/delivery/cleanup.js');
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-delete-e2e-'));
    const url = `https://github.com/${DELETE_E2E_REPO}.git`;
    const branch = `ai-hub-e2e-${Date.now()}`;
    try {
      for (const name of ['a', 'b']) {
        const clone = spawnSync('git', ['clone', '-q', url, name], { cwd: base, encoding: 'utf8', windowsHide: true });
        expect(clone.status, clone.stderr).toBe(0);
        git(path.join(base, name), 'config', 'user.email', 'e2e@example.invalid');
        git(path.join(base, name), 'config', 'user.name', 'e2e');
      }
      const a = path.join(base, 'a');
      const b = path.join(base, 'b');
      expect(remoteDeleteCapability('github', remoteDeleteContext(a))).toBe(true);
      git(a, 'checkout', '-q', '-b', branch);
      git(a, 'commit', '-q', '--allow-empty', '-m', 'base');
      git(a, 'push', '-q', 'origin', branch);
      const read = git(a, 'rev-parse', 'HEAD');
      git(b, 'fetch', '-q', 'origin', branch);
      git(b, 'checkout', '-q', '-b', branch, 'FETCH_HEAD');
      git(b, 'commit', '-q', '--allow-empty', '-m', 'B');
      git(b, 'push', '-q', 'origin', branch);
      expect(deleteRemoteBranchWithLease(a, 'origin', branch, read)).toBe(false);
      const remote = spawnSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: a, encoding: 'utf8', windowsHide: true }).stdout;
      expect(remote.split(/\s+/)[0]).toBe(git(b, 'rev-parse', 'HEAD'));
      expect(deleteRemoteBranchWithLease(a, 'origin', branch, git(b, 'rev-parse', 'HEAD'))).toBe(true);
      expect(spawnSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: a, encoding: 'utf8', windowsHide: true }).stdout.trim()).toBe('');
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
