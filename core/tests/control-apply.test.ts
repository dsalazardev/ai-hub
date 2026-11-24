import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDecide } from '../src/control/decide.js';
import { CONTROL_DIR, readDecisions } from '../src/control/ledger.js';
import { confirmationRef, parseReply } from '../src/control/reply.js';
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
    // R-001 (4.11): longitud y caracteres inválidos se diagnostican por su nombre en vez de ignorarse.
    ['aprobar 42 3f9c2a7', expect.objectContaining({ verb: 'diagnostico', iid: 42, code: 'hash_length', message: expect.stringContaining('tiene 7 caracteres') })],
    ['aprobar 42 zzzzzzzz', expect.objectContaining({ verb: 'diagnostico', iid: 42, code: 'hash_charset', message: expect.stringContaining('hexadecimales') })],
    ['aprobar 42 66fc04zz', expect.objectContaining({ verb: 'diagnostico', code: 'hash_charset' })],
    [`aprobar 42 ${'a'.repeat(65)}`, expect.objectContaining({ verb: 'diagnostico', code: 'hash_length' })],
    ['aprobar 42', { verb: 'consultar', iid: 42 }],
    ['aprobar 42 confirmar K7Q2M9XP4D', { verb: 'confirmar', iid: 42, ref: 'K7Q2M9XP4D' }],
    ['Aprobar 42 CONFIRMAR k7q2m9xp4d', { verb: 'confirmar', iid: 42, ref: 'K7Q2M9XP4D' }],
    ['aprobar 42 confirmar K7Q2M9XP4I', expect.objectContaining({ verb: 'diagnostico', code: 'ref_format' })],
    ['aprobar 42 confirmar 0a1b', expect.objectContaining({ verb: 'diagnostico', code: 'ref_format' })],
    ['aprobar 42 confirmar', expect.objectContaining({ verb: 'diagnostico', code: 'ref_format', message: expect.stringContaining('falta la referencia') })],
    ['aprobar 42 confirmar K7Q2M9XP4D extra', null],
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
  it('doctor reports control as not configured without degrading, and summarises it when present', { timeout: 60_000 }, async () => {
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
    // R-010: la secuencia apply --preapproved → expire → decide vive en `control poll` (fases separadas, sin reintentar escrituras).
    const poll = await fs.readFile(path.join(TEMPLATES, 'control-poll.sh'), 'utf8');
    expect(poll).toContain('exec npx --no-install ai-hub control poll');
    expect(poll).toMatch(/^# ai-hub-managed: control-poll\.sh v=\d+$/m);
  });

  it('pasa la confirmación de cuatro palabras completa y la documenta (4.15, R-007)', async () => {
    const text = await fs.readFile(path.join(TEMPLATES, 'SKILL.md'), 'utf8');
    expect(text).toContain('aprobar <iid> confirmar <ref>');
    expect(text).toContain('`aprobar 42 confirmar K7Q2M9XP4D` must reach AI-Hub as four arguments');
    expect(text).not.toMatch(/Keep only the first three words/);
    // La forma que la skill transporta es la que el parser acepta, palabra por palabra.
    expect(parseReply(['aprobar', '42', 'confirmar', 'K7Q2M9XP4D'].join(' '))).toEqual({ verb: 'confirmar', iid: 42, ref: 'K7Q2M9XP4D' });
  });
});

describe('gramática y referencias de confirmación (4.11–4.13, R-001, R-006, R-022)', () => {
  async function projectId(): Promise<string> {
    const { loadManifestContext } = await import('../src/manifest/manifest.js');
    return (await loadManifestContext(h.root)).manifest.project.id;
  }

  it('aprobar <iid> informa a un aprobador hash, ref y comandos sin escribir nada', async () => {
    const { gitlab, id } = await published();
    const before = await h.ledgerText();
    const decision = (await readDecisions(h.root)).get(id)!;
    const ref = confirmationRef(await projectId(), id, decision.expiresAt);
    const info = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7']);
    expect(info.code, info.err).toBe(0);
    expect(info.out).toContain(`hash ${decision.hash.slice(0, 8)}`);
    expect(info.out).toContain(`aprobar 7 confirmar ${ref}`);
    expect(writes(gitlab.requests)).toEqual([]);
    expect(await h.ledgerText()).toBe(before);
  });

  it('aprobar <iid> de un usuario fuera de la lista no revela hash ni referencia', async () => {
    const { gitlab, id } = await published();
    const decision = (await readDecisions(h.root)).get(id)!;
    const ref = confirmationRef(await projectId(), id, decision.expiresAt);
    const stranger = await h.cli(['control', 'apply', '--approver', '999999999999', '--', 'aprobar', '7']);
    expect(stranger.code).toBe(1);
    for (const text of [stranger.out, stranger.err]) {
      expect(text).not.toContain(decision.hash.slice(0, 8));
      expect(text).not.toContain(ref);
    }
    expect(writes(gitlab.requests)).toEqual([]);
  });

  it('hash corto o no hexadecimal: diagnóstico por nombre y cero escrituras', async () => {
    const { gitlab } = await published();
    const short = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', 'aprobar 7 66fc045']);
    expect(short.code).toBe(1);
    expect(short.err).toContain('hash_length');
    expect(short.err).toContain('tiene 7 caracteres');
    const charset = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', 'aprobar 7 66fc04zz']);
    expect(charset.err).toContain('hash_charset');
    expect(writes(gitlab.requests)).toEqual([]);
  });

  it('confirmar <ref> aplica esa decisión; repetirla informa «ya se aplicó» sin escribir', async () => {
    const { gitlab, id } = await published();
    const decision = (await readDecisions(h.root)).get(id)!;
    const ref = confirmationRef(await projectId(), id, decision.expiresAt);
    const applied = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', `aprobar 7 confirmar ${ref}`]);
    expect(applied.code, applied.err).toBe(0);
    expect((await readDecisions(h.root)).get(id)).toMatchObject({ status: 'applied' });
    gitlab.requests.length = 0;
    const again = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', `aprobar 7 confirmar ${ref}`]);
    expect(again.out).toContain('ya se aplicó');
    expect(writes(gitlab.requests)).toEqual([]);
  });

  it('la referencia de A no aprueba B: nombra la vigente y no escribe; una ref de otro proyecto se rechaza', async () => {
    const { gitlab, id } = await published();
    const a = (await readDecisions(h.root)).get(id)!;
    const project = await projectId();
    const refA = confirmationRef(project, a.id, a.expiresAt);
    // B sustituye a A con la etiqueta sin cambiar (decide.ts marca la anterior como superseded).
    const { recordDecision, recordStatus } = await import('../src/control/ledger.js');
    const b = { ...a, id: `${'b'.repeat(8)}${a.id.slice(8)}`, hash: `${'c'.repeat(8)}${a.hash.slice(8)}`, createdAt: new Date(NOW.getTime() + 1000).toISOString(), status: 'pending' as const };
    await recordStatus(h.root, a.id, 'superseded', NOW, { reason: 'new_decision' });
    await recordDecision(h.root, b);
    const stale = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', `aprobar 7 confirmar ${refA}`]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(`la vigente es ${b.id.slice(0, 8)}`);
    expect(stale.err).toContain('detalle 7');
    const foreign = confirmationRef('otro-proyecto', b.id, b.expiresAt);
    const other = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', `aprobar 7 confirmar ${foreign}`]);
    expect(other.code).toBe(1);
    expect(other.err).toContain('no corresponde a ninguna decisión de este proyecto');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readDecisions(h.root)).get(b.id)).toMatchObject({ status: 'pending' });
  });

  it('dos decisiones abiertas y una respuesta que no elige una: cero escrituras y ambas nombradas (R-022)', async () => {
    const { gitlab, id } = await published();
    const a = (await readDecisions(h.root)).get(id)!;
    const { recordDecision } = await import('../src/control/ledger.js');
    // Un segundo publicador concurrente dejó otra decisión abierta con el mismo prefijo de hash.
    const b = { ...a, id: `${'d'.repeat(8)}${a.id.slice(8)}`, to: 'ai::blocked', createdAt: new Date(NOW.getTime() + 1000).toISOString() };
    await recordDecision(h.root, b);
    const before = await h.ledgerText();
    for (const reply of [`aprobar 7 ${a.hash.slice(0, 8)}`, 'rechazar 7 no', 'detalle 7']) {
      const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', reply]);
      expect(result.code, reply).toBe(1);
      expect(result.err).toContain(a.id.slice(0, 8));
      expect(result.err).toContain(b.id.slice(0, 8));
      expect(result.err).toContain('no se escribe nada');
    }
    expect(writes(gitlab.requests)).toEqual([]);
    expect(await h.ledgerText()).toBe(before);
  });
});

describe('línea corrupta del registro (R-025, 4.14)', () => {
  it('detiene apply y decide, conserva los bytes y no escribe en el tracker', async () => {
    const { gitlab, id } = await published();
    const ledger = path.join(h.root, CONTROL_DIR, 'decisions.jsonl');
    await fs.appendFile(ledger, '{"v":1,"type":"status","id":"trunc\n');
    const before = await fs.readFile(ledger);
    const reply = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
    expect(reply.code).toBe(1);
    expect(reply.err).toContain('ledger_corrupt');
    expect(reply.err).toContain('no se escribe nada');
    const decide = await h.cli(['control', 'decide', '--online', '--format', 'json']);
    expect(decide.code).toBe(1);
    expect(decide.err).toContain('ledger_corrupt');
    expect(JSON.parse(decide.out)).toEqual([]);
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await fs.readFile(ledger)).equals(before)).toBe(true);
  });
});

describe('escritores del registro serializados (R-008, 4.14)', () => {
  it('dos publicadores concurrentes dejan una sola decisión abierta', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    await h.status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    await Promise.all([
      runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW }),
      runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW }),
    ]);
    const open = [...(await readDecisions(h.root)).values()].filter((decision) => decision.iid === 7 && ['pending', 'approved'].includes(decision.status));
    expect(open).toHaveLength(1);
  });

  it('un evento duplicado concurrente se registra una vez', async () => {
    await h.consumer();
    const { claimEvent } = await import('../src/control/ledger.js');
    const results = await Promise.all(Array.from({ length: 5 }, () => claimEvent(h.root, 'issue:7:evt-1', NOW)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await h.ledgerText()).split('\n').filter((line) => line.includes('evt-1'))).toHaveLength(1);
  });
});

describe('peticiones de ejecución y concesiones (4.20, R-005)', () => {
  const requestInput = (iid: number) => ({
    project: 'grp/demo',
    iid,
    summary: 'implementar la exportación',
    worktree: '.worktrees/7-x',
    effects: ['edit:src/**'],
    base: 'a'.repeat(40),
    seal: null,
    limits: { maxMinutes: 30 },
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  });

  it('aprobar con el prefijo de la petición registra la concesión sin tocar etiquetas', async () => {
    const { submitRequest, readRequests, verifyGrant } = await import('../src/control/requests.js');
    await h.consumer();
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    h.use(gitlab, NOW);
    const request = await submitRequest(h.root, requestInput(7), NOW);
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', request.id.slice(0, 8)]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('aprobada como concesión');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readRequests(h.root))[request.id]).toMatchObject({ status: 'approved', approver: APPROVER });
    expect((await verifyGrant(h.root, 7, request.id, NOW)).ok).toBe(true);
  });

  it('rechazar deja la petición rechazada y nunca consumible', async () => {
    const { submitRequest, readRequests, verifyGrant } = await import('../src/control/requests.js');
    await h.consumer();
    h.use(fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]), NOW);
    const request = await submitRequest(h.root, requestInput(7), NOW);
    expect((await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'rechazar', '7', 'no', 'ahora'])).code).toBe(0);
    expect((await readRequests(h.root))[request.id].status).toBe('rejected');
    expect(await verifyGrant(h.root, 7, request.id, NOW)).toMatchObject({ ok: false, reason: 'grant_invalid' });
  });

  it('aprobar <iid> con una decisión y una petición pendientes nombra ambas y no aprueba nada', async () => {
    const { submitRequest, readRequests } = await import('../src/control/requests.js');
    const { gitlab, id } = await published();
    h.use(gitlab, NOW);
    const request = await submitRequest(h.root, requestInput(7), NOW);
    const info = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7']);
    expect(info.out).toContain(`decisión ${id.slice(0, 8)}`);
    expect(info.out).toContain(`petición de ejecución ${request.id.slice(0, 8)}`);
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readRequests(h.root))[request.id].status).toBe('pending');
  });

  it('un prefijo que coincide con la decisión y con la petición no aprueba nada y pide uno más largo', async () => {
    const { submitRequest, readRequests } = await import('../src/control/requests.js');
    const { recordDecision } = await import('../src/control/ledger.js');
    const { gitlab, id } = await published();
    h.use(gitlab, NOW);
    const request = await submitRequest(h.root, requestInput(7), NOW);
    const decision = (await readDecisions(h.root)).get(id)!;
    // Otra decisión abierta cuyo hash empieza igual que la petición.
    await recordDecision(h.root, { ...decision, id: `${'e'.repeat(8)}${decision.id.slice(8)}`, hash: `${request.id.slice(0, 8)}${'0'.repeat(56)}`, createdAt: new Date(NOW.getTime() + 1000).toISOString() });
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', `aprobar 7 ${request.id.slice(0, 8)}`]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('usa un prefijo más largo');
    expect(result.err).toContain(`petición ${request.id.slice(0, 8)}`);
    expect(result.err).toContain('decisión eeeeeeee');
    expect(writes(gitlab.requests)).toEqual([]);
    expect((await readRequests(h.root))[request.id].status).toBe('pending');
  });

  it('una spec aprobada sin concesión no autoriza al runner', async () => {
    const { verifyGrant } = await import('../src/control/requests.js');
    await h.consumer();
    await h.feature('001-alpha');
    const seal = await featureSeal(h.root, 'specs/001-alpha');
    const gitlab = fakeGitlab([issue(3, '001-alpha', 'ai::in-spec')]);
    h.use(gitlab);
    await h.cli(['control', 'decide', '--online']);
    expect((await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '3', seal.slice(0, 10)])).code).toBe(0);
    expect(await verifyGrant(h.root, 3, null)).toMatchObject({ ok: false, reason: 'grant_invalid' });
  });
});

describe('la skill de control no invoca el runner (6.2, R-104)', () => {
  it('el único comando de la skill es control apply', async () => {
    const text = await fs.readFile(path.join(TEMPLATES, 'SKILL.md'), 'utf8');
    const commands = [...text.matchAll(/npx --no-install ai-hub ([a-z-]+)(?: ([a-z-]+))?/g)].map((match) => `${match[1]} ${match[2] ?? ''}`.trim());
    expect(new Set(commands)).toEqual(new Set(['control apply']));
    expect(text).not.toMatch(/\brunner\b|ai-hub run\b|control poll|review candidate|\bexec\b/i);
  });
});
