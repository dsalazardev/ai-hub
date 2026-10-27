import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { runCli } from '../src/cli/run.js';
import { loadEngine } from '../src/engine/engine.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner, type FakeOptions, type FakeRunner } from './speckit-fake.js';

let root: string;

async function cli(
  argv: string[],
  fake: FakeRunner = fakeRunner(),
): Promise<{ code: number; out: string; fake: FakeRunner }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd: root, io, exec: fake.run });
  return { code, out: out.join('\n'), fake };
}

async function entries(): Promise<string[]> {
  return (await fs.readdir(root)).sort();
}

async function seedRepo(): Promise<void> {
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-speckit-preflight-'));
  await seedRepo();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('plan (2.2)', () => {
  it('hashes the speckit intent and reports the environment outside the hash', async () => {
    const withTools = JSON.parse((await cli(['init', '--dry-run'])).out);
    const without = JSON.parse(
      (await cli(['init', '--dry-run'], fakeRunner({ missing: ['uvx', 'bash'] }))).out,
    );
    expect(withTools.speckit).toEqual({
      managed: true,
      package: 'specify-cli',
      version: '1.2.3',
      excludeNewer: (await loadEngine()).speckit.excludeNewer,
      script: 'sh',
      defaultIntegration: 'claude',
      integrations: ['claude', 'opencode', 'pi', 'cursor-agent'],
      extensions: { assess: '1.0.1', bug: '1.0.1' },
    });
    expect(withTools.environment).toMatchObject({ uvx: 'found', shell: 'found' });
    expect(without.environment).toMatchObject({ uvx: 'missing', shell: 'missing' });
    expect(withTools.hash).toBe(without.hash);
    expect(await entries()).toEqual(['package.json']);
  });

  it('changes the hash when script or targets change', async () => {
    const base = JSON.parse((await cli(['init', '--dry-run'])).out).hash;
    const fewer = JSON.parse((await cli(['init', '--dry-run', '--targets', 'claude,pi'])).out);
    expect(fewer.hash).not.toBe(base);
    expect(fewer.speckit.integrations).toEqual(['claude', 'pi']);
    const noSpeckit = JSON.parse((await cli(['init', '--dry-run', '--no-speckit'])).out);
    expect(noSpeckit.hash).not.toBe(base);
    expect(noSpeckit.speckit.managed).toBe(false);
  });
});

describe('preflight (2.3, 2.4)', () => {
  const failing: Array<[string, FakeOptions, RegExp]> = [
    ['missing uv', { missing: ['uvx'] }, /uv no está disponible[\s\S]*--no-speckit/],
    ['offline without cache', { offline: true }, /no se pudo resolver specify-cli==1\.2\.3[\s\S]*sin red/],
    ['missing bash', { missing: ['bash'] }, /bash no está disponible[\s\S]*Git Bash[\s\S]*speckit\.script: ps/],
    ['broken bash launcher', { brokenBash: true }, /bash no está disponible/],
  ];
  for (const [name, options, message] of failing) {
    it(`exits 2 without writing: ${name}`, async () => {
      const result = await cli(['init', '--yes', '--preset-only'], fakeRunner(options));
      expect(result.code).toBe(2);
      expect(result.out).toMatch(message);
      expect(await entries()).toEqual(['package.json']);
      expect(result.fake.specifyCalls().filter((call) => call.includes('init'))).toHaveLength(0);
    });
  }

  it('checks pwsh instead of bash when the script is ps', async () => {
    await cli(['init', '--yes', '--preset-only', '--no-speckit']);
    const manifestFile = path.join(root, 'manifest.yaml');
    const manifest = parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.speckit = { managed: true, script: 'ps' };
    const { stringify } = await import('yaml');
    await fs.writeFile(manifestFile, stringify(manifest), 'utf8');
    const result = await cli(['install'], fakeRunner({ missing: ['bash'] }));
    expect(result.fake.calls.some((call) => call[0] === 'pwsh')).toBe(true);
    expect(result.fake.calls.some((call) => call[0] === 'bash')).toBe(false);
  });
});

describe('--no-speckit and reactivation (2.5)', () => {
  it('records managed: false and runs nothing', async () => {
    const result = await cli(['init', '--yes', '--preset-only', '--no-speckit']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('degradado');
    expect(result.fake.calls).toHaveLength(0);
    const manifest = parse(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')) as {
      speckit?: { managed?: boolean };
    };
    expect(manifest.speckit).toEqual({ managed: false });
  });

  it('install without the flag re-enables Spec Kit and doctor is healthy', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--no-speckit'])).code).toBe(0);
    expect((await cli(['doctor'])).code).toBe(1);
    const installed = await cli(['install']);
    expect(installed.code).toBe(0);
    const manifest = parse(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')) as {
      speckit?: { managed?: boolean };
    };
    expect(manifest.speckit?.managed).toBe(true);
    await expect(fs.access(path.join(root, '.specify', 'init-options.json'))).resolves.toBeUndefined();
    const doctor = await cli(['doctor']);
    expect(doctor.out).not.toContain('[FAIL]');
    expect(doctor.code).toBe(0);
  });

  it('install --no-speckit keeps managed: false', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--no-speckit'])).code).toBe(0);
    expect((await cli(['install', '--no-speckit'])).code).toBe(0);
    const manifest = parse(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')) as {
      speckit?: { managed?: boolean };
    };
    expect(manifest.speckit?.managed).toBe(false);
  });
});
