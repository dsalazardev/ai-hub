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
  /** Falla programada: la próxima petición que case con el método y la ruta devuelve este resultado. */
  failNext(match: { method?: TrackerMethod; path?: RegExp }, outcome: { status: number; retryAfter?: string } | 'network'): void;
}

/** GitLab v4 en memoria: solo las rutas que usa el plano de control; graba cada petición. */
export function fakeGitlab(issues: FakeIssue[]): FakeGitlab {
  const state = new Map(issues.map((issue) => [issue.iid, issue]));
  const requests: FakeRequest[] = [];
  const mrNotes = new Map<number, Array<{ id: number; body: string; authorId: number }>>();
  const pipelines = new Map<number, string>();
  const failures: Array<{ match: { method?: TrackerMethod; path?: RegExp }; outcome: { status: number; retryAfter?: string } | 'network' }> = [];
  let noteId = 1000;
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) => ({
    status,
    json: async () => data,
    headers: { get: (name: string) => headers[name] ?? null },
  });
  const view = (issue: FakeIssue) => ({ iid: issue.iid, title: issue.title, labels: [...issue.labels], description: issue.description });
  const doFetch: TrackerFetch = async (url, init) => {
    const method = init.method ?? 'GET';
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\/api\/v4/, '');
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path: `${pathname}${parsed.search}`, ...(body ? { body } : {}), headers: init.headers });
    const failure = failures.findIndex(
      (item) => (!item.match.method || item.match.method === method) && (!item.match.path || item.match.path.test(pathname)),
    );
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
    const project = /^\/projects\/([^/]+)(\/.*)$/.exec(pathname);
    if (!project) {
      return json(404, {});
    }
    const rest = project[2];
    if (method === 'GET' && rest === '/issues') {
      const label = parsed.searchParams.get('labels');
      const list = [...state.values()].filter((issue) => (label ? issue.labels.includes(label) : true));
      return json(200, list.map(view));
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
        return json(200, issue.notes.map((note) => ({ id: note.id, body: note.body, author: { id: note.authorId } })));
      }
      if (method === 'POST' && sub === '/notes') {
        const note = { id: ++noteId, body: String(body?.body ?? ''), authorId: BOT_ID };
        issue.notes.push(note);
        return json(201, { id: note.id, body: note.body, author: { id: BOT_ID } });
      }
      if (method === 'GET' && sub === '/related_merge_requests') {
        return json(200, (issue.mergeRequests ?? []).map((iid) => ({ iid })));
      }
    }
    const mrMatch = /^\/merge_requests\/(\d+)\/(notes|pipelines)$/.exec(rest);
    if (mrMatch && method === 'GET') {
      const iid = Number(mrMatch[1]);
      if (mrMatch[2] === 'notes') {
        return json(200, (mrNotes.get(iid) ?? []).map((note) => ({ id: note.id, body: note.body, author: { id: note.authorId } })));
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
    pipelines,
    failNext: (match, outcome) => failures.push({ match, outcome }),
  };
}

export function writes(requests: FakeRequest[]): FakeRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}
