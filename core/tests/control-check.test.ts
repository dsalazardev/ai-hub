import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runEnroll, PROFILE } from '../src/control/enroll.js';
import { setControlDeps } from '../src/control/cli.js';
import {
  APPROVER,
  BOT_TOKEN,
  CHANNEL,
  creating,
  fakeHermes,
  treeHash,
  type FakeHermes,
} from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** init-fiabilidad 8.8: perfil completo, solo lectura, componentes y causa accionable. */

let h: Harness;
let hermes: FakeHermes;

beforeEach(async () => {
  h = await harness();
  await h.consumer();
  hermes = await fakeHermes(h.root);
});

afterEach(async () => {
  await h.dispose();
});

const profileDir = (): string => path.join(hermes.home, 'profiles', PROFILE);
const envFile = (): string => path.join(profileDir(), '.env');

async function completeProfile(): Promise<void> {
  const initial = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
  expect(initial.code, initial.lines.join('\n')).toBe(0);
  await fs.appendFile(
    envFile(),
    [
      `DISCORD_BOT_TOKEN=${BOT_TOKEN}`,
      `DISCORD_ALLOWED_USERS=${APPROVER}`,
      `DISCORD_ALLOWED_CHANNELS=${CHANNEL}`,
      `DISCORD_HOME_CHANNEL=${CHANNEL}`,
      '',
    ].join('\n'),
  );
}

const READ_ONLY = (args: string[]): boolean => {
  const rest = args[0] === '-p' ? args.slice(2) : args;
  return rest.includes('list') || (rest[0] === 'gateway' && rest[1] === 'status') || rest[0] === '--version';
};

describe('init-fiabilidad 8.8 — enroll --check completo', () => {
  it('complete profile exits 0 and lists each component without secrets', async () => {
    await completeProfile();
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    const text = outcome.lines.join('\n');
    for (const component of ['perfil', 'configuración', 'canal', 'aprobadores', 'skill', 'scripts', 'identidad', 'webhook', 'ruta', 'cron', 'modelo', 'gateway']) {
      expect(text).toContain(component);
    }
    expect(text).toContain('[OK]');
    expect(text).toContain('[NO VERIFICABLE] modelo');
    expect(text).not.toContain(BOT_TOKEN);
    expect(outcome.missing ?? []).toEqual([]);
  });

  it('read-only: the tree stays byte-identical and only read-only commands run', async () => {
    await completeProfile();
    // webhook-operativo: el config.yaml del perfil ya lleva platforms.webhook; el modelo se añade sin borrarlo.
    await fs.appendFile(path.join(profileDir(), 'config.yaml'), 'model: provider/model\n');
    const before = [await treeHash(h.root), await treeHash(hermes.home)];
    hermes.calls.length = 0;
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect([await treeHash(h.root), await treeHash(hermes.home)]).toEqual(before);
    expect(creating(hermes.calls)).toEqual([]);
    expect(hermes.calls.every((args) => READ_ONLY(args))).toBe(true);
  });

  it('route missing is reported with enroll --yes and exits 1', async () => {
    await completeProfile();
    hermes.routes.clear();
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-route');
    expect(outcome.lines.join('\n')).toContain('[FAIL] ruta: ai-hub-gitlab');
    expect(outcome.action).toBe('ai-hub control enroll --yes');
  });

  it('a profile alone is incomplete and names the missing components', async () => {
    await fs.mkdir(profileDir(), { recursive: true });
    await fs.writeFile(envFile(), 'DISCORD_BOT_TOKEN=sentinel\n');
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(outcome.code).toBe(1);
    expect(outcome.missing).toEqual(expect.arrayContaining(['skill', 'scripts', 'identidad', 'ruta', 'cron']));
    expect(creating(hermes.calls)).toEqual([]);
  });

  it('a gateway that is not installed is reported as not verifiable and does not fail', async () => {
    await completeProfile();
    hermes.gatewayInstalled = false;
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(outcome.lines.join('\n')).toContain('[NO VERIFICABLE] gateway');
  });

  it('a gateway installed but stopped fails with the restart action', async () => {
    await completeProfile();
    hermes.gatewayRunning = false;
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('gateway');
    expect(outcome.action).toBe('hermes gateway restart');
  });
});

describe('fabrica-verificable 1.3 — el check decide por la evidencia del dueño del listener', () => {
  const STORE_SECRET = 'AIHUB_STORE_SECRET_SENTINEL_check';

  async function multiplexed(): Promise<void> {
    hermes.topology = 'multiplex';
    const initial = await runEnroll(h.root, { mode: 'yes', host: hermes.host, webhookOwner: 'default' });
    expect(initial.code, initial.lines.join('\n')).toBe(0);
    await fs.appendFile(
      envFile(),
      [`DISCORD_BOT_TOKEN=${BOT_TOKEN}`, `DISCORD_ALLOWED_USERS=${APPROVER}`, `DISCORD_ALLOWED_CHANNELS=${CHANNEL}`, `DISCORD_HOME_CHANNEL=${CHANNEL}`, ''].join('\n'),
    );
    // El store del dueño del listener, tal como lo escribe Hermes: la ruta ligada al perfil de control, con su secreto.
    await fs.writeFile(
      path.join(hermes.home, 'webhook_subscriptions.json'),
      JSON.stringify({ 'ai-hub-gitlab': { profile: PROFILE, events: ['Issue Hook', 'Merge Request Hook'], secret: STORE_SECRET, script: 'gitlab-route.sh' } }),
    );
  }

  it('listening, route in the owner store and `webhook list` exiting 1: exit 0, both present, owner named', async () => {
    await multiplexed();
    hermes.failOn.set('webhook list', { status: 1, stdout: 'Webhook platform is not enabled. To set it up:' });
    hermes.calls.length = 0;
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    const text = outcome.lines.join('\n');
    expect(outcome.code, text).toBe(0);
    expect(text).toContain('[OK] webhook: plataforma habilitada y escuchando en 127.0.0.1:8644');
    expect(text).toContain('[OK] ruta: ai-hub-gitlab');
    expect(text).toMatch(/listener: dueño "default" \(según /);
    expect(text).toMatch(/aviso: .*webhook list/);
    expect(text).not.toContain('[FAIL]');
    expect(text).not.toContain(STORE_SECRET);
    expect(creating(hermes.calls)).toEqual([]);
  });

  it('`gateway status` exiting 1 with the same evidence: the owner is resolved by evidence', async () => {
    await multiplexed();
    hermes.failOn.set('gateway status', { status: 1, stdout: '', stderr: 'gateway status unavailable' });
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    const text = outcome.lines.join('\n');
    expect(outcome.code, text).toBe(0);
    expect(text).toContain('[OK] webhook');
    expect(text).toContain('[OK] ruta: ai-hub-gitlab');
    expect(text).toMatch(/listener: dueño "default" \(según la evidencia/);
  });

  it('declared but not listening names the restart and --check --wait', async () => {
    await multiplexed();
    hermes.listener = { loaded: false, port: null, secretFromEnv: false };
    const outcome = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    const text = outcome.lines.join('\n');
    expect(outcome.code).toBe(1);
    expect(text).toContain('declarado pero no escucha');
    expect(text).toContain('--check --wait');
    expect(text).toContain('[OK] ruta: ai-hub-gitlab');
  });

  it('--check --wait waits read-only, and --wait without --check or with a bad value exits 2', async () => {
    await multiplexed();
    setControlDeps({ hermesHost: hermes.host });
    hermes.calls.length = 0;
    const waited = await h.cli(['control', 'enroll', '--check', '--wait']);
    expect(waited.code, waited.out + waited.err).toBe(0);
    expect(creating(hermes.calls)).toEqual([]);
    expect((await h.cli(['control', 'enroll', '--yes', '--wait'])).code).toBe(2);
    expect((await h.cli(['control', 'enroll', '--check', '--wait', '901'])).code).toBe(2);
    expect(creating(hermes.calls)).toEqual([]);
  });
});
