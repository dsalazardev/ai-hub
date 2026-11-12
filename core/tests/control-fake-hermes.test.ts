import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SOUL, SimulatedCrash, WEBHOOK_SECRET_SENTINEL, fakeHermes } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** init-fiabilidad 1.3: el Hermes falso modela la plataforma webhook, los fallos inyectados y la siembra del perfil. */

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.dispose();
});

const run = async (hermes: Awaited<ReturnType<typeof fakeHermes>>, args: string[]) => hermes.host.exec('hermes', args, { cwd: h.root });

describe('init-fiabilidad 1.3 — models the webhook platform and the profile seed', () => {
  it('profile create seeds a default SOUL.md and .env before returning, like Hermes 0.23', async () => {
    const hermes = await fakeHermes(h.root);
    const result = await run(hermes, ['profile', 'create', 'hermes-control', '--no-skills']);
    expect(result.status).toBe(0);
    const dir = path.join(hermes.home, 'profiles', 'hermes-control');
    expect(await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe(DEFAULT_SOUL);
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).not.toContain('DISCORD_BOT_TOKEN');
  });

  it('with the platform modeled, webhook list and subscribe exit 1 with the setup hint until WEBHOOK_ENABLED=true', async () => {
    const hermes = await fakeHermes(h.root);
    hermes.webhookPlatform = 'model';
    await run(hermes, ['profile', 'create', 'hermes-control', '--no-skills']);
    const disabled = await run(hermes, ['-p', 'hermes-control', 'webhook', 'list']);
    expect(disabled.status).toBe(1);
    expect(disabled.stdout).toContain('WEBHOOK_ENABLED=true');
    const subscribe = await run(hermes, ['-p', 'hermes-control', 'webhook', 'subscribe', 'ai-hub-gitlab']);
    expect(subscribe.status).toBe(1);
    await fs.appendFile(path.join(hermes.home, 'profiles', 'hermes-control', '.env'), 'WEBHOOK_ENABLED=true\nWEBHOOK_PORT=8644\n');
    expect((await run(hermes, ['-p', 'hermes-control', 'webhook', 'list'])).status).toBe(0);
  });

  it('failOn injects a failure on one subcommand, is recorded, and can be removed between two calls', async () => {
    const hermes = await fakeHermes(h.root);
    await run(hermes, ['profile', 'create', 'hermes-control', '--no-skills']);
    hermes.failOn.set('webhook subscribe', { stderr: `Error: route refused\nSecret: ${WEBHOOK_SECRET_SENTINEL}` });
    const failed = await run(hermes, ['-p', 'hermes-control', 'webhook', 'subscribe', 'ai-hub-gitlab']);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('route refused');
    expect(hermes.calls.at(-1)).toEqual(['-p', 'hermes-control', 'webhook', 'subscribe', 'ai-hub-gitlab']);
    expect(hermes.routes.size).toBe(0);
    hermes.failOn.delete('webhook subscribe');
    const ok = await run(hermes, ['-p', 'hermes-control', 'webhook', 'subscribe', 'ai-hub-gitlab']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`Secret: ${WEBHOOK_SECRET_SENTINEL}`);
    expect([...hermes.routes]).toEqual(['ai-hub-gitlab']);
  });

  it('gateway status is configurable', async () => {
    const hermes = await fakeHermes(h.root);
    hermes.gatewayRunning = false;
    expect((await run(hermes, ['gateway', 'status'])).status).toBe(1);
    hermes.gatewayRunning = true;
    expect((await run(hermes, ['gateway', 'status'])).status).toBe(0);
  });

  it('crashAfter completes the named command and then simulates the process dying, leaving the tree as it is', async () => {
    const hermes = await fakeHermes(h.root);
    hermes.crashAfter = 'profile create';
    await expect(run(hermes, ['profile', 'create', 'hermes-control', '--no-skills'])).rejects.toBeInstanceOf(SimulatedCrash);
    const dir = path.join(hermes.home, 'profiles', 'hermes-control');
    expect(await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe(DEFAULT_SOUL);
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['.env', 'SOUL.md']));
  });
});
