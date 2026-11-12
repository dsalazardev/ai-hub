import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runEnroll, PROFILE } from '../src/control/enroll.js';
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

const READ_ONLY = (args: string[]): boolean =>
  args.includes('list') || (args[0] === 'gateway' && args[1] === 'status') || args[0] === '--version';

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
    await fs.writeFile(path.join(profileDir(), 'config.yaml'), 'model: provider/model\n');
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
