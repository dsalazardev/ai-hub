import type { TrackerFetch, TrackerMethod } from '../src/control/tracker.js';

/** Centinela de token (PD-1): jamás debe aparecer en ninguna salida, registro, nota ni mensaje. */
export const TOKEN_SENTINEL = 'AIHUB_CONTROL_SENTINEL_9c41e7';
export const BOT_ID = 4242;
export const HUMAN_ID = 1001;

export interface FakeIssue {
  iid: number;
  title: string;
  labels: string[];
  description: string;
  notes: Array<{ id: number; body: string; authorId: number }>;
  mergeRequests?: number[];
  /** Autor de la issue (`author` de la API). */
  author?: { id: number; username: string };
}

export interface FakeRequest {
  method: TrackerMethod;
  path: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface FakeGitlab {
  fetch: TrackerFetch;
  requests: FakeRequest[];
  issues: Map<number, FakeIssue>;
  mrNotes: Map<number, Array<{ id: number; body: string; authorId: number }>>;
  pipelines: Map<number, string>;
  /** MR del proyecto (los de `options.mergeRequests` y los creados por POST). */
  mergeRequests: Map<number, Record<string, unknown>>;
  /** Falla programada: la próxima petición que case con el método y la ruta devuelve este resultado. */
  failNext(match: { method?: TrackerMethod; path?: RegExp }, outcome: { status: number; retryAfter?: string } | 'network'): void;
  /** Falla programada de una página concreta de una colección (3.14). */
  failPage(path: RegExp, page: number, outcome: { status: number } | 'network'): void;
}

export interface FakeGitlabOptions {
  /** Tamaño de página máximo del servidor (por defecto, el `per_page` pedido). */
  pageSize?: number;
  /** Anunciar la siguiente página con `Link: rel="next"` en vez de `x-next-page`. */
  linkHeader?: boolean;
  /** Miembros con herencia (`/members/all`): solo los campos documentados (1.3), sin campo `bot`. */
  members?: Array<{ id: number; username: string; access_level: number }>;
  /** `GET /users/:id`: el atributo `bot` documentado, o ausente. */
  users?: Record<number, { bot?: boolean }>;
  /** `GET /merge_requests/:iid` con los campos documentados (1.4). */
  mergeRequests?: Record<number, Record<string, unknown>>;
}

/** GitLab v4 en memoria: solo las rutas que usa el plano de control; graba cada petición. */
export function fakeGitlab(issues: FakeIssue[], options: FakeGitlabOptions = {}): FakeGitlab {
  const state = new Map(issues.map((issue) => [issue.iid, issue]));
  const requests: FakeRequest[] = [];
  const mrNotes = new Map<number, Array<{ id: number; body: string; authorId: number }>>();
  const mergeRequests = new Map<number, Record<string, unknown>>(Object.entries(options.mergeRequests ?? {}).map(([iid, mr]) => [Number(iid), mr]));
  const pipelines = new Map<number, string>();
  const failures: Array<{ match: { method?: TrackerMethod; path?: RegExp }; outcome: { status: number; retryAfter?: string } | 'network' }> = [];
  let noteId = 1000;
  const pageFailures: Array<{ path: RegExp; page: number; outcome: { status: number } | 'network' }> = [];
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) => ({
    status,
    json: async () => data,
    headers: { get: (name: string) => headers[name] ?? null },
  });
  /** Pagina una colección como GitLab: `page`/`per_page`, `x-next-page` vacío en la última. */
  const paged = (url: URL, list: unknown[]) => {
    const requested = Number.parseInt(url.searchParams.get('per_page') ?? '20', 10);
    const size = Math.min(requested, options.pageSize ?? requested);
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const slice = list.slice((page - 1) * size, page * size);
    const hasNext = page * size < list.length;
    const headers: Record<string, string> = { 'x-page': String(page), 'x-per-page': String(size), 'x-total': String(list.length) };
    if (options.linkHeader) {
      if (hasNext) {
        const next = new URL(url.toString());
        next.searchParams.set('page', String(page + 1));
        headers.Link = `<${next.toString()}>; rel="next"`;
      } else {
        headers.Link = '';
      }
    } else {
      headers['x-next-page'] = hasNext ? String(page + 1) : '';
    }
    return json(200, slice, headers);
  };
  const view = (issue: FakeIssue) => ({ iid: issue.iid, title: issue.title, labels: [...issue.labels], description: issue.description, ...(issue.author ? { author: issue.author } : {}) });
  const doFetch: TrackerFetch = async (url, init) => {
    const method = init.method ?? 'GET';
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\/api\/v4/, '');
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path: `${pathname}${parsed.search}`, ...(body ? { body } : {}), headers: init.headers });
    const failure = failures.findIndex(
      (item) => (!item.match.method || item.match.method === method) && (!item.match.path || item.match.path.test(pathname)),
    );
    const page = Number.parseInt(parsed.searchParams.get('page') ?? '1', 10);
    const pageFailure = pageFailures.findIndex((item) => item.path.test(pathname) && item.page === page);
    if (pageFailure >= 0) {
      const [{ outcome }] = pageFailures.splice(pageFailure, 1);
      if (outcome === 'network') {
        throw new Error('ECONNREFUSED');
      }
      return json(outcome.status, { message: 'error' });
    }
    if (failure >= 0) {
      const [{ outcome }] = failures.splice(failure, 1);
      if (outcome === 'network') {
        throw new Error('ECONNREFUSED');
      }
      return json(outcome.status, { message: 'error' }, outcome.retryAfter ? { 'Retry-After': outcome.retryAfter } : {});
    }
    if (pathname === '/user') {
      return json(200, { id: BOT_ID, username: 'project_bot' });
    }
    const userMatch = /^\/users\/(\d+)$/.exec(pathname);
    if (userMatch && method === 'GET') {
      const user = options.users?.[Number(userMatch[1])];
      return user ? json(200, { id: Number(userMatch[1]), ...user }) : json(404, {});
    }
    const project = /^\/projects\/([^/]+)(\/.*)$/.exec(pathname);
    if (!project) {
      return json(404, {});
    }
    const rest = project[2];
    if (method === 'GET' && rest === '/issues') {
      const label = parsed.searchParams.get('labels');
      const list = [...state.values()].filter((issue) => (label ? issue.labels.includes(label) : true));
      return paged(parsed, list.map(view));
    }
    const issueMatch = /^\/issues\/(\d+)(\/.*)?$/.exec(rest);
    if (issueMatch) {
      const issue = state.get(Number(issueMatch[1]));
      if (!issue) {
        return json(404, {});
      }
      const sub = issueMatch[2] ?? '';
      if (method === 'GET' && sub === '') {
        return json(200, view(issue));
      }
      if (method === 'PUT' && sub === '') {
        const add = String(body?.add_labels ?? '').split(',').filter(Boolean);
        const remove = String(body?.remove_labels ?? '').split(',').filter(Boolean);
        issue.labels = [...issue.labels.filter((label) => !remove.includes(label)), ...add.filter((label) => !issue.labels.includes(label))];
        return json(200, view(issue));
      }
      if (method === 'GET' && sub === '/notes') {
        return paged(parsed, issue.notes.map((note) => ({ id: note.id, body: note.body, author: { id: note.authorId } })));
      }
      if (method === 'POST' && sub === '/notes') {
        const note = { id: ++noteId, body: String(body?.body ?? ''), authorId: BOT_ID };
        issue.notes.push(note);
        return json(201, { id: note.id, body: note.body, author: { id: BOT_ID } });
      }
      if (method === 'GET' && sub === '/related_merge_requests') {
        return paged(parsed, (issue.mergeRequests ?? []).map((iid) => ({ iid })));
      }
    }
    if (method === 'GET' && rest === '/members/all') {
      return paged(parsed, options.members ?? []);
    }
    if (rest === '/merge_requests' && method === 'GET') {
      const source = parsed.searchParams.get('source_branch');
      return paged(parsed, [...mergeRequests.values()].filter((mr) => source === null || mr.source_branch === source));
    }
    if (rest === '/merge_requests' && method === 'POST') {
      const iid = Math.max(0, ...mergeRequests.keys()) + 1;
      const mr = { iid, state: 'opened', ...body };
      mergeRequests.set(iid, mr);
      return json(201, mr);
    }
    const mrOnly = /^\/merge_requests\/(\d+)$/.exec(rest);
    if (mrOnly && method === 'GET') {
      const mr = mergeRequests.get(Number(mrOnly[1]));
      return mr ? json(200, mr) : json(404, {});
    }
    const mrMatch = /^\/merge_requests\/(\d+)\/(notes|pipelines)$/.exec(rest);
    if (mrMatch && method === 'GET') {
      const iid = Number(mrMatch[1]);
      if (mrMatch[2] === 'notes') {
        return paged(parsed, (mrNotes.get(iid) ?? []).map((note) => ({ id: note.id, body: note.body, author: { id: note.authorId } })));
      }
      const status = pipelines.get(iid);
      return json(200, status ? [{ id: 1, status }] : []);
    }
    return json(404, {});
  };
  return {
    fetch: doFetch,
    requests,
    issues: state,
    mrNotes,
    mergeRequests,
    pipelines,
    failNext: (match, outcome) => failures.push({ match, outcome }),
    failPage: (path, page, outcome) => pageFailures.push({ path, page, outcome }),
  };
}

export function writes(requests: FakeRequest[]): FakeRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}
