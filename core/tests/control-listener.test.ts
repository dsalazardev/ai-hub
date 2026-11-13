import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveListener, type ListenerView } from '../src/control/listener.js';
import type { HermesCli } from '../src/control/hermes.js';
import type { ProbeResult } from '../src/control/webhook-config.js';
import type { RunResult } from '../src/speckit/runner.js';

/**
 * fabrica-verificable 1.2 (design §D1): un único resolvedor, de solo lectura, decide el dueño del listener, el bloque,
 * la salud del puerto y la presencia de la ruta. La ruta se lee del store del dueño; `webhook list` es un contraste.
 */
const PROFILE = 'hermes-control';
const ROUTE = 'ai-hub-gitlab';
const STORE_SECRET = 'AIHUB_STORE_SECRET_SENTINEL_listener';
const MULTIPLEX = 'Gateway is running via the default-profile multiplexer';

let home: string;
let calls: string[][];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-listener-'));
  calls = [];
  await fs.mkdir(path.join(home, 'profiles', PROFILE), { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const dirOf = (profile: string): string => (profile === 'default' ? home : path.join(home, 'profiles', profile));
const block = (profile: string, port = 8644): Promise<void> =>
  fs.writeFile(path.join(dirOf(profile), 'config.yaml'), `model: x\nplatforms:\n  webhook:\n    enabled: true\n    extra:\n      port: ${port}\n`);
const store = (profile: string, bound: string | null, text?: string): Promise<void> =>
  fs.writeFile(
    path.join(dirOf(profile), 'webhook_subscriptions.json'),
    text ?? JSON.stringify({ [ROUTE]: { events: ['Issue Hook'], secret: STORE_SECRET, script: 'gitlab-route.sh', ...(bound ? { profile: bound } : {}) } }),
  );

interface Script {
  status?: RunResult;
  list?: RunResult;
}
const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const fail = (stdout = '', stderr = ''): RunResult => ({ status: 1, stdout, stderr });

function cli(script: Script): HermesCli {
  return {
    path: 'hermes',
    version: '0.23.0',
    run: async (args) => {
      calls.push(args);
      const rest = args[0] === '-p' ? args.slice(2) : args;
      if (rest[0] === 'gateway' && rest[1] === 'status') {
        return script.status ?? ok('running');
      }
      if (rest[0] === 'webhook' && rest[1] === 'list') {
        return script.list ?? ok('');
      }
      return { status: 2, stdout: '', stderr: 'unexpected' };
    },
  };
}

const resolve = (script: Script, probe: (port: number) => Promise<ProbeResult> = async () => 'listening'): Promise<ListenerView> =>
  resolveListener({ cli: cli(script), home, profile: PROFILE, route: ROUTE, probe });

describe('fabrica-verificable 1.2 — resolveListener', () => {
  it('multiplexer: owner default, shared, enabled, listening and route present from the store', async () => {
    await block('default');
    await store('default', PROFILE);
    const view = await resolve({ status: ok(MULTIPLEX), list: ok(`  ◆ ${ROUTE}`) });
    expect(view).toMatchObject({ gateway: 'running', owner: 'default', shared: true, ownerSource: 'status', port: 8644, health: 'listening', route: 'present', routeSource: 'store', routeProfile: PROFILE });
    expect(view.block.kind).toBe('enabled');
    expect(view.paths.config).toBe(path.join(home, 'config.yaml'));
    expect(view.command(['webhook', 'list'])).toEqual(['webhook', 'list']);
    expect(view.urlPath(ROUTE)).toBe(`/p/${PROFILE}/webhooks/${ROUTE}`);
    expect(view.notices).toEqual([]);
  });

  it('dedicated gateway: owner is the control profile and only its files are read', async () => {
    await block(PROFILE, 9000);
    await store(PROFILE, null);
    await fs.writeFile(path.join(home, 'config.yaml'), 'not: [valid');
    const view = await resolve({ status: ok('running'), list: ok(`  ◆ ${ROUTE}`) });
    expect(view).toMatchObject({ gateway: 'running', owner: PROFILE, shared: false, port: 9000, health: 'listening', route: 'present', routeSource: 'store' });
    expect(view.command(['webhook', 'list'])).toEqual(['-p', PROFILE, 'webhook', 'list']);
    expect(view.urlPath(ROUTE)).toBe(`/webhooks/${ROUTE}`);
  });

  it('no gateway: every listener fact is not verifiable', async () => {
    const view = await resolve({ status: fail('', 'gateway is not installed'), list: fail('Webhook platform is not enabled') }, async () => 'refused');
    expect(view).toMatchObject({ gateway: 'not-installed', route: 'not-verifiable' });
    expect(view.health === 'not-probed' || view.health === 'refused').toBe(true);
  });

  it('status unusable while the listener answers: the owner is decided by evidence and the notice says so', async () => {
    await block('default');
    await store('default', PROFILE);
    const view = await resolve({ status: fail('', 'gateway status unavailable'), list: ok(`  ◆ ${ROUTE}`) });
    expect(view).toMatchObject({ gateway: 'running', owner: 'default', shared: true, ownerSource: 'evidence', health: 'listening', route: 'present' });
    expect(view.notices.join('\n')).toContain('gateway status');
  });

  it('status unusable without evidence keeps the stopped answer', async () => {
    await block('default');
    await store('default', PROFILE);
    const view = await resolve({ status: fail('', 'gateway is not running') }, async () => 'refused');
    expect(view).toMatchObject({ gateway: 'stopped', owner: PROFILE, shared: false });
  });

  it('webhook list failing while the evidence is present: platform and route present, with a notice', async () => {
    await block('default');
    await store('default', PROFILE);
    const view = await resolve({ status: ok(MULTIPLEX), list: fail('Webhook platform is not enabled. To set it up:') });
    expect(view).toMatchObject({ health: 'listening', route: 'present', routeSource: 'store' });
    expect(view.notices.join('\n')).toContain('webhook list');
    expect(view.notices.join('\n')).toContain('exit 1');
  });

  it.each([
    ['missing', null],
    ['not the expected document', '["a","b"]'],
    ['not JSON', '{ nope'],
  ])('store %s: the route comes from webhook list and the source says so', async (_label, text) => {
    await block('default');
    if (text !== null) {
      await store('default', PROFILE, text);
    }
    const view = await resolve({ status: ok(MULTIPLEX), list: ok(`  ◆ ${ROUTE}`) });
    expect(view).toMatchObject({ route: 'present', routeSource: 'list' });
    const absent = await resolve({ status: ok(MULTIPLEX), list: ok('  ◆ other-route') });
    expect(absent).toMatchObject({ route: 'absent' });
  });

  it('a stale enabled block in the control profile does not win over the owner named by the status', async () => {
    await block('default', 8644);
    await block(PROFILE, 9999);
    await store('default', PROFILE);
    const view = await resolve({ status: ok(MULTIPLEX), list: ok(`  ◆ ${ROUTE}`) }, async (port) => (port === 8644 ? 'listening' : 'refused'));
    expect(view).toMatchObject({ owner: 'default', port: 8644, health: 'listening' });
  });

  it('without a CLI (doctor) the owner comes from the files and the port', async () => {
    await block('default', 8644);
    await block(PROFILE, 9999);
    await store('default', PROFILE);
    const view = await resolveListener({ cli: null, home, profile: PROFILE, route: ROUTE, probe: async (port) => (port === 8644 ? 'listening' : 'refused') });
    expect(view).toMatchObject({ gateway: 'unknown', owner: 'default', port: 8644, health: 'listening', route: 'present' });
    expect(calls).toEqual([]);
  });

  it('is read-only and the store secret never leaves it', async () => {
    await block('default');
    await store('default', PROFILE);
    const before = await fs.readdir(home, { recursive: true });
    const view = await resolve({ status: ok(MULTIPLEX), list: fail(`boom ${STORE_SECRET}`) });
    expect(JSON.stringify(view)).not.toContain(STORE_SECRET);
    expect(view.notices.join('\n')).not.toContain(STORE_SECRET);
    expect(await fs.readdir(home, { recursive: true })).toEqual(before);
    expect(calls.every((args) => args.includes('status') || args.includes('list'))).toBe(true);
  });
});
