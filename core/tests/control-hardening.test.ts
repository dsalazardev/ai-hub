import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDecide } from '../src/control/decide.js';
import { runIngest } from '../src/control/ingest.js';
import { readDecisions } from '../src/control/ledger.js';
import { runTick } from '../src/control/tick.js';
import { checkTrackerScope } from '../src/env/doctor.js';
import type { FetchLike } from '../src/env/doctor.js';
import { featureSeal, featureSealAtRef } from '../src/speckit/seal.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import { BOT_ID, fakeGitlab, writes } from './control-fake.js';
import { APPROVER, NOW, TOKEN_SENTINEL, harness, issue, type Harness } from './control-harness.js';
import { gitUnavailable, runGit } from './git.js';

/** hermes-control, fase 5: evidencia remota con rango, --ref, privilegios del token, verify-message y e2e. */

const SEAL_VECTOR = '35a81eb3b064c4df23d8be843cc498284884366681c4afd7d16368cab0ddc15b';
let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.dispose();
});

const statusNote = (id: number, line: string) => ({ id, body: `Trabajo terminado.\n\n${line}\n`, authorId: 555 });

describe('fase 5 — evidencia remota con su rango (5.1)', () => {
  it('a merge request status line proposes in-review as remote evidence, never as verified', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev', { mergeRequests: [18] })]);
    gitlab.mrNotes.set(18, [statusNote(1, 'AI-HUB-STATUS: CONVERGED | artifact=specs/001-alpha/tasks.md | reason=-')]);
    const tick = await runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
    expect(tick.proposals[0]).toMatchObject({ proposed: 'ai::in-review', latest: 'CONVERGED', source: 'remote' });
    const { fresh } = await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    expect(fresh[0].decision.source).toBe('remote');
    const evidence = fresh[0].evidence.map((item) => `${item.text} ${item.source}`).join('\n');
    expect(evidence).toContain('reportado por el motor');
    expect(evidence).toContain('no verificado por el arnés');
    expect(evidence).not.toMatch(/local \(\.ai-hub\/runs/);
  });

  it('a remote VERIFIED does not propose ai::done until the merge request pipeline is green', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-review', { mergeRequests: [18] })]);
    gitlab.mrNotes.set(18, [statusNote(1, 'AI-HUB-STATUS: VERIFIED | artifact=specs/001-alpha/tasks.md | reason=-')]);
    const remote = await runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
    expect(remote.proposals[0].proposed).toBe('ai::in-review');
    expect(remote.proposals[0].reason).toContain('pipeline');
    gitlab.pipelines.set(18, 'success');
    const green = await runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
    expect(green.proposals[0]).toMatchObject({ proposed: 'ai::done', source: 'pipeline' });
  });

  it('a local run wins over a remote line, and a malformed remote line is discarded', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    await h.feature('002-beta');
    await h.status('001-alpha', 'NEEDS_WORK');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev'), issue(9, '002-beta', 'ai::in-dev')]);
    gitlab.issues.get(7)!.notes.push(statusNote(1, 'AI-HUB-STATUS: CONVERGED | artifact=specs/001-alpha/tasks.md | reason=-'));
    gitlab.issues.get(9)!.notes.push(statusNote(2, 'AI-HUB-STATUS: BLOCKED | artifact=- | reason=-'));
    const tick = await runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
    const alpha = tick.proposals.find((item) => item.feature === '001-alpha');
    const beta = tick.proposals.find((item) => item.feature === '002-beta');
    expect(alpha).toMatchObject({ latest: 'NEEDS_WORK', source: 'local' });
    expect(beta).toMatchObject({ latest: null, proposed: 'ai::in-dev' });
  });
});

describe('fase 5 — --ref del sello (5.2)', () => {
  const skipGit = gitUnavailable();

  it.skipIf(skipGit !== null)('reads the approved content from a branch and keeps the §5 vector', async () => {
    const git = (...args: string[]) => expect(runGit(args, h.root).status, args.join(' ')).toBe(0);
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(h.root, 'README.md'), '# repo\n');
    git('add', '.');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'feat/001-demo');
    await h.feature('001-demo', { 'spec.md': '# Demo\n', 'plan.md': '# Plan\n', 'tasks.md': '- [ ] T001 Demo\n' });
    git('add', '.');
    git('commit', '-m', 'spec');
    expect(await featureSeal(h.root, 'specs/001-demo')).toBe(SEAL_VECTOR);
    git('checkout', 'main');
    await expect(fs.access(path.join(h.root, 'specs'))).rejects.toThrow();
    expect(await featureSealAtRef(h.root, 'feat/001-demo', 'specs/001-demo')).toBe(SEAL_VECTOR);
    await expect(featureSealAtRef(h.root, 'main', 'specs/001-demo')).rejects.toThrow(/no se puede sellar/);
  });
});

describe('fase 5 — privilegios del token en doctor --online (5.3)', () => {
  function tokenFetch(self: { status: number; body?: Record<string, unknown> }, accessLevel = 20): { fetch: FetchLike; urls: string[] } {
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      expect(init.headers['PRIVATE-TOKEN']).toBe(TOKEN_SENTINEL);
      if (url.endsWith('/personal_access_tokens/self')) {
        return { status: self.status, json: async () => self.body ?? {} };
      }
      if (/\/members\/all\/\d+$/.test(url)) {
        return { status: 200, json: async () => ({ access_level: accessLevel }) };
      }
      return { status: 404, json: async () => ({}) };
    };
    return { fetch, urls };
  }

  it('warns when the token can push or expires within 14 days, never printing it', async () => {
    await h.consumer();
    const soon = new Date(NOW.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const { fetch } = tokenFetch({ status: 200, body: { user_id: BOT_ID, scopes: ['api', 'write_repository'], expires_at: soon } }, 30);
    const check = await checkTrackerScope(h.root, (await loadManifestContext(h.root)).manifest, { online: true, fetch, now: NOW });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('aviso');
    expect(check.detail).toContain('write_repository');
    expect(check.detail).toContain('Developer');
    expect(check.detail).toContain(soon);
    expect(check.detail).not.toContain(TOKEN_SENTINEL);
  });

  it('a least-privilege token passes; without introspection only the declared expiry is reported', async () => {
    await h.consumer();
    const manifest = (await loadManifestContext(h.root)).manifest;
    const ok = await checkTrackerScope(h.root, manifest, { online: true, fetch: tokenFetch({ status: 200, body: { user_id: BOT_ID, scopes: ['api'], expires_at: '2027-06-01' } }).fetch, now: NOW });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.detail).toContain('Reporter');
    const none = await checkTrackerScope(h.root, manifest, { online: true, fetch: tokenFetch({ status: 404 }).fetch, now: NOW });
    expect(none.detail).toContain('introspección no disponible');
    const offline = await checkTrackerScope(h.root, manifest, { online: false, now: NOW });
    expect(offline.detail).toContain('omitido');
  });
});

describe('fase 5 — verify-message (5.4)', () => {
  it('is behind a flag and reported as not available without writing', async () => {
    await h.consumer();
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
    h.use(gitlab);
    const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--verify-message', '123', '--', 'aprobar', '7', 'deadbeef']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--verify-message no está disponible');
    expect(writes(gitlab.requests)).toEqual([]);
  });
});

describe('fase 5 — integración sintética (5.6)', () => {
  it('ingest → decide → apply → note → preapproved → in-review → expire, with labels and notes only', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    const seal = await featureSeal(h.root, 'specs/001-alpha');
    const gitlab = fakeGitlab([issue(3, '001-alpha', 'ai::in-spec', { mergeRequests: [21] })]);
    h.use(gitlab);
    const event = (updatedAt: string, labels: string[], changed = false) =>
      JSON.stringify({
        object_kind: 'issue',
        user: { id: 1001 },
        project: { id: 77, path_with_namespace: 'grp/demo' },
        object_attributes: { id: 9003, iid: 3, action: 'update', updated_at: updatedAt },
        labels: labels.map((title) => ({ title })),
        ...(changed ? { changes: { labels: { previous: [], current: labels.map((title) => ({ title })) } } } : {}),
      });
    // 1. El webhook trae la issue: se publica la spec sellada para aprobación (§5).
    const ingested = await runIngest(h.root, event('2026-11-09 09:00:00 UTC', ['ai::in-spec']), { trackerFetch: gitlab.fetch, now: NOW });
    expect(ingested.fresh[0].decision).toMatchObject({ kind: 'spec-approval', hash: seal });
    // 2. La persona aprueba por Discord.
    const approved = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '3', seal.slice(0, 8)]);
    expect(approved.code, approved.err).toBe(0);
    expect(gitlab.issues.get(3)?.notes.at(-1)?.body).toContain(`ai-hub:approved-hash=${seal}`);
    // 3. El cron publica la preaprobada y la aplica.
    await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
    const started = await h.cli(['control', 'apply', '--preapproved']);
    expect(started.code, started.err).toBe(0);
    expect(gitlab.issues.get(3)?.labels).toEqual(['ai::in-dev']);
    // 4. El motor (en otro host) publica su estado en el MR; ingest propone revisión con evidencia remota.
    gitlab.mrNotes.set(21, [statusNote(5, 'AI-HUB-STATUS: CONVERGED | artifact=specs/001-alpha/tasks.md | reason=-')]);
    const review = await runIngest(h.root, event('2026-11-09 10:00:00 UTC', ['ai::in-dev']), { trackerFetch: gitlab.fetch, now: NOW });
    expect(review.fresh[0].decision).toMatchObject({ to: 'ai::in-review', source: 'remote' });
    // 5. Nadie responde: la caducidad bloquea con nota.
    h.use(gitlab, new Date(NOW.getTime() + 25 * 3_600_000));
    const expired = await h.cli(['control', 'expire']);
    expect(expired.out).toContain('approval_expired');
    expect(gitlab.issues.get(3)?.labels).toEqual(['ai::blocked']);
    // Inventario: solo etiquetas de la issue existente y notas; nada de crear issues, merge ni push.
    const written = writes(gitlab.requests).map((request) => `${request.method} ${request.path}`);
    expect(written.every((line) => /^PUT \/projects\/grp%2Fdemo\/issues\/3$|^POST \/projects\/grp%2Fdemo\/issues\/3\/notes$/.test(line))).toBe(true);
    expect(written.filter((line) => line.startsWith('PUT'))).toHaveLength(3);
    const decisions = [...(await readDecisions(h.root)).values()];
    expect(decisions.map((decision) => decision.status).sort()).toEqual(['applied', 'applied', 'expired']);
    const everything = [approved.out, approved.err, started.out, expired.out, await h.ledgerText(), ...(gitlab.issues.get(3)?.notes ?? []).map((note) => note.body)].join('\n');
    expect(everything).not.toContain(TOKEN_SENTINEL);
    expect(everything).not.toMatch(/telegram/i);
  });
});

describe('fase 5 — rotación en SECURITY.md (5.5)', () => {
  it('names the three control plane credentials, where they live, what a leak exposes and how to rotate', async () => {
    const text = await fs.readFile(path.resolve(__dirname, '..', 'SECURITY.md'), 'utf8');
    const section = text.slice(text.indexOf('### Control plane credentials (hermes-control)'));
    expect(section.length).toBeGreaterThan(100);
    for (const credential of ['`GITLAB_TOKEN`', 'Webhook secret (`X-Gitlab-Token`)', '`DISCORD_BOT_TOKEN`']) {
      expect(section, credential).toContain(credential);
    }
    for (const column of ['Lives in', 'What a leak exposes', 'Rotation']) {
      expect(section, column).toContain(column);
    }
    expect(section).toContain('It cannot push, merge or change settings');
    expect(section).toContain('never `.ai-hub/.env`');
    expect(section).not.toMatch(/telegram/i);
  });
});
