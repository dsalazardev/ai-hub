import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { loadEngine } from '../src/engine/engine.js';
import { probeShell, uvxPrefix } from '../src/speckit/commands.js';
import { defaultRunner } from '../src/speckit/runner.js';
import { effectiveSpeckit } from '../src/speckit/settings.js';
import { gitUnavailable, runGit } from './git.js';

/**
 * Pruebas con uvx y bash reales. Usan una caché de uv aislada y compartida entre corridas
 * (no la del usuario) para no descargar specify-cli en cada test.
 */
const SHARED_CACHE = path.join(os.tmpdir(), 'ai-hub-test-uv-cache');
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) {
    savedEnv[name] = process.env[name];
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

let root: string;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd: root, io });
  return { code, out: out.join('\n') };
}

beforeAll(async () => {
  await fs.mkdir(SHARED_CACHE, { recursive: true });
  setEnv('UV_CACHE_DIR', SHARED_CACHE);
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai speckit real '));
  root = path.join(base, 'repo con espacios');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
  );
});

afterEach(async () => {
  setEnv('UV_CACHE_DIR', SHARED_CACHE);
  setEnv('HTTPS_PROXY', savedEnv.HTTPS_PROXY);
  setEnv('HTTP_PROXY', savedEnv.HTTP_PROXY);
  await fs.rm(path.dirname(root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('real runner (2.1)', () => {
  it('runs uvx and bash with argument arrays in a path with spaces', { timeout: 180_000 }, async () => {
    const engine = await loadEngine();
    const settings = effectiveSpeckit({ targets: ['claude'] }, engine);
    const version = await defaultRunner('uvx', [...uvxPrefix(settings), '--version'], { cwd: root });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain('1.2.3');
    const shell = await probeShell(settings, defaultRunner, root);
    expect(shell.ok).toBe(true);
    expect(shell.tried[0]).toBe('bash');
    // En Windows con el bash del PATH roto (stub de WSL) resuelve la ruta absoluta de Git Bash.
    expect(shell.command === 'bash' || shell.command.endsWith('bash.exe')).toBe(true);
  });
});

describe('real preflight (2.3)', () => {
  it('exits 2 offline with an empty cache and writes nothing', { timeout: 180_000 }, async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-empty-uv-cache-'));
    setEnv('UV_CACHE_DIR', empty);
    setEnv('HTTPS_PROXY', 'http://127.0.0.1:9');
    setEnv('HTTP_PROXY', 'http://127.0.0.1:9');
    try {
      const result = await cli(['init', '--yes', '--preset-only']);
      expect(result.code).toBe(2);
      expect(result.out).toContain('no se pudo resolver specify-cli==1.2.3');
      expect((await fs.readdir(root)).sort()).toEqual(['package.json']);
    } finally {
      await fs.rm(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

async function readText(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

describe('real installation (3.2, 4.4)', () => {
  it(
    'installs Spec Kit 1.2.3 in four targets, none in Copilot, and survives a Spec Kit upgrade without drift',
    { timeout: 300_000 },
    async () => {
      const result = await cli(['init', '--yes', '--preset-only']);
      expect(result.code, result.out).toBe(0);
      const options = JSON.parse(await readText('.specify/init-options.json'));
      expect(options).toMatchObject({ speckit_version: '1.2.3', script: 'sh' });
      const integration = JSON.parse(await readText('.specify/integration.json'));
      expect(integration.installed_integrations).toEqual(['claude', 'opencode', 'pi', 'cursor-agent']);
      expect(integration.default_integration).toBe('claude');
      for (const rel of [
        '.claude/skills/speckit-bug-assess/SKILL.md',
        '.claude/skills/speckit-assess-decide/SKILL.md',
        '.opencode/commands/speckit.bug.assess.md',
        '.opencode/commands/speckit.assess.decide.md',
        '.pi/prompts/speckit.bug.test.md',
        '.pi/prompts/speckit.assess.intake.md',
        '.cursor/skills/speckit-bug-fix/SKILL.md',
        '.cursor/skills/speckit-assess-shape/SKILL.md',
      ]) {
        await expect(fs.access(path.join(root, ...rel.split('/'))), rel).resolves.toBeUndefined();
      }
      const github = await fs.readdir(path.join(root, '.github', 'skills')).catch(() => []);
      expect(github.filter((name) => name.startsWith('speckit'))).toEqual([]);

      const engine = await loadEngine();
      const settings = effectiveSpeckit({ targets: ['claude'] }, engine);
      const upgrade = await defaultRunner('uvx', [...uvxPrefix(settings), 'integration', 'upgrade', 'claude'], {
        cwd: root,
      });
      expect(upgrade.status, upgrade.stderr).toBe(0);
      const drift = await cli(['drift']);
      expect(drift.out).not.toContain('editado a mano');
      expect(drift.code, drift.out).toBe(0);

      // Sonda 4.4 sobre el estado real: una skill de proyecto publicada dentro del espacio reservado
      // (un manifest editado a mano) no puede sobrescribir el comando de Spec Kit; sync falla cerrado.
      const owned = '.claude/skills/speckit-plan/SKILL.md';
      const specKitBody = await readText(owned);
      const lockBefore = await readText('sync.lock.json');
      const projectSkill = path.join(root, '.ai-hub', 'skills', 'speckit-plan');
      await fs.mkdir(projectSkill, { recursive: true });
      await fs.writeFile(path.join(projectSkill, 'SKILL.md'), '---\nname: speckit-plan\ndescription: copia del proyecto\n---\ncuerpo del proyecto\n');
      const { parse, stringify } = await import('yaml');
      const manifestFile = path.join(root, 'manifest.yaml');
      const manifest = parse(await fs.readFile(manifestFile, 'utf8')) as { skills: { publish: string[]; selection?: string } };
      manifest.skills.publish = ['speckit-plan'];
      manifest.skills.selection = 'custom';
      await fs.writeFile(manifestFile, stringify(manifest));
      const sync = await cli(['sync']);
      expect(sync.code).toBe(1);
      expect(sync.out).toContain('colisión de propiedad con Spec Kit');
      expect(await readText(owned)).toBe(specKitBody);
      expect(await readText('sync.lock.json')).toBe(lockBefore);
    },
  );
});

describe('README CI block (9.2)', () => {
  it('runs the documented job on a fresh clone and ends with doctor 0', { timeout: 300_000 }, async ({ skip }) => {
    const gitReason = gitUnavailable();
    if (gitReason !== null) {
      skip(gitReason);
    }
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { fakeRunner } = await import('./speckit-fake.js');
    const core = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const bin = path.join(core, 'dist', 'bin', 'ai-hub.js');
    const readme = await fs.readFile(path.join(core, 'README.md'), 'utf8');
    const block = /```yaml\n([\s\S]*?astral-sh\/setup-uv[\s\S]*?)```/.exec(readme)?.[1] ?? '';
    const runs = [...block.matchAll(/^- run: npx @dsalazardev\/ai-hub-cli (.+)$/gm)].map((match) => match[1].split(' '));
    expect(runs.map((args) => args[0])).toEqual(['install', 'doctor']);

    const out: string[] = [];
    const io: CliIO = { out: (lineText) => out.push(lineText), err: (lineText) => out.push(lineText) };
    expect(await runCli(['init', '--yes', '--preset-only'], { cwd: root, io, exec: fakeRunner().run })).toBe(0);
    const git = (args: string[], cwd: string): number => runGit(args, cwd).status;
    expect(git(['init', '-q'], root)).toBe(0);
    git(['config', 'user.email', 'ci@example.com'], root);
    git(['config', 'user.name', 'ci'], root);
    expect(git(['add', '-A'], root)).toBe(0);
    expect(git(['commit', '-qm', 'consumer'], root)).toBe(0);
    const clone = path.join(path.dirname(root), 'clon ci');
    expect(git(['clone', '-q', root, clone], path.dirname(root))).toBe(0);

    let last = -1;
    for (const args of runs) {
      const result = spawnSync(process.execPath, [bin, ...args], { cwd: clone, encoding: 'utf8', shell: false });
      last = result.status ?? 1;
      if (args[0] === 'install') {
        expect(last, `${result.stdout}${result.stderr}`).toBe(0);
      }
    }
    expect(last).toBe(0);
  });
});

describe('end to end (10.1)', () => {
  it('init, doctor, second init and drift on a new repository', { timeout: 600_000 }, async () => {
    const { commandPath } = await import('../src/speckit/state.js');
    const { TARGETS } = await import('../src/sync/targets.js');
    const first = await cli(['init', '--yes']);
    expect(first.code, first.out).toBe(0);
    const doctor = await cli(['doctor']);
    expect(doctor.out).not.toContain('[FAIL]');
    expect(doctor.out).toContain('copilot: sin Spec Kit');
    expect(doctor.code).toBe(0);
    // Sonda 10.1 sobre el estado real: el lock hereda de 0.2.x una entrada que hoy es un comando de
    // Spec Kit. El segundo init debe soltarla sin borrar el archivo de su nuevo dueño.
    const lockFile = path.join(root, 'sync.lock.json');
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { files: Record<string, unknown> };
    lock.files['.claude/skills/speckit-plan/SKILL.md'] = {
      sha256: '0'.repeat(64),
      source: '@engine/skills/shared/speckit-plan/SKILL.md',
    };
    await fs.writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    const second = await cli(['init', '--yes']);
    expect(second.code, second.out).toBe(0);
    expect(second.out).toMatch(/ 0 sincronizados /);
    const afterLock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { files: Record<string, unknown> };
    expect(afterLock.files['.claude/skills/speckit-plan/SKILL.md']).toBeUndefined();
    const doctorAfter = await cli(['doctor']);
    expect(doctorAfter.out).not.toContain('[FAIL]');
    const drift = await cli(['drift']);
    expect(drift.code, drift.out).toBe(0);
    const engine = await loadEngine();
    for (const tool of ['claude', 'opencode', 'pi', 'cursor'] as const) {
      const speckit = TARGETS[tool].speckit;
      if (speckit === null) {
        throw new Error(`${tool} sin Spec Kit`);
      }
      for (const command of engine.commands) {
        const rel = commandPath(speckit, command.speckit);
        await expect(fs.access(path.join(root, ...rel.split('/'))), rel).resolves.toBeUndefined();
      }
    }
  });
});

describe('failure matrix (10.2)', () => {
  it('missing uv on the real PATH exits 2 and writes nothing', { timeout: 120_000 }, async () => {
    const entries = (process.env.PATH ?? '').split(path.delimiter);
    const withoutUv: string[] = [];
    for (const entry of entries) {
      const hasUvx =
        (await fs.access(path.join(entry, 'uvx.exe')).then(() => true, () => false)) ||
        (await fs.access(path.join(entry, 'uvx')).then(() => true, () => false));
      if (!hasUvx) {
        withoutUv.push(entry);
      }
    }
    setEnv('PATH', withoutUv.join(path.delimiter));
    try {
      const result = await cli(['init', '--yes', '--preset-only']);
      expect(result.code).toBe(2);
      expect(result.out).toContain('uv no está disponible');
      expect((await fs.readdir(root)).sort()).toEqual(['package.json']);
    } finally {
      setEnv('PATH', savedEnv.PATH);
    }
  });

  it('no bash, no-speckit round trip, copilot installed by hand, and doctor never calls uvx', { timeout: 300_000 }, async () => {
    const { fakeRunner } = await import('./speckit-fake.js');
    const run = async (argv: string[], fake = fakeRunner()): Promise<{ code: number; out: string }> => {
      const out: string[] = [];
      const io: CliIO = { out: (lineText) => out.push(lineText), err: (lineText) => out.push(lineText) };
      return { code: await runCli(argv, { cwd: root, io, exec: fake.run }), out: out.join('\n') };
    };
    const noBash = await run(['init', '--yes', '--preset-only'], fakeRunner({ missing: ['bash'] }));
    expect(noBash.code).toBe(2);
    expect(noBash.out).toContain('ningún bash ejecuta');
    expect(noBash.out).toContain('ai-hub init --script ps');
    expect((await fs.readdir(root)).sort()).toEqual(['package.json']);

    expect((await run(['init', '--yes', '--preset-only', '--no-speckit'])).code).toBe(0);
    expect((await run(['doctor'])).code).toBe(1);
    expect((await run(['install'])).code).toBe(0);
    const watched = fakeRunner();
    const healthy = await run(['doctor'], watched);
    expect(healthy.code, healthy.out).toBe(0);
    expect(watched.calls.filter((call) => call[0] === 'uvx')).toEqual([]);

    const file = path.join(root, '.specify', 'integration.json');
    const integration = JSON.parse(await fs.readFile(file, 'utf8')) as { installed_integrations: string[] };
    integration.installed_integrations.push('copilot');
    await fs.writeFile(file, JSON.stringify(integration, null, 2));
    const broken = await run(['doctor']);
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/\[FAIL\] speckit:integrations:.*copilot/);
  });
});
