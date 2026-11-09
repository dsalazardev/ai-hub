import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { setControlDeps } from '../src/control/cli.js';
import { candidateFor, runDecide } from '../src/control/decide.js';
import { decisionId, readDecisions, CONTROL_DIR } from '../src/control/ledger.js';
import { renderDiscord, MESSAGE_LIMIT, type DecisionView } from '../src/control/render.js';
import { computeTick, effectFor, runTick } from '../src/control/tick.js';
import { loadEngine } from '../src/engine/engine.js';
import { appendRunEvent, pruneRuns } from '../src/harness/runs.js';
import { featureSeal } from '../src/speckit/seal.js';
import { fakeRunner } from './speckit-fake.js';
import { BOT_ID, HUMAN_ID, TOKEN_SENTINEL, fakeGitlab, writes, type FakeGitlab, type FakeIssue } from './control-fake.js';

/** hermes-control: consumidor sintético, GitLab falso que graba peticiones y token centinela. */

const NOW = new Date('2026-11-09T09:00:00.000Z');
const TEMPLATES = path.resolve(__dirname, '..', 'engine', 'templates', 'hermes');
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-control-'));
});

afterEach(async () => {
  setControlDeps({});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CONTROL_BLOCK = ['control:', '  approvers:', '    - "123456789012345678"', '  ttlHours: 24', '  expire: block', ''].join('\n');
const TRACKER_BLOCK = ['tracker:', '  kind: gitlab', '  urlEnv: GITLAB_URL', '  tokenEnv: GITLAB_TOKEN', ''].join('\n');

async function consumer(options: { control?: boolean } = {}): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  const init = await cli(['init', '--preset-only', '--yes']);
  expect(init.code, init.out + init.err).toBe(0);
  const manifest = path.join(root, 'manifest.yaml');
  await fs.appendFile(manifest, `${TRACKER_BLOCK}${options.control === false ? '' : CONTROL_BLOCK}`);
  await fs.writeFile(
    path.join(root, '.ai-hub', '.env'),
    `GITLAB_URL=https://gitlab.example.test\nGITLAB_TOKEN=${TOKEN_SENTINEL}\nGITLAB_PROJECT_PATH=grp/demo\n`,
  );
}

async function feature(name: string, files: Record<string, string> = {}): Promise<void> {
  const dir = path.join(root, 'specs', name);
  await fs.mkdir(dir, { recursive: true });
  const contents = { 'spec.md': `# ${name}\n`, 'plan.md': '# Plan\n', 'tasks.md': '- [ ] T001 Demo\n', ...files };
  for (const [file, text] of Object.entries(contents)) {
    await fs.writeFile(path.join(dir, file), text);
  }
}

async function status(featureName: string, state: string, run = '20261109-090000Z-aaaaaa'): Promise<void> {
  await appendRunEvent(root, { v: 1, ts: NOW.toISOString(), run, kind: 'status', state, artifact: `specs/${featureName}/tasks.md` });
}

function issue(iid: number, featureName: string | null, label: string, extra: Partial<FakeIssue> = {}): FakeIssue {
  return {
    iid,
    title: `Issue ${iid}`,
    labels: [label],
    description: featureName ? `Contexto.\n\nai-hub:feature=${featureName}\n` : 'Sin marcador.',
    notes: [],
    ...extra,
  };
}

async function ledgerText(): Promise<string> {
  return fs.readFile(path.join(root, CONTROL_DIR, 'decisions.jsonl'), 'utf8').catch(() => '');
}

function use(gitlab: FakeGitlab): void {
  setControlDeps({ trackerFetch: gitlab.fetch, now: () => NOW });
}

describe('fase 1 — tick lee el tablero (1.2, 1.3)', () => {
  it('lists ai:: issues with GET only and maps them by the marker', async () => {
    await consumer();
    for (const name of ['001-alpha', '002-beta', '003-gamma']) {
      await feature(name);
    }
    const gitlab = fakeGitlab([
      issue(1, '001-alpha', 'ai::in-spec'),
      issue(2, '002-beta', 'ai::in-dev'),
      issue(3, '003-gamma', 'ai::todo'),
      issue(4, null, 'ai::in-spec'),
      { ...issue(5, null, 'bug'), labels: ['bug'] },
    ]);
    const result = await runTick(root, { online: true, trackerFetch: gitlab.fetch });
    expect(gitlab.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(result.proposals.map((item) => item.iid).sort()).toEqual([1, 2, 3]);
    expect(result.unmapped).toEqual([4]);
    expect(gitlab.requests.every((request) => request.headers['PRIVATE-TOKEN'] === TOKEN_SENTINEL)).toBe(true);
    expect(gitlab.requests.some((request) => request.path.includes(TOKEN_SENTINEL))).toBe(false);
  });

  it('reads the approved hash only from the control plane note', async () => {
    await consumer();
    await feature('001-alpha');
    const seal = await featureSeal(root, 'specs/001-alpha');
    const foreign = issue(1, '001-alpha', 'ai::spec-ready', {
      notes: [{ id: 1, body: `aprobado: ai-hub:approved-hash=${seal}`, authorId: HUMAN_ID }],
    });
    const gitlab = fakeGitlab([foreign]);
    const ignored = await runTick(root, { online: true, trackerFetch: gitlab.fetch });
    // El hash pegado por otra persona no cuenta: sin aprobación, la issue no avanza a desarrollo.
    expect(ignored.proposals[0].seal).toBe('not-needed');
    expect(ignored.proposals[0].proposed).toBe('ai::spec-ready');
    foreign.notes.push({ id: 2, body: `ai-hub:approved-hash=${seal}`, authorId: BOT_ID });
    const accepted = await runTick(root, { online: true, trackerFetch: fakeGitlab([foreign]).fetch });
    expect(accepted.proposals[0].seal).toBe('ok');
    expect(accepted.proposals[0].proposed).toBe('ai::in-dev');
  });
});

describe('fase 1 — manifest.control (1.4)', () => {
  it('an unknown property fails naming it; without the block decide exits 2 and doctor has no control line', async () => {
    await consumer({ control: false });
    const before = await cli(['doctor']);
    const decide = await cli(['control', 'decide', '--online']);
    expect(decide.code).toBe(2);
    expect(decide.err).toContain('manifest.control');
    // Fase 4 (4.4, por instrucción del propietario): sin bloque, "no configurado" en [OK], sin degradar.
    expect(before.out).toMatch(/^\[OK\]\s+control: no configurado/m);
    expect(before.code).toBe(1); // degradado solo por --no-speckit del fixture, como en 0.11.0
    await fs.appendFile(path.join(root, 'manifest.yaml'), 'control:\n  approverz: []\n');
    const bad = await cli(['doctor']);
    expect(bad.code).toBe(1);
    expect(bad.out + bad.err).toContain('approverz');
  });
});

describe('fase 1 — decisiones deterministas (1.5, 1.6)', () => {
  it('same input gives the same id; changed input supersedes; retention keeps control/', async () => {
    await consumer();
    await feature('001-alpha');
    await status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    const first = await runDecide(root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    expect(first.fresh).toHaveLength(1);
    const again = await runDecide(root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    expect(again.fresh).toHaveLength(0);
    const id = first.fresh[0].decision.id;
    expect(id).toBe(
      decisionId({ kind: 'transition', iid: 7, from: 'ai::in-dev', to: 'ai::in-review', state: 'CONVERGED', source: 'local', seal: first.fresh[0].decision.seal }),
    );
    await status('001-alpha', 'NEEDS_WORK', '20261109-090100Z-bbbbbb');
    await status('001-alpha', 'BLOCKED', '20261109-090200Z-cccccc');
    const changed = await runDecide(root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    expect(changed.fresh).toHaveLength(1);
    const decisions = await readDecisions(root);
    expect(decisions.get(id)?.status).toBe('superseded');
    await pruneRuns(root, 1);
    expect(await ledgerText()).toContain(id);
  });

  it('decide derives the target and the human flag from exit_effects (D0)', async () => {
    const engine = await loadEngine();
    for (const state of Object.keys(engine.exit_effects)) {
      const effect = effectFor(engine, state, 'ai::in-dev');
      const { proposals } = computeTick(engine, {
        features: ['001-x'],
        issues: [{ feature: '001-x', iid: 1, labels: ['ai::in-dev'] }],
        latest: { '001-x': state },
        rounds: {},
        seals: { '001-x': null },
        awaitingOk: [],
        maxRounds: 3,
      });
      const candidate = candidateFor(proposals[0], null, undefined);
      if (effect.label === 'ai::in-dev' || effect.label === null) {
        expect(candidate, state).toBeNull();
      } else {
        expect(candidate?.to, state).toBe(effect.label);
        expect(candidate?.kind === 'closing', state).toBe(effect.human);
      }
    }
  });
});

describe('fase 1 — mensaje de Discord (1.7)', () => {
  function view(evidence = 1): DecisionView {
    return {
      decision: {
        id: '3f9c2a71d0e4b5a6c7d8e9f00112233445566778899aabbccddeeff001122334',
        kind: 'transition',
        iid: 42,
        feature: '001-recurring-invoices',
        from: 'ai::in-dev',
        to: 'ai::in-review',
        state: 'CONVERGED',
        source: 'local',
        seal: null,
        hash: '3f9c2a71d0e4b5a6c7d8e9f00112233445566778899aabbccddeeff001122334',
        createdAt: NOW.toISOString(),
        expiresAt: '2026-11-10T09:00:00.000Z',
        status: 'pending',
        updatedAt: NOW.toISOString(),
      },
      title: 'Facturas recurrentes',
      summary: 'estado CONVERGED',
      impact: 'la issue pasa a revisión; el motor deja de trabajar en ella',
      evidence: Array.from({ length: evidence }, (_, index) => ({
        text: `estado CONVERGED registrado para 001-recurring-invoices (${index})`,
        source: 'local (.ai-hub/runs, ai-hub control tick)',
      })),
    };
  }

  it('renders one decision with every field', () => {
    expect(renderDiscord(view(), 'block')).toMatchInlineSnapshot(`
      "[ai-hub] decision 3f9c2a71 | #42 "Facturas recurrentes" (001-recurring-invoices)
      Transicion: ai::in-dev -> ai::in-review
      Resumen:   estado CONVERGED
      Impacto:   la issue pasa a revisión; el motor deja de trabajar en ella
      Evidencia:
        - estado CONVERGED registrado para 001-recurring-invoices (0)
          fuente: local (.ai-hub/runs, ai-hub control tick)
      Opciones:  aprobar 42 3f9c2a71 | rechazar 42 <motivo> | detalle 42
      Expira:    2026-11-10T09:00Z (sin respuesta -> ai::blocked, approval_expired)"
    `);
  });

  it('stays under the Discord limit and sends the rest to detalle', () => {
    const text = renderDiscord(view(60), 'block');
    expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    for (const field of ['#42', 'Transicion:', 'Resumen:', 'Impacto:', 'Evidencia:', 'fuente:', 'aprobar 42', 'rechazar 42', 'detalle 42', 'Expira:']) {
      expect(text, field).toContain(field);
    }
    expect(text).toContain('evidencia completa: detalle 42');
  });
});

describe('fase 1 — control decide (1.8)', () => {
  it('second run prints nothing; the sentinel never leaks', async () => {
    await consumer();
    await feature('001-alpha');
    await status('001-alpha', 'CONVERGED');
    use(fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]));
    const first = await cli(['control', 'decide', '--online']);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('Transicion: ai::in-dev -> ai::in-review');
    const second = await cli(['control', 'decide', '--online']);
    expect(second.code).toBe(0);
    expect(second.out).toBe('');
    for (const text of [first.out, first.err, second.out, second.err, await ledgerText()]) {
      expect(text).not.toContain(TOKEN_SENTINEL);
    }
  });

  it('publishes the sealed spec for human approval with the seal as hash (§5)', async () => {
    await consumer();
    await feature('001-alpha');
    const seal = await featureSeal(root, 'specs/001-alpha');
    use(fakeGitlab([issue(3, '001-alpha', 'ai::in-spec')]));
    const result = await cli(['control', 'decide', '--online', '--format', 'json']);
    const [decision] = JSON.parse(result.out) as Array<{ kind: string; to: string; hash: string }>;
    expect(decision).toMatchObject({ kind: 'spec-approval', to: 'ai::spec-ready', hash: seal });
  });

  it('the tracker unreachable fails without secrets', async () => {
    await consumer();
    await feature('001-alpha');
    const gitlab = fakeGitlab([]);
    gitlab.failNext({ method: 'GET' }, 'network');
    use(gitlab);
    const result = await cli(['control', 'decide', '--online']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('el tracker no responde');
    expect(result.err).not.toContain(TOKEN_SENTINEL);
  });
});

describe('fase 1 — plantilla de cron (1.9)', () => {
  it('is portable, credential-free and calls only ai-hub', async () => {
    const text = await fs.readFile(path.join(TEMPLATES, 'control-poll.sh'), 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain('__AI_HUB_REPO__');
    expect(text).toContain('npx --no-install ai-hub control decide --online --format discord');
    expect(text).not.toMatch(/\bbash /);
    expect(text).not.toMatch(/\bcurl\b|\bglab\b|git push|TOKEN=/);
    expect(text).not.toMatch(/telegram/i);
  });
});

function issueEvent(iid: number, options: { userId?: number; labels?: string[]; changed?: boolean; projectPath?: string; updatedAt?: string } = {}): string {
  const labels = (options.labels ?? ['ai::in-dev']).map((title) => ({ title }));
  return JSON.stringify({
    object_kind: 'issue',
    event_type: 'issue',
    user: { id: options.userId ?? HUMAN_ID, username: 'persona' },
    project: { id: 77, path_with_namespace: options.projectPath ?? 'grp/demo' },
    object_attributes: { id: 9000 + iid, iid, action: 'update', updated_at: options.updatedAt ?? '2026-11-09 09:00:00 UTC' },
    labels,
    ...(options.changed ? { changes: { labels: { previous: [{ title: 'ai::in-dev' }], current: labels } } } : {}),
  });
}

describe('fase 2 — control ingest (2.1, 2.2)', () => {
  async function ingest(payload: string, format = 'json'): Promise<{ code: number; out: string; err: string }> {
    setControlDeps({ ...currentDeps, stdin: async () => payload });
    return cli(['control', 'ingest', '--format', format]);
  }
  let currentDeps: { trackerFetch: FakeGitlab['fetch']; now: () => Date };

  it('a duplicated event outputs nothing; a foreign project outputs nothing and exits 0', async () => {
    await consumer();
    await feature('001-alpha');
    await status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    currentDeps = { trackerFetch: gitlab.fetch, now: () => NOW };
    const first = await ingest(issueEvent(7), 'discord');
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('#7');
    const duplicate = await ingest(issueEvent(7), 'discord');
    expect(duplicate.code).toBe(0);
    expect(duplicate.out).toBe('');
    const foreign = await ingest(issueEvent(7, { projectPath: 'otro/proyecto', updatedAt: '2026-11-09 10:00:00 UTC' }));
    expect(foreign.code).toBe(0);
    expect(JSON.parse(foreign.out)).toMatchObject({ outcome: 'ignored', reason: 'foreign_project', decisions: [] });
    const pipeline = await ingest(JSON.stringify({ object_kind: 'pipeline' }));
    expect(JSON.parse(pipeline.out)).toMatchObject({ outcome: 'ignored', reason: 'event_kind' });
    expect(writes(gitlab.requests)).toEqual([]);
    for (const text of [first.out, first.err, duplicate.out, foreign.out, await ledgerText()]) {
      expect(text).not.toContain(TOKEN_SENTINEL);
    }
  });

  it('a manual label change supersedes pending decisions; the bot own change does not', async () => {
    await consumer();
    await feature('001-alpha');
    await status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    currentDeps = { trackerFetch: gitlab.fetch, now: () => NOW };
    const published = await runDecide(root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    const id = published.fresh[0].decision.id;
    const byBot = await ingest(issueEvent(7, { userId: BOT_ID, changed: true }));
    expect(JSON.parse(byBot.out).superseded).toEqual([]);
    gitlab.issues.get(7)!.labels = ['ai::blocked'];
    const byHuman = await ingest(issueEvent(7, { changed: true, labels: ['ai::blocked'], updatedAt: '2026-11-09 11:00:00 UTC' }));
    expect(JSON.parse(byHuman.out).superseded).toEqual([id]);
    expect((await readDecisions(root)).get(id)).toMatchObject({ status: 'superseded', reason: 'manual_label_change' });
  });
});

describe('fase 2 — plantilla de la ruta (2.3)', () => {
  const shell = spawnSync('sh', ['-c', 'exit 0']).status === 0;

  it.skipIf(!shell)('passes stdin to ingest and prints nothing for a duplicate', async () => {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin, { recursive: true });
    // Falso de npx: comprueba los argumentos y responde según el payload.
    await fs.writeFile(
      path.join(bin, 'npx'),
      '#!/bin/sh\n[ "$*" = "--no-install ai-hub control ingest --format discord" ] || exit 9\nif grep -q duplicado; then exit 0; fi\necho "[ai-hub] decision"\n',
      { mode: 0o755 },
    );
    const template = (await fs.readFile(path.join(TEMPLATES, 'gitlab-route.sh'), 'utf8')).replace('__AI_HUB_REPO__', root.replace(/\\/g, '/'));
    const script = path.join(root, 'gitlab-route.sh');
    await fs.writeFile(script, template, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    const fresh = spawnSync('sh', [script], { input: '{"object_kind":"issue"}', env, encoding: 'utf8' });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout.trim()).toBe('[ai-hub] decision');
    const duplicate = spawnSync('sh', [script], { input: '{"duplicado":true}', env, encoding: 'utf8' });
    expect(duplicate.status).toBe(0);
    expect(duplicate.stdout).toBe('');
    expect(template).not.toMatch(/\bbash |\bcurl\b|TOKEN=|telegram/i);
  });
});
