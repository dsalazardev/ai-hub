import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitlabTracker, setTrackerSleep, TrackerError, type TrackerFetch } from '../src/control/tracker.js';
import { fakeGitlab, TOKEN_SENTINEL, type FakeIssue } from './control-fake.js';

const BASE = 'https://gitlab.test';
let slept: number[];

beforeEach(() => {
  slept = [];
  setTrackerSleep(async (ms) => {
    slept.push(ms);
  });
});
afterEach(() => setTrackerSleep(null));

function issueWithNotes(count: number, evidenceAt: number): FakeIssue {
  return {
    iid: 42,
    title: 't',
    labels: ['ai::in-dev'],
    description: '',
    notes: Array.from({ length: count }, (_, index) => ({ id: index + 1, body: index + 1 === evidenceAt ? 'AI-HUB-STATUS: CONVERGED | artifact=- | reason=-' : `nota ${index + 1}`, authorId: 1 })),
  };
}

function client(fetch: TrackerFetch, maxPages?: number): GitlabTracker {
  return new GitlabTracker(BASE, 'grupo/proyecto', TOKEN_SENTINEL, fetch, maxPages);
}

describe('doble de tracker paginado (3.14)', () => {
  it('sirve 150 elementos en páginas de 100 con x-next-page y con Link rel=next', async () => {
    for (const linkHeader of [false, true]) {
      const gitlab = fakeGitlab([issueWithNotes(150, 120)], { linkHeader });
      const notes = await client(gitlab.fetch).issueNotes(42);
      expect(notes).toHaveLength(150);
      expect(gitlab.requests.filter((request) => request.path.includes('/notes'))).toHaveLength(2);
    }
  });
});

describe('lectura completa (3.15, R-014)', () => {
  it('la evidencia de la página 2 se incluye', async () => {
    const gitlab = fakeGitlab([issueWithNotes(150, 130)]);
    const notes = await client(gitlab.fetch).issueNotes(42);
    expect(notes.find((note) => note.id === 130)?.body).toContain('CONVERGED');
  });

  it('un fallo de la página 2 impide decidir: error de clase incomplete o de red, nunca lista parcial', async () => {
    const gitlab = fakeGitlab([issueWithNotes(150, 130)]);
    gitlab.failPage(/\/issues\/42\/notes$/, 2, { status: 404 });
    const error = await client(gitlab.fetch).issueNotes(42).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as TrackerError).failureClass).toBe('http_4xx');
  });

  it('el tope de páginas configurable convierte el exceso en incompletitud explícita', async () => {
    const gitlab = fakeGitlab([issueWithNotes(150, 1)], { pageSize: 50 });
    const error = await client(gitlab.fetch, 2).issueNotes(42).catch((caught: unknown) => caught);
    expect((error as TrackerError).failureClass).toBe('incomplete');
  });

  it('una lista vacía es válida', async () => {
    const gitlab = fakeGitlab([issueWithNotes(0, 0)]);
    expect(await client(gitlab.fetch).issueNotes(42)).toEqual([]);
  });

  it('nunca sigue una página siguiente de otro origen', async () => {
    const evil: TrackerFetch = async (url) => ({
      status: 200,
      json: async () => Array.from({ length: 100 }, (_, index) => ({ id: index })),
      headers: { get: (name: string) => (name === 'Link' ? `<https://evil.test/api/v4/x?page=2>; rel="next"` : null) },
    });
    const error = await client(evil).issueNotes(1).catch((caught: unknown) => caught);
    expect((error as TrackerError).failureClass).toBe('incomplete');
  });
});

describe('clasificación de fallos (3.16, R-015, R-020)', () => {
  it('cada clase lleva estado, duración y destino saneado', async () => {
    const cases: Array<[{ status: number } | 'network', string, number | null]> = [
      ['network', 'network', null],
      [{ status: 401 }, 'auth', 401],
      [{ status: 404 }, 'http_4xx', 404],
      [{ status: 503 }, 'http_5xx', 503],
      [{ status: 429 }, 'rate_limit', 429],
    ];
    for (const [outcome, failureClass, status] of cases) {
      const gitlab = fakeGitlab([issueWithNotes(1, 0)]);
      for (let index = 0; index < 3; index += 1) {
        gitlab.failNext({ method: 'GET' }, outcome as never);
      }
      const error = (await client(gitlab.fetch).issue(42).catch((caught: unknown) => caught)) as TrackerError;
      expect(error).toMatchObject({ failureClass, status, target: '/issues/42' });
      expect(typeof error.durationMs).toBe('number');
    }
  });

  it('ni la URL con credenciales ni un centinela de la respuesta aparecen', async () => {
    const leaky: TrackerFetch = async () => ({ status: 500, json: async () => ({ message: TOKEN_SENTINEL }), headers: { get: () => null } });
    const tracker = new GitlabTracker(`https://user:${TOKEN_SENTINEL}@gitlab.test`, 'g/p', TOKEN_SENTINEL, leaky);
    const error = (await tracker.issue(1).catch((caught: unknown) => caught)) as TrackerError;
    expect(`${error.message} ${error.target} ${JSON.stringify(error)}`).not.toContain(TOKEN_SENTINEL);
  });
});

describe('reintentos solo de lecturas transitorias (3.17, R-016)', () => {
  it('un GET transitorio se reintenta 3 veces con 2 s y 5 s', async () => {
    const gitlab = fakeGitlab([issueWithNotes(1, 0)]);
    gitlab.failNext({ method: 'GET' }, { status: 503 });
    gitlab.failNext({ method: 'GET' }, 'network');
    expect((await client(gitlab.fetch).issue(42)).iid).toBe(42);
    expect(slept).toEqual([2000, 5000]);
  });

  it('Retry-After hasta 30 s se respeta; más allá no se reintenta', async () => {
    const gitlab = fakeGitlab([issueWithNotes(1, 0)]);
    gitlab.failNext({ method: 'GET' }, { status: 429, retryAfter: '12' });
    await client(gitlab.fetch).issue(42);
    expect(slept).toEqual([12000]);
    gitlab.failNext({ method: 'GET' }, { status: 429, retryAfter: '31' });
    await expect(client(gitlab.fetch).issue(42)).rejects.toMatchObject({ failureClass: 'rate_limit' });
  });

  it('un 401 envía una sola petición', async () => {
    const gitlab = fakeGitlab([issueWithNotes(1, 0)]);
    gitlab.failNext({ method: 'GET' }, { status: 401 });
    await expect(client(gitlab.fetch).issue(42)).rejects.toMatchObject({ failureClass: 'auth' });
    expect(gitlab.requests).toHaveLength(1);
  });

  it('un PUT fallido envía una sola petición', async () => {
    const gitlab = fakeGitlab([issueWithNotes(1, 0)]);
    gitlab.failNext({ method: 'PUT' }, { status: 503 });
    await expect(client(gitlab.fetch).moveLabel(42, 'ai::in-review', [])).rejects.toBeInstanceOf(TrackerError);
    expect(gitlab.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
