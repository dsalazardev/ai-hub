import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { runCli } from '../src/cli/run.js';
import { loadEngine } from '../src/engine/engine.js';
import type { CliIO } from '../src/cli/types.js';
import { satisfiesRange } from '../src/speckit/version.js';
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

describe('plan (2.2, 4.1)', () => {
  it('hashes the resolved version, names the range when nothing resolves, and keeps the environment outside the hash', async () => {
    const engine = await loadEngine();
    const withTools = JSON.parse((await cli(['init', '--dry-run'])).out);
    const without = JSON.parse(
      (await cli(['init', '--dry-run'], fakeRunner({ missing: ['uvx', 'bash'] }))).out,
    );
    expect(withTools.speckit).toMatchObject({
      managed: true,
      package: 'specify-cli',
      supported: '>=1.2.3 <1.3.0',
      script: 'sh',
      defaultIntegration: 'claude',
      integrations: ['claude', 'opencode', 'pi', 'cursor-agent'],
      extensions: { assess: '1.0.1', bug: '1.0.1' },
    });
    expect(satisfiesRange(withTools.speckit.version, engine.speckit.supported)).toBe(true);
    expect(withTools.environment).toMatchObject({ uvx: 'found', shell: 'found' });
    expect(withTools.environment.version).toBe(withTools.speckit.version);
    // Sin herramientas no hay resolución: el plan nombra el rango y el hash no depende de la máquina.
    expect(without.speckit.version).toBeNull();
    expect(without.speckit.supported).toBe('>=1.2.3 <1.3.0');
    expect(without.environment).toMatchObject({ uvx: 'missing', shell: 'missing', version: null });
    expect(await entries()).toEqual(['package.json']);
  });

  it('ignores the shell in the hash but follows the resolved version', async () => {
    const withBash = JSON.parse((await cli(['init', '--dry-run'])).out);
    const withoutBash = JSON.parse((await cli(['init', '--dry-run'], fakeRunner({ missing: ['bash'] }))).out);
    expect(withoutBash.hash).toBe(withBash.hash);
    const unresolved = JSON.parse((await cli(['init', '--dry-run'], fakeRunner({ missing: ['uvx'] }))).out);
    const unresolvedAgain = JSON.parse((await cli(['init', '--dry-run'], fakeRunner({ missing: ['uvx'] }))).out);
    expect(unresolved.hash).toBe(unresolvedAgain.hash);
    expect(unresolved.hash).not.toBe(withBash.hash);
  });

  it('changes the hash when the resolved version, script or targets change', async () => {
    const base = JSON.parse((await cli(['init', '--dry-run'])).out);
    const fewer = JSON.parse((await cli(['init', '--dry-run', '--targets', 'claude,pi'])).out);
    expect(fewer.hash).not.toBe(base.hash);
    expect(fewer.speckit.integrations).toEqual(['claude', 'pi']);
    const noSpeckit = JSON.parse((await cli(['init', '--dry-run', '--no-speckit'])).out);
    expect(noSpeckit.hash).not.toBe(base.hash);
    expect(noSpeckit.speckit.managed).toBe(false);
    const otherVersion = JSON.parse((await cli(['init', '--dry-run'], fakeRunner({ resolveVersion: '1.2.4' }))).out);
    expect(otherVersion.speckit.version).not.toBe(base.speckit.version);
    expect(otherVersion.hash).not.toBe(base.hash);
  });
});

describe('preflight (2.3, 2.4)', () => {
  const failing: Array<[string, FakeOptions, RegExp]> = [
    ['missing uv', { missing: ['uvx'] }, /uv no está disponible[\s\S]*--no-speckit/],
    ['offline without cache', { offline: true }, /no se pudo resolver el rango soportado de specify-cli \(>=1\.2\.3 <1\.3\.0\)[\s\S]*sin red/],
    ['missing bash', { missing: ['bash'] }, /probados: bash[\s\S]*Git for Windows[\s\S]*ai-hub init --script ps/],
    ['broken bash launcher', { brokenBash: true }, /probados: bash/],
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

  it('offers the exact flag and never a missing manifest when no shell runs', async () => {
    const result = await cli(['init', '--yes', '--preset-only'], fakeRunner({ missing: ['bash'] }));
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/probados: bash/);
    expect(result.out).toContain('Git for Windows');
    expect(result.out).toContain('ai-hub init --script ps');
    expect(result.out).not.toContain('manifest.yaml');
    expect(await entries()).toEqual(['package.json']);
  });

  it('offers ai-hub install --script ps when the preflight comes from install', async () => {
    await cli(['init', '--yes', '--preset-only', '--no-speckit']);
    const result = await cli(['install'], fakeRunner({ missing: ['bash'] }));
    expect(result.code).toBe(2);
    expect(result.out).toContain('ai-hub install --script ps');
  });
});

describe('py preflight (script-choice 4.3)', () => {
  it('passes when a Python interpreter runs and records py', async () => {
    const result = await cli(['init', '--yes', '--preset-only', '--script', 'py']);
    expect(result.code, result.out).toBe(0);
    expect(result.fake.calls.some((call) => call[0] === 'python')).toBe(true);
    const manifest = parse(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).script).toBe('py');
  });

  it('exits 2 without writing when no interpreter runs, naming Python and both alternatives', async () => {
    const result = await cli(
      ['init', '--yes', '--preset-only', '--script', 'py'],
      fakeRunner({ missing: ['python', 'python3', 'py'] }),
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/probados: python, python3, py/);
    expect(result.out).toContain('Instala Python');
    expect(result.out).toContain('ai-hub init --script sh');
    expect(result.out).toContain('ai-hub init --script ps');
    expect(await entries()).toEqual(['package.json']);
    expect(result.fake.specifyCalls().filter((call) => call.includes('init'))).toHaveLength(0);
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
