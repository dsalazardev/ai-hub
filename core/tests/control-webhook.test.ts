import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runEnroll, PROFILE } from '../src/control/enroll.js';
import { DEFAULT_PROFILE_ENV, fakeHermes, treeHash, type FakeHermes } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** init-fiabilidad 8.3: preflight de la plataforma webhook y habilitación mínima, sin fallo inyectado. */

let h: Harness;
let hermes: FakeHermes;

beforeEach(async () => {
  h = await harness();
  await h.consumer();
  hermes = await fakeHermes(h.root);
  hermes.webhookPlatform = 'model';
});

afterEach(async () => {
  await h.dispose();
});

const profileDir = () => path.join(hermes.home, 'profiles', PROFILE);
const envFile = () => path.join(profileDir(), '.env');

async function seedProfile(env = DEFAULT_PROFILE_ENV): Promise<void> {
  await fs.mkdir(profileDir(), { recursive: true });
  await fs.writeFile(envFile(), env);
}

const creating = (): string[][] =>
  hermes.calls.filter((args) => args.includes('subscribe') || (args.includes('cron') && args.includes('create')));

describe('init-fiabilidad 8.3 — plataforma webhook', () => {
  it('platform disabled then route created, adding only the missing keys', async () => {
    const outcome = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    const env = await fs.readFile(envFile(), 'utf8');
    expect(env).toContain('WEBHOOK_ENABLED=true');
    expect(env).toContain('WEBHOOK_PORT=8644');
    expect(env).toContain('# Hermes profile credentials');
    const lists = hermes.calls.filter((args) => args.includes('webhook') && args.includes('list'));
    expect(lists).toHaveLength(2);
    expect(hermes.calls.filter((args) => args.includes('subscribe'))).toHaveLength(1);
    expect(env).not.toContain('WEBHOOK_SECRET');
  });

  it('platform already enabled leaves the profile .env byte-identical', async () => {
    const original = `${DEFAULT_PROFILE_ENV}WEBHOOK_ENABLED=true\nWEBHOOK_PORT=9000\n`;
    await seedProfile(original);
    const outcome = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(await fs.readFile(envFile(), 'utf8')).toBe(original);
    expect(hermes.calls.filter((args) => args.includes('subscribe'))).toHaveLength(1);
  });

  it('an incompatible value is reported without changing it or subscribing', async () => {
    const original = `${DEFAULT_PROFILE_ENV}WEBHOOK_ENABLED=false\n`;
    await seedProfile(original);
    const outcome = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    expect(outcome.lines.join('\n')).toContain('WEBHOOK_ENABLED');
    expect(await fs.readFile(envFile(), 'utf8')).toBe(original);
    expect(hermes.calls.filter((args) => args.includes('subscribe'))).toEqual([]);
  });

  it('--dry-run names the two keys it would add and writes nothing', async () => {
    const before = await treeHash(hermes.home);
    const outcome = await runEnroll(h.root, { mode: 'dry-run', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    const text = outcome.lines.join('\n');
    expect(text).toContain('WEBHOOK_ENABLED=true');
    expect(text).toContain('WEBHOOK_PORT=8644');
    expect(await treeHash(hermes.home)).toBe(before);
    expect(creating()).toEqual([]);
  });

  it('an existing route is not subscribed again', async () => {
    await seedProfile();
    hermes.routes.add('ai-hub-gitlab');
    const outcome = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(hermes.calls.filter((args) => args.includes('subscribe'))).toEqual([]);
  });
});
