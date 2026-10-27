import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { scanReservedNamespace } from '../src/engine/gates.js';
import { loadEngine } from '../src/engine/engine.js';
import { speckitSequence } from '../src/speckit/commands.js';
import { effectiveSpeckit } from '../src/speckit/settings.js';
import { inReservedNamespace, speckitOwnedPaths } from '../src/speckit/state.js';
import { fakeRunner, type FakeRunner } from './speckit-fake.js';

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

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

async function present(rel: string): Promise<boolean> {
  return fs.access(path.join(root, ...rel.split('/'))).then(
    () => true,
    () => false,
  );
}

async function lockFiles(): Promise<string[]> {
  return Object.keys(JSON.parse(await read('sync.lock.json')).files as Record<string, unknown>);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-speckit-install-'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('installation sequence (3.2)', () => {
  it('builds the exact uvx argv in order without extension add --force', async () => {
    const engine = await loadEngine();
    const settings = effectiveSpeckit({ targets: ['claude', 'opencode', 'pi', 'cursor', 'copilot'] }, engine);
    const prefix = ['--from', 'specify-cli==1.2.3', '--exclude-newer', engine.speckit.excludeNewer, 'specify'];
    expect(speckitSequence(settings)).toEqual([
      [...prefix, 'init', '.', '--here', '--force', '--non-interactive', '--integration', 'claude', '--script', 'sh', '--extension', 'bug', '--extension', 'assess'],
      [...prefix, 'integration', 'install', 'opencode', '--script', 'sh'],
      [...prefix, 'integration', 'use', 'opencode'],
      [...prefix, 'integration', 'install', 'pi', '--script', 'sh'],
      [...prefix, 'integration', 'use', 'pi'],
      [...prefix, 'integration', 'install', 'cursor-agent', '--script', 'sh'],
      [...prefix, 'integration', 'use', 'cursor-agent'],
      [...prefix, 'integration', 'use', 'claude'],
    ]);
    const flat = speckitSequence(settings).map((step) => step.join(' ')).join('\n');
    expect(flat).not.toMatch(/extension add/);
    expect(flat).not.toMatch(/copilot/);
  });

  it('leaves bug and assess in the four Spec Kit targets and nothing in Copilot', async () => {
    const result = await cli(['init', '--yes', '--preset-only']);
    expect(result.code, result.out).toBe(0);
    expect(result.fake.specifyCalls().filter((call) => !call.includes('--version')).map((call) => call.slice(6, 9).join(' '))).toEqual([
      'init . --here',
      'integration install opencode',
      'integration use opencode',
      'integration install pi',
      'integration use pi',
      'integration install cursor-agent',
      'integration use cursor-agent',
      'integration use claude',
    ]);
    for (const rel of [
      '.claude/skills/speckit-bug-assess/SKILL.md',
      '.claude/skills/speckit-assess-decide/SKILL.md',
      '.opencode/commands/speckit.bug.fix.md',
      '.pi/prompts/speckit.assess.intake.md',
      '.cursor/skills/speckit-bug-test/SKILL.md',
    ]) {
      expect(await present(rel), rel).toBe(true);
    }
    const github = await fs.readdir(path.join(root, '.github', 'skills')).catch(() => []);
    expect(github.filter((name) => name.startsWith('speckit'))).toEqual([]);
    const integration = JSON.parse(await read('.specify/integration.json'));
    expect(integration.installed_integrations).toEqual(['claude', 'opencode', 'pi', 'cursor-agent']);
    expect(integration.default_integration).toBe('claude');
  });
});

describe('init wiring (3.1, 3.3)', () => {
  it('keeps project state on re-init and backs up the constitution first', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    await fs.writeFile(path.join(root, '.specify', 'memory', 'constitution.md'), '# Constitución propia\n');
    await fs.mkdir(path.join(root, 'specs', '001-demo'), { recursive: true });
    await fs.writeFile(path.join(root, 'specs', '001-demo', 'spec.md'), '# demo\n');
    const lockBefore = await read('sync.lock.json');

    const second = await cli(['init', '--yes', '--preset-only']);
    expect(second.code, second.out).toBe(0);
    expect(await read('.specify/memory/constitution.md')).toBe('# Constitución propia\n');
    expect(await read('specs/001-demo/spec.md')).toBe('# demo\n');
    expect(await read('sync.lock.json')).toBe(lockBefore);

    const backups = (await fs.readdir(path.join(root, '.backups'))).sort();
    const latest = backups[backups.length - 1];
    const saved = path.join(root, '.backups', latest, 'files', '.specify', 'memory', 'constitution.md');
    expect(await fs.readFile(saved, 'utf8')).toBe('# Constitución propia\n');
    await fs.rm(path.join(root, '.specify', 'memory', 'constitution.md'));
    expect((await cli(['restore', latest])).code).toBe(0);
    expect(await read('.specify/memory/constitution.md')).toBe('# Constitución propia\n');
  });

  it('never starts specify in the engine checkout', async () => {
    await fs.mkdir(path.join(root, 'core', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'core', 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'core', 'src', 'paths.ts'), '');
    const result = await cli(['init', '--yes', '--preset-only', '--force']);
    expect(result.fake.specifyCalls()).toEqual([]);
    expect(await present('.specify')).toBe(false);
  });
});

describe('post-sequence verification (3.4)', () => {
  it('exits 1 naming pi and the backup when a use step is skipped', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const result = await cli(['init', '--yes', '--preset-only'], fakeRunner({ skipUse: ['pi'] }));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/pi/);
    expect(result.out).toContain('speckit.bug.assess');
    expect(result.out).toMatch(/ai-hub restore \S+-init/);
  });
});

describe('ownership (4.1, 4.2)', () => {
  it('computes Spec Kit paths per target, extensions included, never under .github', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const tools = ['claude', 'opencode', 'pi', 'cursor', 'copilot'];
    const owned = await speckitOwnedPaths(root, tools);
    for (const rel of [
      '.claude/skills/speckit-plan/SKILL.md',
      '.opencode/commands/speckit.plan.md',
      '.pi/prompts/speckit.bug.assess.md',
      '.cursor/skills/speckit-assess-shape/SKILL.md',
      '.specify/scripts/bash/create-new-feature.sh',
    ]) {
      expect(owned.has(rel), rel).toBe(true);
    }
    expect([...owned].filter((rel) => rel.startsWith('.github/'))).toEqual([]);
    expect([...owned].filter((rel) => /speckit[-.](bug|assess)/.test(rel))).toHaveLength(32);
    expect(inReservedNamespace('.github/skills/speckit-plan/SKILL.md', tools)).toBe(false);
    expect(inReservedNamespace('.opencode/skills/speckit-plan/SKILL.md', tools)).toBe(false);
    expect(inReservedNamespace('.claude/skills/speckit-plan/SKILL.md', tools)).toBe(true);
  });

  it('transfers ownership from a 0.2.x lock without deleting Spec Kit files', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const lock = JSON.parse(await read('sync.lock.json'));
    const legacy = [
      '.claude/skills/speckit-plan/SKILL.md',
      '.opencode/skills/speckit-plan/SKILL.md',
      '.github/skills/speckit-plan/SKILL.md',
    ];
    for (const rel of legacy) {
      lock.files[rel] = { sha256: '0'.repeat(64), source: '@engine/skills/shared/speckit-plan/SKILL.md' };
    }
    await fs.writeFile(path.join(root, 'sync.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    for (const rel of legacy.slice(1)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), 'cuerpo 0.2.x\n');
    }
    expect((await cli(['sync'])).code).toBe(0);
    expect(await read('.claude/skills/speckit-plan/SKILL.md')).toContain('author: "github-spec-kit"');
    expect(await present('.opencode/skills/speckit-plan/SKILL.md')).toBe(false);
    expect(await present('.github/skills/speckit-plan/SKILL.md')).toBe(false);
    const after = await lockFiles();
    for (const rel of legacy) {
      expect(after).not.toContain(rel);
    }
  });

  it('has an empty intersection with the lock and a second sync writes nothing', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const tools = ['claude', 'opencode', 'pi', 'cursor', 'copilot'];
    const owned = await speckitOwnedPaths(root, tools);
    const shared = (await lockFiles()).filter((rel) => owned.has(rel) || inReservedNamespace(rel, tools));
    expect(shared).toEqual([]);
    const again = await cli(['sync']);
    expect(again.out).toContain('Escritos: 0');
  });
});

describe('reserved namespace gate (4.3)', () => {
  it('fails on a catalog asset named speckit-*', async () => {
    const catalog = path.join(root, 'catalog');
    await fs.mkdir(path.join(catalog, 'skills', 'speckit-plan'), { recursive: true });
    await fs.writeFile(path.join(catalog, 'skills', 'speckit-plan', 'SKILL.md'), '---\nname: x\n---\n');
    await fs.mkdir(path.join(catalog, 'agents'), { recursive: true });
    await fs.mkdir(path.join(catalog, 'rules'), { recursive: true });
    const findings = await scanReservedNamespace({
      skills: path.join(catalog, 'skills'),
      agents: path.join(catalog, 'agents'),
      rules: path.join(catalog, 'rules'),
    });
    expect(findings).toEqual(['skills/shared/speckit-plan (espacio reservado de Spec Kit)']);
  });
});

describe('order: Spec Kit before sync (3.3)', () => {
  it('runs specify init before sync writes the lock', async () => {
    let lockExisted: boolean | null = null;
    const fake = fakeRunner({
      onSpecifyInit: async (dir) => {
        lockExisted = await fs.access(path.join(dir, 'sync.lock.json')).then(() => true, () => false);
      },
    });
    expect((await cli(['init', '--yes', '--preset-only'], fake)).code).toBe(0);
    expect(lockExisted).toBe(false);
  });
});

describe('binding rule (5.4)', () => {
  it('projects the binding rule to the five targets in each notation; Copilot invokes nothing', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const claude = await read('.claude/rules/ai-hub-speckit.md');
    expect(claude).toContain('`/speckit-bug-assess`');
    expect(claude).not.toContain('/speckit.bug.assess');
    expect(await read('.opencode/rules/ai-hub-speckit.md')).toContain('`/speckit.bug.assess`');
    expect(await read('.pi/prompts/ai-hub-speckit.md')).toContain('`/speckit.bug.assess`');
    expect(await read('.cursor/rules/ai-hub-speckit.mdc')).toContain('`/speckit-bug-assess`');
    const copilot = await read('.github/instructions/ai-hub-speckit.instructions.md');
    expect(copilot).toContain('no tiene Spec Kit instalado');
    expect(copilot).not.toMatch(/\/speckit[-.]/);
    expect(copilot).toContain('propone** `ai::done`');
    const lock = JSON.parse(await read('sync.lock.json')) as { files: Record<string, { source: string }> };
    const binding = Object.entries(lock.files).filter(([, entry]) => entry.source === '@engine/engine/engine.yaml');
    expect(binding).toHaveLength(5);
    const { scanRetiredStates } = await import('../src/engine/gates.js');
    expect(await scanRetiredStates(binding.map(([rel]) => path.join(root, rel)), root)).toEqual([]);
  });
});

describe('Spec Kit commands are not managed by add/uninstall (5.2)', () => {
  it('refuses speckit names and runtime: false skills', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const uninstall = await cli(['uninstall', 'skill', 'speckit-plan']);
    expect(uninstall.code).toBe(1);
    expect(uninstall.out).toContain('lo provee Spec Kit');
    const add = await cli(['add', 'skill', 'specify']);
    expect(add.code).toBe(1);
    expect(add.out).toContain('runtime: false');
  });
});
