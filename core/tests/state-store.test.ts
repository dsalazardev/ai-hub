import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { danglingIndexEntries, HEALTH_FILE, readState, statePath, StateVersionError, updateState, type ExecutionIndexEntry } from '../src/harness/state-store.js';
import { pruneRuns } from '../src/harness/runs.js';
import { decisionId, ledgerBarrier, readDecisions, recordDecision, type Decision } from '../src/control/ledger.js';

let root: string;
const lock = { host: 'h', pid: 1, isAlive: (pid: number) => pid === 1, waitMs: 2000, pollMs: 5 };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-state-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function run(id: string, ts: string): Promise<void> {
  const dir = path.join(root, '.ai-hub', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify({ v: 2, ts, run: id, kind: 'start' })}\n`);
}

describe('estado duradero en su ubicación canónica (3.13, R-044, R-045)', () => {
  it('la poda de runs no toca asociaciones, índice, concesiones, ledger ni salud', async () => {
    await updateState<{ branch: string }>(root, 'associations', () => ({ '42': { branch: 'ai/42-x' } }), lock);
    await updateState<ExecutionIndexEntry>(root, 'execution-index', () => ({ r1: { run: '20260101-000000Z-aaaaaa', createdAt: 'x' } }), lock);
    await updateState(root, 'grants', () => ({ g1: { status: 'approved' } }), lock);
    await fs.writeFile(path.join(root, ...HEALTH_FILE.split('/')), '{"v":1}');
    await fs.writeFile(path.join(root, '.ai-hub', 'runs', 'control', 'decisions.jsonl'), '{"v":1}\n');
    await run('20260101-000000Z-aaaaaa', '2026-01-01T00:00:00.000Z');
    await run('20260102-000000Z-aaaaaa', '2026-01-02T00:00:00.000Z');
    expect(await pruneRuns(root, 1)).toEqual(['20260101-000000Z-aaaaaa', '20260102-000000Z-aaaaaa']);
    expect((await readState(root, 'associations')).records).toEqual({ '42': { branch: 'ai/42-x' } });
    expect(Object.keys((await readState(root, 'grants')).records)).toEqual(['g1']);
    expect(await fs.readFile(path.join(root, ...HEALTH_FILE.split('/')), 'utf8')).toBe('{"v":1}');
    expect(await fs.readFile(path.join(root, '.ai-hub', 'runs', 'control', 'decisions.jsonl'), 'utf8')).toBe('{"v":1}\n');
  });

  it('una entrada del índice cuyo run se podó se informa como colgante', async () => {
    await run('20260101-000000Z-aaaaaa', '2026-01-01T00:00:00.000Z');
    await updateState<ExecutionIndexEntry>(
      root,
      'execution-index',
      () => ({ a: { run: '20260101-000000Z-aaaaaa', createdAt: 'x' }, b: { run: '20251231-000000Z-zzzzzz', createdAt: 'x' } }),
      lock,
    );
    expect(await danglingIndexEntries(root)).toEqual(['20251231-000000Z-zzzzzz']);
  });

  it('un estado de versión más nueva se conserva sin limpieza y detiene con state_version_newer', async () => {
    const file = statePath(root, 'grants');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"v":2,"records":{"g":{"futuro":true}}}');
    await expect(readState(root, 'grants')).rejects.toBeInstanceOf(StateVersionError);
    await expect(updateState(root, 'grants', () => ({}), lock)).rejects.toThrow(/más nueva/);
    expect(await fs.readFile(file, 'utf8')).toBe('{"v":2,"records":{"g":{"futuro":true}}}');
  });
});

function decision(iid: number, to: string): Omit<Decision, 'updatedAt'> {
  const base = { kind: 'transition' as const, iid, from: 'ai::in-dev', to, state: 'CONVERGED', source: 'local' as const, seal: null };
  const id = decisionId(base);
  return { ...base, id, feature: '001-x', hash: id, createdAt: '2026-11-23T00:00:00.000Z', expiresAt: '2026-11-24T00:00:00.000Z', status: 'pending' };
}

async function appendRaw(line: object): Promise<void> {
  await fs.appendFile(path.join(root, '.ai-hub', 'runs', 'control', 'decisions.jsonl'), `${JSON.stringify(line)}\n`);
}

describe('barrera del ledger ante líneas más nuevas (3.27, D-66)', () => {
  it('una decisión pendiente v1 rechazada en v2 no se aplica ni aparece pendiente', async () => {
    const pending = decision(42, 'ai::in-review');
    await recordDecision(root, pending);
    expect((await readDecisions(root)).get(pending.id)?.status).toBe('pending');
    await appendRaw({ v: 2, ts: '2026-11-23T01:00:00.000Z', type: 'status', id: pending.id, status: 'rejected', motivo_nuevo: 'x' });
    expect((await readDecisions(root)).has(pending.id)).toBe(false);
    expect([...(await ledgerBarrier(root)).issues]).toEqual([42]);
  });

  it('una línea nueva de otra issue no detiene las demás', async () => {
    const other = decision(7, 'ai::in-review');
    await recordDecision(root, other);
    await appendRaw({ v: 2, ts: '2026-11-23T01:00:00.000Z', type: 'decision', decision: { id: 'n', iid: 42 } });
    const decisions = await readDecisions(root);
    expect(decisions.get(other.id)?.status).toBe('pending');
    expect((await ledgerBarrier(root)).project).toBe(false);
  });

  it('una línea nueva sin issue legible detiene todo el proyecto y se localiza', async () => {
    await recordDecision(root, decision(7, 'ai::in-review'));
    await appendRaw({ v: 2, ts: '2026-11-23T01:00:00.000Z', type: 'algo-nuevo' });
    expect((await readDecisions(root)).size).toBe(0);
    const barrier = await ledgerBarrier(root);
    expect(barrier).toMatchObject({ project: true, lines: [2] });
  });
});
