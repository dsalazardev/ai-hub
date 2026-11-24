import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRunEvent,
  cmdRuns,
  pruneRuns,
  readRunEvents,
  retentionPlan,
  RUN_SCHEMA_VERSION,
  runVersion,
  RunVersionError,
  validateRunEvent,
} from '../src/harness/runs.js';
import type { CliContext } from '../src/cli/types.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-runs2-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(run: string, lines: object[]): Promise<string> {
  const file = path.join(root, '.ai-hub', 'runs', run, 'events.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

function ctx(out: string[], err: string[]): CliContext {
  return { cwd: root, root, source: null, io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) } } as unknown as CliContext;
}

describe('runs v2 (3.12, R-043, R-045, R-106, R-110)', () => {
  it('escribe v2 con note_type guard y health, harness, origen y enlaces', async () => {
    await appendRunEvent(root, { ts: '2026-11-23T10:00:00.000Z', run: 'r1', kind: 'note', note_type: 'guard', origin: 'hook' });
    await appendRunEvent(root, {
      ts: '2026-11-23T10:00:01.000Z',
      run: 'r1',
      kind: 'note',
      note_type: 'health',
      failure_class: 'http_5xx',
      http_status: 503,
      harness: 'claude',
      harness_version: '2.1.330',
      links: { issue: 42, change_request: 7, commit: 'abcdef1' },
    });
    const events = await readRunEvents(root, 'r1');
    expect(events.map((event) => event.v)).toEqual([RUN_SCHEMA_VERSION, RUN_SCHEMA_VERSION]);
    expect(events[1]).toMatchObject({ failure_class: 'http_5xx', http_status: 503, links: { issue: 42 } });
  });

  it('no existe campo para la salida capturada: se rechaza', async () => {
    await expect(validateRunEvent(root, { ts: '2026-11-23T10:00:00.000Z', run: 'r1', kind: 'step', stdout: 'x' } as never)).rejects.toThrow(/stdout/);
    const out: string[] = [];
    const err: string[] = [];
    expect(await cmdRuns({ positionals: ['event'], flags: { run: 'r1', kind: 'step', output: 'x' } }, ctx(out, err))).toBe(2);
    expect(err.join('\n')).toContain('--output');
  });

  it('lee v1 de 0.17.0 sin reescribirlo', async () => {
    const file = await seed('20261101-000000Z-aaaaaa', [{ v: 1, ts: '2026-11-01T00:00:00.000Z', run: '20261101-000000Z-aaaaaa', kind: 'start' }, { v: 1, ts: '2026-11-01T00:00:01.000Z', run: '20261101-000000Z-aaaaaa', kind: 'status', state: 'CONVERGED' }]);
    const before = await fs.readFile(file);
    expect((await readRunEvents(root, '20261101-000000Z-aaaaaa')).map((event) => event.state)).toEqual([undefined, 'CONVERGED']);
    const out: string[] = [];
    expect(await cmdRuns({ positionals: ['list'], flags: {} }, ctx(out, []))).toBe(0);
    await pruneRuns(root, 10);
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('un run de versión futura no se poda ni se amplía, y se informa', async () => {
    const file = await seed('20200101-000000Z-ffffff', [{ v: 3, ts: '2020-01-01T00:00:00.000Z', run: '20200101-000000Z-ffffff', kind: 'start', nuevo: true }]);
    const before = await fs.readFile(file);
    await seed('20261101-000000Z-aaaaaa', [{ v: 2, ts: '2026-11-01T00:00:00.000Z', run: '20261101-000000Z-aaaaaa', kind: 'start' }]);
    expect(await pruneRuns(root, 1)).toEqual(['20261101-000000Z-aaaaaa']);
    await expect(appendRunEvent(root, { ts: '2026-11-23T00:00:00.000Z', run: '20200101-000000Z-ffffff', kind: 'end' })).rejects.toBeInstanceOf(RunVersionError);
    expect(await fs.readFile(file)).toEqual(before);
    const out: string[] = [];
    await cmdRuns({ positionals: ['list'], flags: {} }, ctx(out, []));
    expect(out.join('\n')).toContain('versión más nueva (v3)');
  });

  it('run mixto: la versión es la más alta de sus líneas y no se le añade nada', async () => {
    await seed('mix', [{ v: 2, ts: '2026-11-01T00:00:00.000Z', run: 'mix', kind: 'start' }, { v: 3, ts: '2026-11-01T00:00:01.000Z', run: 'mix', kind: 'step' }]);
    expect(await runVersion(root, 'mix')).toBe(3);
    await expect(appendRunEvent(root, { ts: '2026-11-23T00:00:00.000Z', run: 'mix', kind: 'end' })).rejects.toThrow(/más nueva/);
  });

  it('retención por el primer evento: un session-* antiguo se poda primero', async () => {
    await seed('session-abc', [{ v: 1, ts: '2026-01-01T00:00:00.000Z', run: 'session-abc', kind: 'start' }]);
    await seed('20261101-000000Z-aaaaaa', [{ v: 2, ts: '2026-11-01T00:00:00.000Z', run: '20261101-000000Z-aaaaaa', kind: 'start' }]);
    expect(await pruneRuns(root, 2)).toEqual(['session-abc']);
  });

  it('los runs nuevos y los ilegibles no consumen la cuota', async () => {
    await seed('a-newer-1', [{ v: 9, ts: '2020-01-01T00:00:00.000Z', run: 'a-newer-1', kind: 'start' }]);
    await seed('a-newer-2', [{ v: 9, ts: '2020-01-01T00:00:01.000Z', run: 'a-newer-2', kind: 'start' }]);
    await fs.mkdir(path.join(root, '.ai-hub', 'runs', 'roto'), { recursive: true });
    for (let i = 1; i <= 4; i += 1) {
      await seed(`2026110${i}-000000Z-bbbbbb`, [{ v: 2, ts: `2026-11-0${i}T00:00:00.000Z`, run: `2026110${i}-000000Z-bbbbbb`, kind: 'start' }]);
    }
    const plan = await retentionPlan(root);
    expect(plan.newer).toEqual(['a-newer-1', 'a-newer-2']);
    expect(plan.unreadable).toEqual(['roto']);
    expect(await pruneRuns(root, 3)).toEqual(['20261101-000000Z-bbbbbb', '20261102-000000Z-bbbbbb']);
  });
});
