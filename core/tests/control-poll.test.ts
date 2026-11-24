import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthPath, readHealth } from '../src/control/health.js';
import { runPoll, type PollHost } from '../src/control/poll.js';
import { setTrackerSleep, type TrackerFetch } from '../src/control/tracker.js';
import { readRunEvents } from '../src/harness/runs.js';
import { fakeGitlab, TOKEN_SENTINEL, writes, type FakeGitlab } from './control-fake.js';
import { NOW, harness, issue, type Harness } from './control-harness.js';

/** Salud del poll (4.21–4.28, R-009–R-011, R-043): dobles de tracker y de Hermes; ningún servicio real. */

/** Cuenta las escrituras del poll sin cambiarlas (passthrough). */
const counts = vi.hoisted(() => ({ apply: 0, expire: 0 }));
vi.mock('../src/control/apply.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/control/apply.js')>();
  return {
    ...real,
    applyPreapproved: async (...args: Parameters<typeof real.applyPreapproved>) => {
      counts.apply += 1;
      return real.applyPreapproved(...args);
    },
    expireDecisions: async (...args: Parameters<typeof real.expireDecisions>) => {
      counts.expire += 1;
      return real.expireDecisions(...args);
    },
  };
});

let h: Harness;
beforeEach(async () => {
  h = await harness();
  setTrackerSleep(async () => undefined);
});
afterEach(async () => {
  setTrackerSleep(null);
  await h.dispose();
});

const SENTINEL_BODY = `upstream says ${TOKEN_SENTINEL}`;

/** Tracker con interruptor de caída: mientras `down` > 0, cada GET responde 503 con un centinela en el cuerpo. */
function flaky(gitlab: FakeGitlab): { fetch: TrackerFetch; down: { count: number } } {
  const down = { count: 0 };
  const fetch: TrackerFetch = async (url, init) => {
    if (down.count > 0 && (init.method ?? 'GET') === 'GET') {
      down.count -= 1;
      return { status: 503, json: async () => ({ message: SENTINEL_BODY }), headers: { get: () => null } };
    }
    return gitlab.fetch(url, init);
  };
  return { fetch, down };
}

function host(jobs: string[] | null = ['ai-hub-control-poll']): PollHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cronJobs: async () => jobs,
    pause: async (job) => {
      calls.push(`pause ${job}`);
      return true;
    },
    resume: async (job) => {
      calls.push(`resume ${job}`);
      return true;
    },
    gatewayStarting: async () => false,
  };
}

async function consumer(): Promise<FakeGitlab> {
  await h.consumer();
  await h.feature('001-alpha');
  const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev')]);
  h.use(gitlab);
  return gitlab;
}

/** Un fallo de lectura completo: los tres intentos del GET (1 + 2 reintentos) fallan. */
const OUTAGE_GETS = 3;

describe('salud del poll (4.21, R-009)', () => {
  it('estado corrupto: bytes preservados, aviso una sola vez y ninguna acción de circuito ni decisión', async () => {
    const gitlab = await consumer();
    const file = healthPath(h.root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ roto');
    const before = await fs.readFile(file);
    const fake = host(['ai-hub-control-poll', 'ai-hub-control-poll-probe']);
    const first = await runPoll(h.root, { now: NOW, trackerFetch: gitlab.fetch, host: fake });
    const second = await runPoll(h.root, { now: NOW, trackerFetch: gitlab.fetch, host: fake });
    expect(first.code).toBe(1);
    expect(first.lines.join('\n')).toContain('health_corrupt');
    expect(second.lines).toEqual([]);
    expect((await fs.readFile(file)).equals(before)).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(gitlab.requests).toEqual([]);
  });

  it('el estado y la telemetría guardan clase y duración, nunca el centinela de la respuesta', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    down.count = OUTAGE_GETS;
    const result = await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: host() });
    expect(result.code).toBe(1);
    const health = await readHealth(h.root);
    expect(health).toMatchObject({ kind: 'ok', health: { failures: 1, failureClass: 'http_5xx', notified: true } });
    const text = await fs.readFile(healthPath(h.root), 'utf8');
    const events = await readRunEvents(h.root, 'control-poll');
    expect(events.at(-1)).toMatchObject({ v: 2, kind: 'note', note_type: 'health', failure_class: 'http_5xx', http_status: 503 });
    expect(typeof events.at(-1)?.duration_ms).toBe('number');
    for (const value of [text, JSON.stringify(events), result.lines.join('\n')]) {
      expect(value).not.toContain(TOKEN_SENTINEL);
    }
  });
});

describe('avisos de caída y recuperación (4.22, 4.23, 4.28, R-010)', () => {
  it('ocho fallos y un éxito: exactamente dos avisos (sin sonda no se pausa)', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    const fake = host(['ai-hub-control-poll']);
    const notices: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      down.count = OUTAGE_GETS;
      notices.push(...(await runPoll(h.root, { now: new Date(NOW.getTime() + run * 900_000), trackerFetch: fetch, host: fake })).lines);
    }
    notices.push(...(await runPoll(h.root, { now: new Date(NOW.getTime() + 9 * 900_000), trackerFetch: fetch, host: fake })).lines);
    const outage = notices.filter((line) => line.includes('el tracker falla'));
    const recovery = notices.filter((line) => line.includes('responde de nuevo'));
    expect(outage).toHaveLength(1);
    expect(recovery).toHaveLength(1);
    expect(outage[0]).toContain('cron pause ai-hub-control-poll');
    expect(outage[0]).toContain('cron resume ai-hub-control-poll');
    expect(fake.calls).toEqual([]);
  });

  it('un fallo recuperado por reintento no avisa ni cuenta', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    down.count = 1;
    const result = await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: host() });
    expect(result).toEqual({ code: 0, lines: [] });
    expect(await readHealth(h.root)).toMatchObject({ kind: 'ok', health: { failures: 0, notified: false } });
  });

  it('con un reintento de lectura, apply --preapproved y expire corren una sola vez', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    down.count = 1;
    Object.assign(counts, { apply: 0, expire: 0 });
    const result = await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: host() });
    expect(result.code).toBe(0);
    expect(counts).toEqual({ apply: 1, expire: 1 });
    expect(writes(gitlab.requests)).toEqual([]);
  });

  it('camino sano: sale 0 sin salida', async () => {
    const gitlab = await consumer();
    const result = await runPoll(h.root, { now: NOW, trackerFetch: gitlab.fetch, host: host() });
    expect(result).toEqual({ code: 0, lines: [] });
  });

  it('el CLI del poll sano no imprime nada y sale 0', async () => {
    await consumer();
    const result = await h.cli(['control', 'poll']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe('');
  });
});

describe('circuito con sonda independiente (4.24, R-011)', () => {
  it('cuatro fallos con sonda instalada pausan el job; la sonda lo reanuda tras leer bien y nunca aplica', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    const fake = host(['ai-hub-control-poll', 'ai-hub-control-poll-probe']);
    for (let run = 0; run < 4; run += 1) {
      down.count = OUTAGE_GETS;
      await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: fake });
    }
    expect(fake.calls).toEqual(['pause ai-hub-control-poll']);
    expect(await readHealth(h.root)).toMatchObject({ kind: 'ok', health: { phase: 'open', failures: 4 } });
    Object.assign(counts, { apply: 0, expire: 0 });
    const probe = await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: fake, probe: true });
    // La sonda solo lee y actualiza la salud: ni aplica ni caduca.
    expect(counts).toEqual({ apply: 0, expire: 0 });
    expect(fake.calls).toEqual(['pause ai-hub-control-poll', 'resume ai-hub-control-poll']);
    expect(probe.lines.join('\n')).toContain('responde de nuevo');
    expect(writes(gitlab.requests)).toEqual([]);
  });

  it('cuatro fallos sin sonda: no pausa', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    const fake = host(['ai-hub-control-poll']);
    for (let run = 0; run < 4; run += 1) {
      down.count = OUTAGE_GETS;
      await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: fake });
    }
    expect(fake.calls).toEqual([]);
  });

  it('gateway arrancando con evidencia: no cuenta el fallo ni avisa', async () => {
    const gitlab = await consumer();
    const { fetch, down } = flaky(gitlab);
    down.count = OUTAGE_GETS;
    const result = await runPoll(h.root, { now: NOW, trackerFetch: fetch, host: { ...host(), gatewayStarting: async () => true } });
    expect(result).toEqual({ code: 0, lines: [] });
    expect(await readHealth(h.root)).toEqual({ kind: 'absent' });
  });
});
