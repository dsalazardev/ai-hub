import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consumeGrant, revokeGrant, verifyGrantForRun, type RunClaim } from '../src/control/grants.js';
import { setRequestStatus, submitRequest, type ExecutionRequestInput } from '../src/control/requests.js';
import { statePath } from '../src/harness/state-store.js';

/** Concesiones en el runner (5.8, 5.9; R-093, R-094, R-045) con dobles: ningún harness real. */

const NOW = new Date('2026-11-23T12:00:00.000Z');
const APPROVER = '123456789012345678';
const SEAL = 'f'.repeat(64);
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-grants-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const input = (overrides: Partial<ExecutionRequestInput> = {}): ExecutionRequestInput => ({
  project: 'grp/demo',
  iid: 42,
  summary: 'implementar la exportación',
  worktree: '.worktrees/42-exportacion',
  effects: ['edit:src/**', 'shell:npm test'],
  base: 'a'.repeat(40),
  seal: SEAL,
  limits: { maxMinutes: 30 },
  expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  ...overrides,
});

async function approved(overrides: Partial<ExecutionRequestInput> = {}): Promise<string> {
  const request = await submitRequest(root, input(overrides), NOW);
  await setRequestStatus(root, request.id, 'approved', APPROVER, NOW);
  return request.id;
}

const claim = (grantId: string, overrides: Partial<RunClaim> = {}): RunClaim => ({
  iid: 42,
  grantId,
  project: 'grp/demo',
  worktree: '.worktrees/42-exportacion',
  effects: ['edit:src/**'],
  seal: SEAL,
  approvers: [APPROVER],
  now: NOW,
  ...overrides,
});

describe('verificación de la concesión por el runner (5.8, R-093)', () => {
  it('una concesión aprobada, vigente y dentro de su alcance se acepta', async () => {
    expect(await verifyGrantForRun(root, claim(await approved()))).toMatchObject({ ok: true });
  });

  it.each([
    ['falsificada', async () => claim('b'.repeat(64)), 'grant_invalid'],
    ['aprobador no autorizado', async () => claim(await approved(), { approvers: ['999'] }), 'grant_unauthorized'],
    ['efectos ampliados', async () => claim(await approved(), { effects: ['edit:src/**', 'shell:rm -rf build'] }), 'grant_effects'],
    ['otro proyecto', async () => claim(await approved(), { project: 'otro/proyecto' }), 'grant_scope'],
    ['otro worktree', async () => claim(await approved(), { worktree: '.worktrees/otro' }), 'grant_scope'],
    ['caducada', async () => claim(await approved(), { now: new Date(NOW.getTime() + 2 * 3_600_000) }), 'grant_expired'],
    ['concesión válida con sello inválido', async () => claim(await approved(), { seal: 'e'.repeat(64) }), 'grant_seal'],
  ])('%s → %s', async (_name, build, reason) => {
    expect(await verifyGrantForRun(root, await build())).toMatchObject({ ok: false, reason });
  });

  it('sello válido con concesión inválida (pendiente, sin aprobar) y spec aprobada sin concesión: rechazadas', async () => {
    const pending = await submitRequest(root, input(), NOW);
    expect(await verifyGrantForRun(root, claim(pending.id))).toMatchObject({ ok: false, reason: 'grant_invalid' });
    expect(await verifyGrantForRun(root, claim('c'.repeat(64), { iid: 7 }))).toMatchObject({ ok: false, reason: 'grant_invalid' });
  });

  it('revocada: rechazada', async () => {
    const id = await approved();
    expect(await revokeGrant(root, id, NOW)).toBe('revoked');
    expect(await verifyGrantForRun(root, claim(id))).toMatchObject({ ok: false, reason: 'grant_revoked' });
  });

  it('petición modificada después de aprobarse: su hash ya no coincide', async () => {
    const id = await approved();
    const file = statePath(root, 'grants');
    const doc = JSON.parse(await fs.readFile(file, 'utf8')) as { records: Record<string, { summary: string }> };
    doc.records[id].summary = 'otra cosa';
    await fs.writeFile(file, JSON.stringify(doc));
    expect(await verifyGrantForRun(root, claim(id))).toMatchObject({ ok: false, reason: 'grant_modified' });
  });

  it('registro ilegible o de una versión más nueva: ninguna concesión es válida y los bytes se conservan', async () => {
    const id = await approved();
    const file = statePath(root, 'grants');
    await fs.writeFile(file, '{ roto');
    expect(await verifyGrantForRun(root, claim(id))).toMatchObject({ ok: false, reason: 'grant_registry' });
    expect(await fs.readFile(file, 'utf8')).toBe('{ roto');
    await fs.writeFile(file, JSON.stringify({ v: 99, records: {} }));
    expect(await verifyGrantForRun(root, claim(id))).toMatchObject({ ok: false, reason: 'grant_registry' });
  });
});

describe('consumo exclusivo y revocación coordinada (5.9, R-094)', () => {
  it('reproducir tras consumir se rechaza nombrando el run; el mismo run reanuda', async () => {
    const id = await approved();
    expect(await consumeGrant(root, claim(id), 'run-a')).toMatchObject({ ok: true });
    expect(await consumeGrant(root, claim(id), 'run-a')).toMatchObject({ ok: true });
    const replay = await consumeGrant(root, claim(id), 'run-b');
    expect(replay).toMatchObject({ ok: false, reason: 'grant_consumed' });
    expect(JSON.stringify(replay)).toContain('run-a');
  });

  it('dos runners a la vez: un único registro de consumo', async () => {
    const id = await approved();
    const results = await Promise.all([consumeGrant(root, claim(id), 'run-a'), consumeGrant(root, claim(id), 'run-b')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const doc = JSON.parse(await fs.readFile(statePath(root, 'grants'), 'utf8')) as { records: Record<string, { status: string; consumedBy: string }> };
    expect(doc.records[id].status).toBe('consumed');
  });

  it('carrera revocación-consumo: un único ganador', async () => {
    const id = await approved();
    const [consumed, revoked] = await Promise.all([consumeGrant(root, claim(id), 'run-a'), revokeGrant(root, id, NOW)]);
    expect(consumed.ok !== (revoked === 'revoked')).toBe(true);
    const status = (JSON.parse(await fs.readFile(statePath(root, 'grants'), 'utf8')) as { records: Record<string, { status: string }> }).records[id].status;
    expect(status).toBe(consumed.ok ? 'consumed' : 'revoked');
  });

  it('un registro de consumo ilegible se trata como consumido', async () => {
    const id = await approved();
    await fs.writeFile(statePath(root, 'grants'), '{ roto');
    expect(await consumeGrant(root, claim(id), 'run-a')).toMatchObject({ ok: false, reason: 'grant_registry' });
  });
});
