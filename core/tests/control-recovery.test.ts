import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { cmdInit } from '../src/cli/onboarding.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import { runEnroll, PROFILE } from '../src/control/enroll.js';
import {
  APPROVER,
  BOT_TOKEN,
  CHANNEL,
  DEFAULT_SOUL,
  SimulatedCrash,
  fakeDiscord,
  fakeHermes,
  filesContaining,
  stepContext,
  type FakeDiscord,
  type FakeHermes,
} from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** init-fiabilidad 8.10: cada acción anunciada en R1–R8 lleva a enroll --check = 0. */

let h: Harness;
let hermes: FakeHermes;
let discord: FakeDiscord;
const CONNECT = ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin'];

beforeEach(async () => {
  h = await harness();
  await h.consumer({ control: false });
  hermes = await fakeHermes(h.root);
  discord = fakeDiscord();
});

afterEach(async () => {
  await h.dispose();
});

const profileDir = (): string => path.join(hermes.home, 'profiles', PROFILE);
const envFile = (): string => path.join(profileDir(), '.env');
const soulFile = (): string => path.join(profileDir(), 'SOUL.md');

async function init(extra: Record<string, unknown> = {}, stdin = `${BOT_TOKEN}\n`, argv = CONNECT) {
  const sink = { out: [] as string[], err: [] as string[] };
  const code = await cmdInit(parseArgs(argv), {
    ...stepContext(h, sink),
    controlHost: hermes.host,
    discordFetch: discord.fetch,
    stdin: async () => stdin,
    ...extra,
  });
  const text = [...sink.out, ...sink.err].join('\n');
  const status = sink.out.at(-1) ?? '';
  return { code, out: sink.out, err: sink.err, text, status };
}

async function check() {
  return runEnroll(h.root, { mode: 'check', host: hermes.host });
}

async function yes() {
  return runEnroll(h.root, { mode: 'yes', host: hermes.host });
}

function action(status: string): string {
  return /^ai-hub-integration: name=control state=\S+ stage=\S+ action=(.*)$/.exec(status)?.[1] ?? '';
}

async function crashAt(stage: string) {
  return init({
    onConnectStage: (done: string) => {
      if (done === stage) {
        throw new SimulatedCrash(done);
      }
    },
  });
}

describe('init-fiabilidad 8.10 — matriz de recuperación', () => {
  it('R1: interrupted after profile creation, before the copy', async () => {
    const crashed = await crashAt('profile');
    expect(crashed.code, crashed.text).toBe(0);
    expect(action(crashed.status)).toContain(`aparta \`${soulFile()}\``);
    expect(action(crashed.status)).toContain('--discord-token-stdin');
    expect(await fs.readFile(soulFile(), 'utf8')).toBe(DEFAULT_SOUL);
    await fs.rename(soulFile(), `${soulFile()}.set-aside`);
    const resumed = await init();
    expect(resumed.code, resumed.text).toBe(0);
    expect((await check()).code).toBe(0);
  });

  it('R2: interrupted after the backup, which completes the adoption', async () => {
    const crashed = await crashAt('identity-backup');
    expect(crashed.code, crashed.text).toBe(0);
    expect(action(crashed.status)).not.toContain('aparta');
    expect(action(crashed.status)).toContain('--discord-token-stdin');
    expect(await fs.readFile(path.join(profileDir(), 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
    const resumed = await init();
    expect(resumed.code, resumed.text).toBe(0);
    expect((await check()).code).toBe(0);
    expect((await fs.readdir(profileDir())).filter((name) => name.startsWith('SOUL.md.pre-ai-hub'))).toEqual(['SOUL.md.pre-ai-hub']);
  });

  it('R3: interrupted after the block, before Discord is saved', async () => {
    const crashed = await crashAt('identity-block');
    expect(crashed.code, crashed.text).toBe(0);
    expect(action(crashed.status)).not.toContain('aparta');
    expect(action(crashed.status)).toContain('--discord-token-stdin');
    expect(await fs.readFile(soulFile(), 'utf8')).toContain('<!-- ai-hub:soul:begin');
    const resumed = await init();
    expect(resumed.code, resumed.text).toBe(0);
    expect((await check()).code).toBe(0);
  });

  it('R4: Discord keys saved without manifest.control; the same token is unchanged', async () => {
    const crashed = await crashAt('env');
    expect(crashed.code, crashed.text).toBe(0);
    expect(action(crashed.status)).toContain('--discord-token-stdin');
    const before = (await fs.readFile(envFile(), 'utf8')).split('\n').find((line) => line.startsWith('DISCORD_BOT_TOKEN='));
    expect((await yes()).code).toBe(1);
    const resumed = await init();
    expect(resumed.code, resumed.text).toBe(0);
    const after = (await fs.readFile(envFile(), 'utf8')).split('\n').find((line) => line.startsWith('DISCORD_BOT_TOKEN='));
    expect(after).toBe(before);
    expect((await loadManifestContext(h.root)).manifest.control).toBeDefined();
    expect((await check()).code).toBe(0);
  });

  it('R5: connection saved, route failure removed, enroll --yes completes without duplicates', async () => {
    hermes.failOn.set('webhook subscribe', { stderr: 'Error: route refused' });
    const failed = await init();
    expect(failed.code, failed.text).toBe(0);
    expect(action(failed.status)).toBe('ai-hub control enroll --yes');
    hermes.failOn.delete('webhook subscribe');
    expect((await yes()).code).toBe(0);
    expect((await check()).code).toBe(0);
    hermes.calls.length = 0;
    expect((await yes()).code).toBe(0);
    expect(hermes.calls.filter((args) => args.includes('subscribe') || (args.includes('cron') && args.includes('create')))).toEqual([]);
  });

  it('R6: profile creation failed and the retake rebuilds everything', async () => {
    hermes.failOn.set('profile create', { stderr: 'profile refused' });
    const failed = await init();
    expect(failed.code, failed.text).toBe(0);
    expect(action(failed.status)).toContain('--discord-token-stdin');
    hermes.failOn.delete('profile create');
    const resumed = await init();
    expect(resumed.code, resumed.text).toBe(0);
    expect((await check()).code).toBe(0);
  });

  it('R7: edited identity after the saved point, set aside and enroll --yes', async () => {
    expect((await init()).code).toBe(0);
    const original = await fs.readFile(soulFile(), 'utf8');
    await fs.writeFile(soulFile(), original.replace('Nunca apruebas', 'Sí apruebas'));
    const pending = await check();
    expect(pending.code).toBe(1);
    expect(pending.stage).toBe('identity');
    expect(pending.action).toContain(`aparta \`${soulFile()}\``);
    expect(pending.action).toContain('ai-hub control enroll --yes');
    await fs.rename(soulFile(), `${soulFile()}.edited`);
    expect((await yes()).code).toBe(0);
    expect((await check()).code).toBe(0);
  });

  it('R8: gateway stopped, restart action reaches check 0', async () => {
    expect((await init()).code).toBe(0);
    hermes.gatewayRunning = false;
    const pending = await check();
    expect(pending.code).toBe(1);
    expect(pending.stage).toBe('gateway');
    expect(pending.action).toBe('hermes gateway restart');
    await hermes.host.exec('hermes', ['gateway', 'restart'], { cwd: h.root });
    expect((await check()).code).toBe(0);
  });
});

describe('init-fiabilidad 9.5 — secretos', () => {
  it('no sentinel crosses stdout, stderr, the repository, the fake home or the ledger', async () => {
    hermes.webhookPlatform = 'model';
    const routeSecret = 'AIHUB_9_5_ROUTE_SECRET_SENTINEL';
    hermes.failOn.set('webhook subscribe', { stderr: `Error: route refused\nSecret: ${routeSecret}` });
    const result = await init();
    expect(result.code, result.text).toBe(0);
    expect(result.text).not.toContain(BOT_TOKEN);
    expect(result.text).not.toContain(routeSecret);
    expect(await filesContaining(h.root, BOT_TOKEN)).toEqual([]);
    expect(await filesContaining(h.root, routeSecret)).toEqual([]);
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual(['profiles/hermes-control/.env']);
    expect(await filesContaining(hermes.home, routeSecret)).toEqual([]);
    expect(await h.ledgerText()).not.toContain(BOT_TOKEN);
    expect(await h.ledgerText()).not.toContain(routeSecret);
  });
});

describe('init-fiabilidad 8.11 — fallo y recuperación de punta a punta', () => {
  it('injected route failure is redacted, leaves the connection saved and enroll recovers', async () => {
    hermes.webhookPlatform = 'model';
    const secret = 'AIHUB_ROUTE_SECRET_SENTINEL_8_11';
    hermes.failOn.set('webhook subscribe', { stderr: `Error: route refused\nSecret: ${secret}` });
    const ideaPath = path.join(h.root, '..', `idea-recovery-${path.basename(h.root)}.md`);
    await fs.writeFile(ideaPath, 'Una idea que sobrevive al fallo.\n');
    const argv = [
      '--preset-only', '--yes', '--idea-file', ideaPath,
      '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin',
    ];
    const failed = await init({}, `${BOT_TOKEN}\n`, argv);
    expect(failed.code, failed.text).toBe(0);
    expect(failed.status).toBe('ai-hub-integration: name=control state=fallida stage=webhook-route action=ai-hub control enroll --yes');
    expect(await fs.readFile(path.join(h.root, 'IDEA.md'), 'utf8')).toContain('Una idea que sobrevive');
    expect(failed.text).not.toContain(secret);
    expect(failed.text).not.toContain('Error inesperado');
    const env = await fs.readFile(envFile(), 'utf8');
    expect(env).toContain('DISCORD_BOT_TOKEN=');
    expect(env).toContain('WEBHOOK_ENABLED=true');
    expect(env).toContain('WEBHOOK_PORT=8644');
    expect((await loadManifestContext(h.root)).manifest.control).toBeDefined();
    expect((await check()).code).toBe(1);

    hermes.failOn.delete('webhook subscribe');
    expect((await yes()).code).toBe(0);
    expect((await check()).code).toBe(0);
    hermes.calls.length = 0;
    expect((await yes()).code).toBe(0);
    expect(hermes.calls.filter((args) => args.includes('subscribe') || (args.includes('cron') && args.includes('create')))).toEqual([]);
    await fs.rm(ideaPath, { force: true });
  });
});
