import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli/run.js';
import { runHook } from '../src/cli/hook.js';
import { ENGINE_COUNTS, loadEngine, type EngineManifest } from '../src/engine/engine.js';
import { loadCatalogBaseline } from '../src/engine/references.js';
import { materializeHarnessLocal } from '../src/harness/local.js';
import {
  appendRunEvent,
  listRuns,
  pruneRuns,
  readRunEvents,
  RunValidationError,
  startRun,
  type RunEvent,
} from '../src/harness/runs.js';
import { computeTick, runTick } from '../src/control/tick.js';
import { featureSeal } from '../src/speckit/seal.js';
import type { FetchLike } from '../src/env/doctor.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { seedFixture } from './fixtures.js';
import { writeInventory } from '../src/manifest/manifest.js';

/** Centinela (PD-1): jamás debe aparecer en `.ai-hub/runs/`. */
const SENTINEL = 'AIHUB_TEST_SENTINEL_5b8d2c44';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-state-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function cli(argv: string[], cwd = root): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd, io, exec: fakeRunner().run });
  return { code, out: out.join('\n') };
}

async function consumer(): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  const result = await cli(['init', '--preset-only', '--yes']);
  expect(result.code, result.out).toBe(0);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function treeHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await fs.readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  for (const file of entries) {
    hash.update(path.relative(dir, file));
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex');
}

describe('consumer state (4.2, PD-2)', () => {
  it('init materializes work/, lessons.md and runs/; install keeps edited lessons', async () => {
    await consumer();
    expect(await exists(path.join(root, '.ai-hub', 'work', '.gitkeep'))).toBe(true);
    expect(await fs.readFile(path.join(root, '.ai-hub', 'lessons.md'), 'utf8')).toContain('# Lecciones del proyecto');
    expect(await exists(path.join(root, '.ai-hub', 'runs'))).toBe(true);
    const lessons = path.join(root, '.ai-hub', 'lessons.md');
    await fs.appendFile(lessons, '\n- 2026-11-08 · implement: regla del proyecto\n');
    const edited = await fs.readFile(lessons, 'utf8');
    expect((await cli(['install', '--yes', '--no-speckit'])).code).toBe(0);
    expect(await fs.readFile(lessons, 'utf8')).toBe(edited);
  });

  it('the work directory follows the resolved harness directory', async () => {
    const harness = path.join(root, 'apps', 'factory');
    await fs.mkdir(harness, { recursive: true });
    const written = await materializeHarnessLocal(harness);
    expect(written).toContain('.ai-hub/work/.gitkeep');
    expect(await exists(path.join(harness, '.ai-hub', 'lessons.md'))).toBe(true);
    expect(await exists(path.join(root, '.ai-hub'))).toBe(false);
  });
});

describe('role scopes off .planning/ (4.3, G-03)', () => {
  it('no engine role scope references .planning/; reviewers write in .ai-hub/work', async () => {
    const engine = await loadEngine();
    const scopes = engine.roles.flatMap((role) => role.can_modify);
    expect(scopes.filter((scope) => scope.includes('.planning'))).toEqual([]);
    const byId = Object.fromEntries(engine.roles.map((role) => [role.id, role.can_modify]));
    expect(byId['reviewer-architecture']).toEqual(['.ai-hub/work/**/review-arch.md']);
    expect(byId['reviewer-tests']).toEqual(['.ai-hub/work/**/review-tests.md']);
    expect(byId['spec-author']).toEqual(['.specify/**', 'specs/**', '.ai-hub/work/**']);
  });

  it('the dated baseline no longer carries any G-03 exception', async () => {
    const baseline = await loadCatalogBaseline();
    expect(baseline.entries.filter((entry) => entry.kind === 'planning')).toEqual([]);
  });
});

describe('runs: closed schema, one writer (4.5)', () => {
  it('an unknown field is rejected and nothing is written', async () => {
    const result = await cli(['runs', 'event', '--run', 'r1', '--kind', 'step', '--prompt', 'hola']);
    expect(result.code).toBe(2);
    expect(result.out).toContain('campo desconocido');
    expect(await exists(path.join(root, '.ai-hub', 'runs'))).toBe(false);
    const event = { v: 1, ts: new Date().toISOString(), run: 'r1', kind: 'step', prompt: 'x' } as unknown as RunEvent;
    await expect(appendRunEvent(root, event)).rejects.toBeInstanceOf(RunValidationError);
  });

  it('content, secrets, env values and unknown states never persist', async () => {
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `GITLAB_TOKEN=${SENTINEL}\n`, 'utf8');
    const run = await startRun(root, 'implement');
    const rejected = [
      ['runs', 'note', '--run', run, '--type', 'decision', '--text', `usé ${SENTINEL}`],
      ['runs', 'note', '--run', run, '--type', 'warn', '--text', 'glpat-abcdefghijklmnopqrst'],
      ['runs', 'event', '--run', run, '--kind', 'status', '--state', 'SHIPPED'],
      ['runs', 'event', '--run', run, '--kind', 'step', '--artifact', '../../etc/passwd'],
    ];
    for (const argv of rejected) {
      const result = await cli(argv);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.out).not.toContain(SENTINEL);
    }
    const multiline = { v: 1, ts: new Date().toISOString(), run, kind: 'note', note_type: 'decision', note: 'a\nb' } as RunEvent;
    await expect(appendRunEvent(root, multiline)).rejects.toBeInstanceOf(RunValidationError);
    expect((await cli(['runs', 'event', '--run', run, '--kind', 'status', '--state', 'CONVERGED', '--artifact', 'specs/001-a/tasks.md'])).code).toBe(0);
    expect((await cli(['runs', 'event', '--run', run, '--from-status', 'texto libre que no es una línea de estado'])).code).toBe(0);
    const events = await readRunEvents(root, run);
    expect(events.at(-1)).toMatchObject({ kind: 'status', reason_code: 'invalid_status' });
    expect(JSON.stringify(events)).not.toContain('texto libre');
    const all = await fs.readdir(path.join(root, '.ai-hub', 'runs'), { recursive: true });
    for (const rel of all) {
      const file = path.join(root, '.ai-hub', 'runs', rel);
      if ((await fs.stat(file)).isFile()) {
        const text = await fs.readFile(file, 'utf8');
        expect(text).not.toContain(SENTINEL);
        expect(text).not.toMatch(/"(prompt|response|content|env|token)"/);
      }
    }
  });
});

describe('runs retention (4.6)', () => {
  it('a new run prunes the oldest beyond the default 50', async () => {
    for (let i = 0; i < 50; i += 1) {
      const id = `20260101-0000${String(i).padStart(2, '0')}Z-aaaaaa`;
      await fs.mkdir(path.join(root, '.ai-hub', 'runs', id), { recursive: true });
    }
    await fs.mkdir(path.join(root, '.ai-hub', 'runs', 'scope'), { recursive: true });
    const run = await startRun(root);
    const runs = await listRuns(root);
    expect(runs).toHaveLength(50);
    expect(runs).not.toContain('20260101-000000Z-aaaaaa');
    expect(runs).toContain(run);
    expect(await exists(path.join(root, '.ai-hub', 'runs', 'scope'))).toBe(true);
    expect(await pruneRuns(root, 50)).toEqual(['20260101-000001Z-aaaaaa']);
  });
});

describe('hooks record the session run (4.7)', () => {
  it('stop records the end with a duration under the session run', async () => {
    await consumer();
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc' });
    expect((await runHook('stop', payload, root)).output).toEqual({});
    const events = await readRunEvents(root, 'session-abc');
    expect(events.map((event) => event.kind)).toEqual(['start', 'end']);
    expect(typeof events[1].duration_ms).toBe('number');
  });
});

describe('control tick --dry-run (4.8, 4.9)', () => {
  const sealed = { 'spec.md': '# Demo\n', 'plan.md': '# Plan\n', 'tasks.md': '- [ ] T001 Demo\n' };

  async function feature(name: string): Promise<void> {
    const dir = path.join(root, 'specs', name);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(sealed)) {
      await fs.writeFile(path.join(dir, file), content, 'utf8');
    }
  }

  async function status(run: string, state: string, feature: string): Promise<void> {
    await appendRunEvent(root, { v: 1, ts: new Date().toISOString(), run, kind: 'status', state, artifact: `specs/${feature}/tasks.md` });
  }

  it('proposes by exit_effects, revalidates the seal, applies max_rounds and lists human approvals', async () => {
    await consumer();
    for (const name of ['001-conv', '002-ready', '003-tampered', '004-loop', '005-kill']) {
      await feature(name);
    }
    const run = await startRun(root);
    await status(run, 'CONVERGED', '001-conv');
    for (let i = 0; i < 3; i += 1) {
      await status(run, 'NEEDS_WORK', '004-loop');
    }
    await status(run, 'KILL', '005-kill');
    await appendRunEvent(root, { v: 1, ts: new Date().toISOString(), run, kind: 'note', note_type: 'awaiting-ok', step: 'ship' });
    const good = await featureSeal(root, 'specs/002-ready');
    await fs.writeFile(
      path.join(root, 'labels.json'),
      JSON.stringify([
        { feature: '001-conv', iid: 1, labels: ['ai::in-dev'] },
        { feature: '002-ready', iid: 2, labels: ['ai::spec-ready'], approvedHash: good },
        { feature: '003-tampered', iid: 3, labels: ['ai::spec-ready'], approvedHash: '0'.repeat(64) },
        { feature: '004-loop', iid: 4, labels: ['ai::in-dev'] },
        { feature: '005-kill', iid: 5, labels: ['ai::in-spec'] },
      ]),
    );
    const before = await treeHash(root);
    const result = await cli(['control', 'tick', '--dry-run', '--json', '--labels-from', 'labels.json']);
    expect(result.code).toBe(0);
    expect(await treeHash(root)).toBe(before);
    const parsed = JSON.parse(result.out) as { proposals: Array<Record<string, unknown>>; pendingHuman: Array<{ kind: string; ref: string }> };
    const byFeature = Object.fromEntries(parsed.proposals.map((item) => [item.feature, item]));
    expect(byFeature['001-conv']).toMatchObject({ current: 'ai::in-dev', proposed: 'ai::in-review' });
    expect(byFeature['002-ready']).toMatchObject({ proposed: 'ai::in-dev', seal: 'ok' });
    expect(byFeature['003-tampered']).toMatchObject({ proposed: 'ai::blocked', seal: 'mismatch' });
    expect(byFeature['004-loop']).toMatchObject({ proposed: 'ai::blocked', rounds: 3, reason: 'max_rounds (3/3)' });
    expect(byFeature['005-kill']).toMatchObject({ proposed: 'ai::done', human: true });
    expect(parsed.pendingHuman.map((item) => item.kind).sort()).toEqual(['awaiting-ok', 'closing']);
    for (const item of parsed.proposals) {
      expect(item.proposed === 'ai::spec-ready' && item.current !== 'ai::spec-ready').toBe(false);
    }
  });

  it('never proposes ai::spec-ready even if an effect pointed there', () => {
    const engine = {
      labels: ['ai::in-spec', 'ai::spec-ready'],
      exit_effects: { DONE: 'ai::spec-ready' },
    } as unknown as EngineManifest;
    const result = computeTick(engine, {
      features: ['001'],
      issues: [{ feature: '001', labels: ['ai::in-spec'] }],
      latest: { '001': 'DONE' },
      rounds: {},
      seals: {},
      awaitingOk: [],
      maxRounds: 3,
    });
    expect(result.proposals[0].proposed).toBe('ai::in-spec');
    expect(result.proposals[0].reason).toContain('solo lo aprueba un humano');
  });

  it('refuses without --dry-run and makes no network call without --online', async () => {
    await consumer();
    const refused = await cli(['control', 'tick']);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain('hermes-control');
    const calls: string[] = [];
    const spy: FetchLike = async (url) => {
      calls.push(url);
      return { status: 200, json: async () => ({}) };
    };
    await runTick(root, { fetch: spy });
    expect(calls).toEqual([]);
  });
});

describe('narrator without a new role (4.10)', () => {
  it('ships as an agent of the base preset and the role count is unchanged', async () => {
    const engine = await loadEngine();
    expect(engine.roles).toHaveLength(ENGINE_COUNTS.roles);
    expect(engine.roles.some((role) => role.id === 'narrator' || role.canonical === 'narrator')).toBe(false);
    await consumer();
    const agent = await fs.readFile(path.join(root, '.claude', 'agents', 'narrator.md'), 'utf8');
    expect(agent).toContain('Write: nothing');
    expect(agent).toContain('.ai-hub/work/<feature>/report.md');
  });
});

describe('lessons rule (4.11)', () => {
  it('reaches the five targets with each rule shape; no lessons, no rule', async () => {
    await seedFixture(root);
    await writeInventory(root);
    expect((await cli(['sync'])).code).toBe(0);
    expect(await exists(path.join(root, '.claude', 'rules', 'ai-hub-lessons.md'))).toBe(false);
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', 'lessons.md'), '# Lecciones\n\n- 2026-11-08 · gate: corre los tests antes de cerrar.\n');
    expect((await cli(['sync'])).code).toBe(0);
    for (const rel of [
      '.claude/rules/ai-hub-lessons.md',
      '.opencode/rules/ai-hub-lessons.md',
      '.pi/prompts/ai-hub-lessons.md',
      '.cursor/rules/ai-hub-lessons.mdc',
      '.github/instructions/ai-hub-lessons.instructions.md',
    ]) {
      expect(await fs.readFile(path.join(root, ...rel.split('/')), 'utf8'), rel).toContain('corre los tests antes de cerrar');
    }
  });
});
