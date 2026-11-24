import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { GithubTracker, GitlabTracker, setTrackerSleep, TrackerError, type TrackerFetch, type TrackerResponse } from '../src/control/tracker.js';
import { loadManifest, validateManifestData, type ProjectManifest } from '../src/manifest/manifest.js';

/**
 * Contract tests comunes a los adaptadores de GitLab y GitHub (3.19, 4.68–4.70; R-014, R-015, R-016, R-018, R-019).
 * Cada caso corre con el mismo cuerpo contra los dos adaptadores sobre un doble HTTP local que imita solo los campos
 * documentados de cada API. Un doble no demuestra la garantía remota: solo fija cómo lee y clasifica el adaptador.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SENTINEL = 'AIHUB_TRACKER_CONTRACT_SENTINEL_51d2';
const HEAD = 'a'.repeat(40);
const RESULT = 'b'.repeat(40);
const FAILING_HEAD = 'f'.repeat(40);

type Outcome = { status: number; retryAfter?: string } | 'network';
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Route = { method: string; pattern: RegExp; reply: (match: RegExpExecArray, url: URL, body: Record<string, unknown> | null) => Reply };

interface Fixture {
  comments: number;
  evidenceAt: number;
}

interface World {
  kind: 'gitlab' | 'github';
  tracker: (maxPages?: number) => GitlabTracker;
  requests: Array<{ method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> }>;
  failNext: (method: string, outcome: Outcome) => void;
  failPage: (pattern: RegExp, page: number, outcome: Outcome) => void;
  labels: () => string[];
  /** Ruta del recurso de notas/comentarios de la issue 42 (para inyectar fallos). */
  notesPath: RegExp;
  /** Cuerpo de la última petición de cambio creada. */
  created: () => Record<string, unknown> | null;
}

/** Paginación con `Link: <…>; rel="next"` (ambos productos la documentan). */
function paged(url: URL, items: unknown[]): Reply {
  const perPage = Number(url.searchParams.get('per_page') ?? '20');
  const page = Number(url.searchParams.get('page') ?? '1');
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    headers.Link = `<${next.toString()}>; rel="next"`;
  } else {
    headers.Link = '';
  }
  return { status: 200, body: slice, headers };
}

function serve(base: string, routes: Route[]): Omit<World, 'kind' | 'tracker' | 'labels' | 'notesPath' | 'created'> & { fetch: TrackerFetch } {
  const requests: World['requests'] = [];
  const queued: Array<{ method: string; outcome: Outcome }> = [];
  const pages: Array<{ pattern: RegExp; page: number; outcome: Outcome }> = [];
  const fail = (outcome: Outcome): TrackerResponse => {
    if (outcome === 'network') {
      throw new TypeError('fetch failed');
    }
    return { status: outcome.status, json: async () => ({ message: SENTINEL }), headers: { get: (name: string) => (name === 'Retry-After' ? (outcome.retryAfter ?? null) : null) } };
  };
  const fetch: TrackerFetch = async (raw, init) => {
    const url = new URL(raw);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ method, path: url.pathname, body, headers: init.headers });
    expect(url.origin).toBe(new URL(base).origin);
    const index = queued.findIndex((item) => item.method === method);
    if (index >= 0) {
      return fail(queued.splice(index, 1)[0].outcome);
    }
    const failure = pages.find((item) => item.pattern.test(url.pathname) && Number(url.searchParams.get('page') ?? '1') === item.page);
    if (failure) {
      return fail(failure.outcome);
    }
    for (const route of routes) {
      const match = route.method === method ? route.pattern.exec(url.pathname) : null;
      if (match) {
        const reply = route.reply(match, url, body);
        return { status: reply.status, json: async () => reply.body, headers: { get: (name: string) => reply.headers?.[name] ?? null } };
      }
    }
    return { status: 404, json: async () => ({ message: 'not found' }), headers: { get: () => null } };
  };
  return {
    fetch,
    requests,
    failNext: (method, outcome) => queued.push({ method, outcome }),
    failPage: (pattern, page, outcome) => pages.push({ pattern, page, outcome }),
  };
}

function comments(fixture: Fixture, shape: (id: number, body: string) => unknown): unknown[] {
  return Array.from({ length: fixture.comments }, (_, index) => {
    const id = index + 1;
    return shape(id, id === fixture.evidenceAt ? 'AI-HUB-STATUS: CONVERGED | artifact=- | reason=-' : `nota ${id}`);
  });
}

function gitlabWorld(fixture: Fixture): World {
  const base = 'https://gitlab.test';
  let labels = ['ai::in-dev', 'bug'];
  let created: Record<string, unknown> | null = null;
  const project = '/api/v4/projects/grp%2Fdemo';
  const notes = comments(fixture, (id, body) => ({ id, body, author: { id: 7 } }));
  const issue = (): Record<string, unknown> => ({ iid: 42, title: 'Demo', labels, description: 'd', author: { id: 3, username: 'autor' } });
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/v4\/user$/, reply: () => ({ status: 200, body: { id: 9 } }) },
    { method: 'GET', pattern: /^\/api\/v4\/users\/(\d+)$/, reply: () => ({ status: 200, body: { id: 1 } }) },
    { method: 'GET', pattern: new RegExp(`^${project}/issues$`), reply: (_m, url) => paged(url, [issue(), { iid: 43, title: 'x', labels: ['otra'] }]) },
    { method: 'GET', pattern: /\/issues\/42\/notes$/, reply: (_m, url) => paged(url, notes) },
    { method: 'GET', pattern: /\/issues\/42$/, reply: () => ({ status: 200, body: issue() }) },
    {
      method: 'PUT',
      pattern: /\/issues\/42$/,
      reply: (_m, _u, body) => {
        const remove = typeof body?.remove_labels === 'string' ? body.remove_labels.split(',') : [];
        labels = [...labels.filter((label) => !remove.includes(label) && label !== body?.add_labels), String(body?.add_labels)];
        return { status: 200, body: issue() };
      },
    },
    {
      method: 'GET',
      pattern: /\/members\/all$/,
      reply: (_m, url) =>
        paged(url, [
          { id: 1, username: 'ana', access_level: 50 },
          { id: 2, username: 'project_9_bot_x', access_level: 50 },
          { id: 3, username: 'autor', access_level: 30 },
        ]),
    },
    { method: 'GET', pattern: /\/merge_requests\/5$/, reply: () => ({ status: 200, body: { state: 'merged', sha: HEAD, merge_commit_sha: RESULT } }) },
    { method: 'GET', pattern: /\/merge_requests\/6$/, reply: () => ({ status: 200, body: { state: 'merged', sha: HEAD, merge_commit_sha: null, squash_commit_sha: '' } }) },
    { method: 'GET', pattern: /\/issues\/42\/related_merge_requests$/, reply: (_m, url) => paged(url, [{ iid: 5 }, { iid: 6 }]) },
    { method: 'GET', pattern: /\/merge_requests\/5\/pipelines$/, reply: () => ({ status: 200, body: [{ status: 'success' }] }) },
    { method: 'GET', pattern: /\/merge_requests\/7\/pipelines$/, reply: () => ({ status: 200, body: [{ status: 'failed' }] }) },
    {
      method: 'POST',
      pattern: /\/merge_requests$/,
      reply: (_m, _u, body) => {
        created = body;
        return { status: 201, body: { iid: 77 } };
      },
    },
  ];
  const server = serve(base, routes);
  return {
    kind: 'gitlab',
    ...server,
    tracker: (maxPages) => new GitlabTracker(base, 'grp/demo', SENTINEL, server.fetch, maxPages),
    labels: () => labels,
    notesPath: /\/issues\/42\/notes$/,
    created: () => created,
  };
}

function githubWorld(fixture: Fixture): World {
  const base = 'https://api.github.test';
  let labels = ['ai::in-dev', 'bug'];
  let created: Record<string, unknown> | null = null;
  let reviewers: Record<string, unknown> | null = null;
  const notes = comments(fixture, (id, body) => ({ id, body, user: { id: 7, login: 'u7' } }));
  const issue = (): Record<string, unknown> => ({ number: 42, title: 'Demo', labels: labels.map((name) => ({ name })), body: 'd', user: { id: 3, login: 'autor' } });
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/user$/, reply: () => ({ status: 200, body: { id: 9, login: 'arnes' } }) },
    // El listado de issues de GitHub incluye PR (con `pull_request`): el adaptador debe excluirlos.
    {
      method: 'GET',
      pattern: /^\/repos\/grp\/demo\/issues$/,
      reply: (_m, url) => paged(url, [issue(), { number: 44, title: 'PR', labels: [{ name: 'ai::in-dev' }], pull_request: { url: 'x' } }, { number: 43, title: 'x', labels: [{ name: 'otra' }] }]),
    },
    { method: 'GET', pattern: /\/issues\/42\/comments$/, reply: (_m, url) => paged(url, notes) },
    { method: 'GET', pattern: /\/issues\/42$/, reply: () => ({ status: 200, body: issue() }) },
    {
      method: 'PUT',
      pattern: /\/issues\/42\/labels$/,
      reply: (_m, _u, body) => {
        labels = (body?.labels as string[]) ?? [];
        return { status: 200, body: labels.map((name) => ({ name })) };
      },
    },
    {
      method: 'GET',
      pattern: /\/collaborators$/,
      reply: (_m, url) =>
        paged(
          url,
          url.searchParams.get('permission') === 'admin'
            ? [
                { id: 1, login: 'ana', permissions: { admin: true } },
                { id: 2, login: 'deploy[bot]', permissions: { admin: true } },
              ]
            : [
                { id: 1, login: 'ana', permissions: { admin: true, push: true, pull: true } },
                { id: 2, login: 'deploy[bot]', permissions: { admin: true } },
                { id: 3, login: 'autor', permissions: { push: true, pull: true } },
              ],
        ),
    },
    { method: 'GET', pattern: /\/pulls\/5$/, reply: () => ({ status: 200, body: { state: 'closed', merged: true, head: { sha: HEAD }, merge_commit_sha: RESULT } }) },
    { method: 'GET', pattern: /\/pulls\/6$/, reply: () => ({ status: 200, body: { state: 'closed', merged: true, head: { sha: HEAD }, merge_commit_sha: null } }) },
    { method: 'GET', pattern: /\/pulls\/7$/, reply: () => ({ status: 200, body: { state: 'open', merged: false, head: { sha: FAILING_HEAD } } }) },
    // Línea de tiempo: dos PR del repositorio, uno de otro repositorio y una issue que no es PR (solo cuentan los dos).
    {
      method: 'GET',
      pattern: /\/issues\/42\/timeline$/,
      reply: (_m, url) =>
        paged(url, [
          { event: 'labeled' },
          { event: 'cross-referenced', source: { issue: { number: 5, pull_request: {}, repository_url: `${base}/repos/grp/demo` } } },
          { event: 'cross-referenced', source: { issue: { number: 6, pull_request: {}, repository_url: `${base}/repos/grp/demo` } } },
          { event: 'cross-referenced', source: { issue: { number: 9, pull_request: {}, repository_url: `${base}/repos/otro/repo` } } },
          { event: 'cross-referenced', source: { issue: { number: 10, repository_url: `${base}/repos/grp/demo` } } },
        ]),
    },
    {
      method: 'GET',
      pattern: /\/commits\/([0-9a-f]+)\/check-runs$/,
      reply: (match) => {
        const runs = match[1] !== FAILING_HEAD
          ? [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]
          : [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }];
        return { status: 200, body: { total_count: runs.length, check_runs: runs } };
      },
    },
    {
      method: 'POST',
      pattern: /\/pulls\/77\/requested_reviewers$/,
      reply: (_m, _u, body) => {
        reviewers = body;
        return { status: 201, body: {} };
      },
    },
    {
      method: 'POST',
      pattern: /\/repos\/grp\/demo\/pulls$/,
      reply: (_m, _u, body) => {
        created = body;
        return { status: 201, body: { number: 77 } };
      },
    },
  ];
  const server = serve(base, routes);
  return {
    kind: 'github',
    ...server,
    tracker: (maxPages) => new GithubTracker(base, 'grp/demo', SENTINEL, server.fetch, maxPages),
    labels: () => labels,
    notesPath: /\/issues\/42\/comments$/,
    created: () => (created === null ? null : { ...created, ...(reviewers ? { requested: reviewers } : {}) }),
  };
}

const WORLDS = [
  ['gitlab', gitlabWorld],
  ['github', githubWorld],
] as const;

let slept: number[];
beforeEach(() => {
  slept = [];
  setTrackerSleep(async (ms) => {
    slept.push(ms);
  });
});
afterEach(() => setTrackerSleep(null));

describe.each(WORLDS)('contrato del adaptador %s', (kind, make) => {
  it('lectura completa: la evidencia de la página 2 se incluye (R-014)', async () => {
    const world = make({ comments: 150, evidenceAt: 130 });
    const notes = await world.tracker().issueNotes(42);
    expect(notes).toHaveLength(150);
    expect(notes.find((note) => note.id === 130)?.body).toContain('CONVERGED');
    expect(world.requests.filter((request) => world.notesPath.test(request.path))).toHaveLength(2);
  });

  it('un fallo en la página 2 es un error clasificado, nunca una lista parcial', async () => {
    const world = make({ comments: 150, evidenceAt: 130 });
    world.failPage(world.notesPath, 2, { status: 404 });
    await expect(world.tracker().issueNotes(42)).rejects.toMatchObject({ failureClass: 'http_4xx' });
  });

  it('el tope de páginas convierte el exceso en incompletitud explícita', async () => {
    const world = make({ comments: 250, evidenceAt: 1 });
    await expect(world.tracker(2).issueNotes(42)).rejects.toMatchObject({ failureClass: 'incomplete' });
  });

  it('el tablero solo trae issues con etiqueta ai:: (sin PR)', async () => {
    const world = make({ comments: 0, evidenceAt: 0 });
    expect((await world.tracker().labelledIssues()).map((issue) => issue.iid)).toEqual([42]);
  });

  it('clases de fallo con destino saneado y sin el token (R-015)', async () => {
    const cases: Array<[Outcome, string]> = [
      ['network', 'network'],
      [{ status: 401 }, 'auth'],
      [{ status: 404 }, 'http_4xx'],
      [{ status: 503 }, 'http_5xx'],
      [{ status: 429 }, 'rate_limit'],
    ];
    for (const [outcome, failureClass] of cases) {
      const world = make({ comments: 1, evidenceAt: 0 });
      for (let index = 0; index < 3; index += 1) {
        world.failNext('GET', outcome);
      }
      const error = (await world.tracker().issue(42).catch((caught: unknown) => caught)) as TrackerError;
      expect(error).toBeInstanceOf(TrackerError);
      expect(error).toMatchObject({ failureClass, target: '/issues/42' });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(SENTINEL);
    }
  });

  it('reintenta solo lecturas transitorias; una escritura fallida se envía una vez (R-016)', async () => {
    const world = make({ comments: 1, evidenceAt: 0 });
    world.failNext('GET', { status: 503 });
    world.failNext('GET', 'network');
    expect((await world.tracker().issue(42)).iid).toBe(42);
    expect(slept).toEqual([2000, 5000]);
    world.failNext('PUT', { status: 503 });
    await expect(world.tracker().moveLabel(42, 'ai::in-review', ['ai::in-dev'])).rejects.toBeInstanceOf(TrackerError);
    expect(world.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('el token viaja solo en cabeceras, nunca en la URL', async () => {
    const world = make({ comments: 1, evidenceAt: 0 });
    await world.tracker().issue(42);
    const [request] = world.requests;
    expect(request.path).not.toContain(SENTINEL);
    expect(Object.values(request.headers).join(' ')).toContain(SENTINEL);
  });

  it('mover etiqueta: una sola escritura que retira las demás ai:: y conserva las ajenas', async () => {
    const world = make({ comments: 0, evidenceAt: 0 });
    await world.tracker().moveLabel(42, 'ai::in-review', ['ai::in-dev']);
    expect(world.labels().sort()).toEqual(['ai::in-review', 'bug']);
    expect(world.requests.filter((request) => request.method !== 'GET')).toHaveLength(1);
  });

  it('dueño no disponible: sin campo documentado, bot es null y nunca false (3.19, R-018)', async () => {
    const owners = await make({ comments: 0, evidenceAt: 0 }).tracker().repositoryOwners();
    expect(owners.find((owner) => owner.id === 1)).toEqual({ id: 1, username: 'ana', bot: null });
    // El único marcador documentado de bot de cada producto sí cuenta.
    expect(owners.find((owner) => owner.id === 2)?.bot).toBe(true);
  });

  it('evidencia de merge: cabeza y resultado por separado; sin commit resultante, «no disponible» (3.19)', async () => {
    const tracker = make({ comments: 0, evidenceAt: 0 }).tracker();
    expect(await tracker.mergeEvidence(5)).toMatchObject({ state: 'merged', sourceHead: HEAD, result: RESULT });
    expect(await tracker.mergeEvidence(6)).toMatchObject({ state: 'merged', sourceHead: HEAD, result: null });
  });

  it('abre la petición de cambio en draft y pide revisión al usuario elegido; nunca aprueba ni fusiona', async () => {
    const world = make({ comments: 0, evidenceAt: 0 });
    const result = await world.tracker().createDraftMergeRequest({ source: 'ai/42-demo', target: 'main', title: 'Demo', description: 'd', reviewerIds: [3], reviewerLogins: ['autor'] });
    expect(result.iid).toBe(77);
    const body = world.created();
    if (kind === 'gitlab') {
      expect(body).toMatchObject({ title: 'Draft: Demo', reviewer_ids: [3] });
    } else {
      expect(body).toMatchObject({ draft: true, head: 'ai/42-demo', base: 'main', requested: { reviewers: ['autor'] } });
    }
    expect(world.requests.map((request) => request.path).join(' ')).not.toMatch(/approve|merge$/);
  });

  it('peticiones de cambio de la issue y estado de CI de cada una (evidencia remota de tick)', async () => {
    const world = make({ comments: 0, evidenceAt: 0 });
    const tracker = world.tracker();
    expect((await tracker.relatedMergeRequests(42)).map((mr) => mr.iid)).toEqual([5, 6]);
    expect(await tracker.latestPipelineStatus(5)).toBe('success');
    expect(await tracker.latestPipelineStatus(7)).toBe('failed');
  });

  it('nombre del artefacto desde el adaptador (4.70)', () => {
    const name = make({ comments: 0, evidenceAt: 0 }).tracker().changeRequestName;
    expect(name).toEqual(kind === 'gitlab' ? { short: 'MR', long: 'merge request', ref: '!' } : { short: 'PR', long: 'pull request', ref: '#' });
    expect(make({ comments: 0, evidenceAt: 0 }).tracker().kind).toBe(kind);
  });
});

describe('capacidades condicionales ausentes en ambos adaptadores', () => {
  it('ninguna está disponible sin experimento', async () => {
    const { CAPABILITY_DECLARATIONS } = await import('../src/control/capabilities.js');
    for (const product of ['gitlab', 'github'] as const) {
      expect(CAPABILITY_DECLARATIONS.filter((item) => item.product === product).every((item) => !item.available)).toBe(true);
    }
  });
});

describe('manifest.tracker.kind (4.68)', () => {
  async function withTracker(kind: string): Promise<ProjectManifest> {
    const manifest = JSON.parse(JSON.stringify(await loadManifest(REPO_ROOT))) as Record<string, unknown>;
    manifest.tracker = { kind, urlEnv: 'GITHUB_API_URL', tokenEnv: 'GITHUB_TOKEN' };
    return manifest as unknown as ProjectManifest;
  }

  it('admite gitlab y github', async () => {
    for (const kind of ['gitlab', 'github']) {
      await expect(validateManifestData(await withTracker(kind), REPO_ROOT)).resolves.toBeTruthy();
    }
  });

  it('rechaza un tipo desconocido nombrando el campo', async () => {
    await expect(validateManifestData(await withTracker('bitbucket'), REPO_ROOT)).rejects.toThrow(/tracker\/kind/);
  });
});

describe('el flujo compartido no ramifica por el nombre del tracker (R-019)', () => {
  it('fuera del adaptador nada compara tracker.kind con un nombre de producto', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = path.resolve(__dirname, '..', 'src');
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.ts') && entry.name !== 'tracker.ts') {
          const text = await fs.readFile(full, 'utf8');
          if (/kind\s*===?\s*['"](gitlab|github)['"]/.test(text)) {
            offenders.push(path.relative(src, full));
          }
        }
      }
    }
    await walk(src);
    expect(offenders).toEqual([]);
  });

  it('con un tracker sin ingesta de webhooks declarada, ingest ignora el evento con motivo explícito', async () => {
    const { TRACKER_DESCRIPTORS } = await import('../src/control/tracker.js');
    expect(TRACKER_DESCRIPTORS.gitlab.webhookIngest).toBe(true);
    expect(TRACKER_DESCRIPTORS.github.webhookIngest).toBe(false);
    expect(TRACKER_DESCRIPTORS.github.tokenIntrospection).toBe(false);
  });
});
