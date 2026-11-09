import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDecide } from '../src/control/decide.js';
import { CONTROL_DIR, readDecisions } from '../src/control/ledger.js';
import { parseReply } from '../src/control/reply.js';
import { runTick } from '../src/control/tick.js';
import { featureSeal } from '../src/speckit/seal.js';
import { fakeGitlab, writes, type FakeGitlab } from './control-fake.js';
import { APPROVER, NOW, TEMPLATES, TOKEN_SENTINEL, harness, issue, type Harness } from './control-harness.js';

/** hermes-control, fase 3: aprobaciones y escritura de etiquetas. */

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.dispose();
});

describe('fase 3 — gramática (3.1)', () => {
  it.each([
    ['aprobar 42 3f9c2a71', { verb: 'aprobar', iid: 42, hash: '3f9c2a71' }],
    ['APROBAR 42 3F9C2A71D0', { verb: 'aprobar', iid: 42, hash: '3f9c2a71d0' }],
    ['rechazar 42 falta el caso de borde', { verb: 'rechazar', iid: 42, reason: 'falta el caso de borde' }],
    ['detalle 42', { verb: 'detalle', iid: 42 }],
    ['aprobar 42 3f9c2a7', null],
    ['aprobar 42 zzzzzzzz', null],
    ['aprobar #42 3f9c2a71', null],
    ['rechazar 42', null],
    ['ok, dale', null],
    ['aprobar 42 3f9c2a71 y algo más', null],
  ])('%s', (text, expected) => {
    expect(parseReply(text)).toEqual(expected);
  });
});

async function published(label = 'ai::in-dev', state = 'CONVERGED'): Promise<{ gitlab: FakeGitlab; id: string }> {
  await h.consumer();
  await h.feature('001-alpha');
  await h.status('001-alpha', state);
  const gitlab = fakeGitlab([issue(7, '001-alpha', label)]);
  const { fresh } = await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
  gitlab.requests.length = 0;
  h.use(gitlab);
  return { gitlab, id: fresh[0].decision.id };
}

describe('fase 3 — control apply (3.2–3.4, 3.7)', () => {
  it('approval writes exactly one PUT that adds the target and removes the other ai:: labels', async () => {
    const { gitlab, id } = await published();
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('aplicado #7: ai::in-dev -> ai::in-review');
    // Inventario: lecturas, una actualización de etiqueta y (desde la fase 4) su nota de evidencia.
    expect(writes(gitlab.requests)).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/projects/grp%2Fdemo/issues/7', body: { add_labels: 'ai::in-review', remove_labels: 'ai::in-dev' } }),
      expect.objectContaining({ method: 'POST', path: '/projects/grp%2Fdemo/issues/7/notes' }),
    ]);
    expect(gitlab.requests.filter((request) => request.method === 'GET').length).toBeGreaterThan(0);
    expect(gitlab.issues.get(7)?.labels).toEqual(['ai::in-review']);
    expect((await readDecisions(h.root)).get(id)).toMatchObject({ status: 'applied', approver: APPROVER });
    for (const text of [result.out, result.err, await h.ledgerText()]) {
      expect(text).not.toContain(TOKEN_SENTINEL);
    }
  });

  it('rejection, wrong hash and free text write nothing', async () => {
    const { gitlab, id } = await published();
    const wrong = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', 'aprobar 7 deadbeef']);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('no corresponde');
    const free = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', 'ok, dale']);
    expect(free.code).toBe(0);
    expect(free.out).toContain('respuesta ignorada');
    const rejected = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'rechazar', '7', 'falta', 'el', 'caso']);
    expect(rejected.code).toBe(0);
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(id)).toMatchObject({ status: 'rejected', reason: 'human_rejected' });
  });

  it('an approver outside the list exits non-zero; an empty list disables approvals', async () => {
    const { gitlab, id } = await published();
    const stranger = await h.cli(['control', 'apply', '--approver', '999999999999', '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(stranger.code).toBe(1);
    expect(stranger.err).toContain('aprobador no autorizado');
    const manifest = path.join(h.root, 'manifest.yaml');
    const text = await fs.readFile(manifest, 'utf8');
    await fs.writeFile(manifest, text.replace(`  approvers:\n    - "${APPROVER}"\n`, '  approvers: []\n'));
    const disabled = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(disabled.code).toBe(2);
    expect(disabled.err).toContain('approvers está vacío');
    expect(writes(gitlab.requests)).toEqual([]);
  });

  it('a label moved since the decision supersedes it without writing', async () => {
    const { gitlab, id } = await published();
    gitlab.issues.get(7)!.labels = ['ai::blocked'];
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('la etiqueta cambió');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('superseded');
  });

  it('429 with Retry-After and a network failure fail closed: decision pending, no success note', async () => {
    const { gitlab, id } = await published();
    gitlab.failNext({ method: 'PUT' }, { status: 429, retryAfter: '30' });
    const limited = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(limited.code).toBe(1);
    expect(limited.err).toContain('Retry-After');
    expect(limited.err).toContain('30 s');
    gitlab.failNext({ method: 'PUT' }, 'network');
    const down = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(down.code).toBe(1);
    expect(down.err).toContain('el tracker no responde');
    expect(gitlab.issues.get(7)?.labels).toEqual(['ai::in-dev']);
    expect(gitlab.issues.get(7)?.notes).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('pending');
    expect(down.err + limited.err).not.toContain(TOKEN_SENTINEL);
  });
});

describe('fase 3 — sello, WIP y aprobación de spec (3.3, 3.5)', () => {
  it('approves the spec, then the preapproved move to in-dev revalidates seal and WIP', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    const seal = await featureSeal(h.root, 'specs/001-alpha');
    const gitlab = fakeGitlab([issue(3, '001-alpha', 'ai::in-spec'), issue(8, null, 'ai::in-dev')]);
    h.use(gitlab);
    const decided = await h.cli(['control', 'decide', '--online']);
    expect(decided.out).toContain(`aprobar 3 ${seal.slice(0, 8)}`);
    const tick = await runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
    expect(tick.proposals.some((item) => item.proposed === 'ai::spec-ready')).toBe(false);
    const approved = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '3', seal.slice(0, 10)]);
    expect(approved.code, approved.err).toBe(0);
    expect(gitlab.issues.get(3)?.labels).toEqual(['ai::spec-ready']);
    expect(gitlab.issues.get(3)?.notes.at(-1)?.body).toContain(`ai-hub:approved-hash=${seal}`);
    const next = await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    expect(next.fresh[0].decision).toMatchObject({ kind: 'preapproved', to: 'ai::in-dev', status: 'approved' });
    // La issue 8 ocupa el WIP: la preaprobada espera sin escribir.
    const waiting = await h.cli(['control', 'apply', '--preapproved']);
    expect(waiting.code).toBe(1);
    expect(waiting.err).toContain('WIP lleno');
    expect(gitlab.issues.get(3)?.labels).toEqual(['ai::spec-ready']);
    gitlab.issues.get(8)!.labels = ['ai::in-review'];
    const started = await h.cli(['control', 'apply', '--preapproved']);
    expect(started.code, started.err).toBe(0);
    expect(gitlab.issues.get(3)?.labels).toEqual(['ai::in-dev']);
  });

  it('a spec changed after approval is refused at apply time (fail-closed)', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    const seal = await featureSeal(h.root, 'specs/001-alpha');
    const gitlab = fakeGitlab([issue(3, '001-alpha', 'ai::in-spec')]);
    h.use(gitlab);
    await h.cli(['control', 'decide', '--online']);
    await fs.writeFile(path.join(h.root, 'specs', '001-alpha', 'spec.md'), '# cambiada\n');
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '3', seal.slice(0, 8)]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('sello actual no coincide');
    expect(writes(gitlab.requests)).toEqual([]);
  });
});

describe('fase 3 — caducidad (3.6)', () => {
  it('block moves to ai::blocked with approval_expired', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    await h.status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    h.use(gitlab, new Date(NOW.getTime() + 23 * 3_600_000));
    expect((await h.cli(['control', 'expire'])).out).toBe('');
    h.use(gitlab, new Date(NOW.getTime() + 25 * 3_600_000));
    const expired = await h.cli(['control', 'expire']);
    expect(expired.code, expired.err).toBe(0);
    expect(expired.out).toContain('ai::blocked (approval_expired)');
    expect(gitlab.issues.get(7)?.labels).toEqual(['ai::blocked']);
    expect(gitlab.issues.get(7)?.notes.at(-1)?.body).toContain('approval_expired');
  });

  it('notify only warns and writes nothing', async () => {
    await h.consumer({ expire: 'notify' });
    await h.feature('001-alpha');
    await h.status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    gitlab.requests.length = 0;
    h.use(gitlab, new Date(NOW.getTime() + 25 * 3_600_000));
    const notified = await h.cli(['control', 'expire']);
    expect(notified.out).toContain('la etiqueta no cambia');
    expect(writes(gitlab.requests)).toEqual([]);
    expect(await fs.readFile(path.join(h.root, CONTROL_DIR, 'decisions.jsonl'), 'utf8')).toContain('approval_expired');
  });
});

describe('fase 4 — notas de evidencia (4.1)', () => {
  it('one note per decision; after "PUT done, note failed" the retry neither supersedes nor duplicates', async () => {
    const { gitlab, id } = await published();
    gitlab.failNext({ method: 'POST', path: /\/notes$/ }, 'network');
    const first = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(first.code).toBe(1);
    expect(gitlab.issues.get(7)?.labels).toEqual(['ai::in-review']);
    expect(gitlab.issues.get(7)?.notes).toEqual([]);
    expect((await readDecisions(h.root)).get(id)?.status).toBe('approved');
    const retry = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(retry.code, retry.err).toBe(0);
    expect(retry.out).toContain('nota completada en el reintento');
    const again = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(again.code).toBe(1);
    const notes = gitlab.issues.get(7)?.notes ?? [];
    expect(notes.filter((note) => note.body.includes(`ai-hub:decision=${id}`))).toHaveLength(1);
    expect(notes[0].body).toContain(`<@${APPROVER}>`);
    expect(notes[0].body).toContain('ai::in-dev → ai::in-review');
    expect(writes(gitlab.requests).filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect((await readDecisions(h.root)).get(id)).toMatchObject({ status: 'applied', approver: APPROVER });
    expect(notes.map((note) => note.body).join('\n')).not.toContain(TOKEN_SENTINEL);
  });
});

describe('fase 4 — doctor y CLI de enroll (4.2, 4.4)', () => {
  it('doctor reports control as not configured without degrading, and summarises it when present', async () => {
    await h.consumer({ control: false });
    const without = await h.cli(['doctor']);
    expect(without.out).toMatch(/^\[OK\]\s+control: no configurado/m);
    await fs.appendFile(path.join(h.root, 'manifest.yaml'), `control:\n  approvers:\n    - "${APPROVER}"\n`);
    const withControl = await h.cli(['doctor']);
    expect(withControl.out).toMatch(/^\[OK\]\s+control: 1 aprobador\(es\) en Discord · ttl 24 h · expire block/m);
    expect(withControl.out + withControl.err).not.toContain(TOKEN_SENTINEL);
  });

  it('enroll without Hermes exits 2 listing every path tried and writes nothing', async () => {
    await h.consumer();
    const missing = path.join(h.root, 'no-hermes', 'hermes');
    const result = await h.cli(['control', 'enroll', '--hermes', missing]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Hermes no está instalado o no se encuentra');
    expect(result.err).toContain(missing);
    expect(result.out + result.err).not.toContain(TOKEN_SENTINEL);
  });
});

describe('fase 3 — plantilla de la skill (3.8)', () => {
  it('only runs ai-hub control apply and relays its output', async () => {
    const text = await fs.readFile(path.join(TEMPLATES, 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: ai-hub-control\n/);
    expect(text).toContain('npx --no-install ai-hub control apply --approver <author-id> -- <word>');
    expect(text).toContain('verbatim');
    expect(text.replace('no `curl`, no `glab`, no `git push`', '')).not.toMatch(/\bcurl\b|\bglab\b|git push/);
    expect(text).not.toMatch(/telegram/i);
    const poll = await fs.readFile(path.join(TEMPLATES, 'control-poll.sh'), 'utf8');
    expect(poll).toContain('"apply --preapproved" "expire"');
  });
});
