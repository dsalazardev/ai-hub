import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { PACKAGE_NAME } from '../src/package-info.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli, COMMAND_NAMES } from '../src/cli/run.js';
import { writeInventory } from '../src/manifest/manifest.js';
import { listBackups } from '../src/backup/snapshots.js';
import type { CliIO } from '../src/cli/types.js';
import { seedFixture } from './fixtures.js';
import { gitUnavailable, runGit } from './git.js';
import { fakeRunner } from './speckit-fake.js';
import { MEASURED } from './measured.js';

let root: string;

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const sink = capture();
  const code = await runCli(argv, { cwd: root, io: sink.io, exec: fakeRunner().run });
  return { code, out: sink.out.join('\n'), err: sink.err.join('\n') };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-cli-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seeded(): Promise<void> {
  await seedFixture(root);
  await writeInventory(root);
}

describe('dispatch', () => {
  it('help lists exactly the 18 commands', async () => {
    const result = await cli(['help']);
    expect(result.code).toBe(0);
    const expected = [
      'init',
      'install',
      'add',
      'sync',
      'drift',
      'list',
      'doctor',
      'check',
      'backups',
      'restore',
      'uninstall',
      'purge',
      'upgrade',
      'repair',
      'worktrees',
      'trunk',
      'memory',
      'context',
    ];
    expect(COMMAND_NAMES).toEqual(expected);
    for (const name of expected) {
      expect(result.out).toContain(name);
    }
    const rows = result.out.split('\n').filter((line) => /^ {2}[a-z]+ {2,}/.test(line));
    expect(rows).toHaveLength(18);
  });

  it('unknown commands exit 2 and no arguments exit 2', async () => {
    expect((await cli(['nope'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
  });
});

describe('init', () => {
  it('detects generic-ts and writes nothing without --yes', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { typescript: '^5' } }),
    );
    const result = await cli(['init']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('"preset": "generic-ts"');
    await expect(fs.access(path.join(root, '.ai-hubrc.json'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'manifest.yaml'))).rejects.toThrow();
  });

  it('honours an explicit preset over detection', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset', 'python', '--preset-only', '--yes'])).code).toBe(0);
    const rc = JSON.parse(await fs.readFile(path.join(root, '.ai-hubrc.json'), 'utf8'));
    expect(rc.preset).toBe('python');
  });

  it('produces the same plan hash for the same input', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const first = await cli(['init', '--dry-run']);
    const second = await cli(['init', '--dry-run']);
    expect(first.out).toBe(second.out);
    expect(first.out).toMatch(/"hash": "[a-f0-9]{64}"/);
  });

  it('plans every selection mode without writing', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
    );
    const full = JSON.parse((await cli(['init', '--dry-run'])).out);
    expect(full).toMatchObject({
      selection: 'full',
      skillCount: MEASURED.projectSkills,
      speckitCommands: MEASURED.speckitCommands,
      agentCount: 35,
      ruleCount: 6,
      destinations: MEASURED.lock.full,
    });
    expect(full.selections).toEqual({ skills: 'full', agents: 'full', rules: 'full' });
    expect(full.files).toBeGreaterThan(MEASURED.lock.full);
    expect(full.bytes).toBeGreaterThan(0);
    expect(full.hash).toMatch(/^[a-f0-9]{64}$/);
    const presetOnly = JSON.parse((await cli(['init', '--dry-run', '--preset-only'])).out);
    expect(presetOnly).toMatchObject({
      selection: 'preset',
      skillCount: 0,
      agentCount: 6,
      ruleCount: 2,
      destinations: MEASURED.lock.presetOnly,
    });
    const custom = JSON.parse(
      (await cli(['init', '--dry-run', '--exclude', 'rule:skill-quality'])).out,
    );
    expect(custom).toMatchObject({
      selection: 'custom',
      skillCount: MEASURED.projectSkills,
      agentCount: 35,
      ruleCount: 2,
      destinations: MEASURED.lock.customNoRubrics,
    });
    expect(custom.selections).toEqual({ skills: 'full', agents: 'full', rules: 'custom' });
    expect(custom.hash).not.toBe(full.hash);
    const singleRule = JSON.parse(
      (
        await cli([
          'init',
          '--dry-run',
          '--exclude',
          'rule:skill-quality/skill-rubric',
        ])
      ).out,
    );
    expect(singleRule).toMatchObject({
      selections: { skills: 'full', agents: 'full', rules: 'custom' },
      ruleCount: 5,
    });
    // Una rúbrica menos son 5 destinos menos (una regla por destino) respecto a la cifra medida.
    expect(singleRule.destinations).toBe(MEASURED.lock.full - 5);
    const mixed = JSON.parse(
      (
        await cli([
          'init',
          '--dry-run',
          '--exclude',
          'skill:angular,agent:typescript-reviewer',
        ])
      ).out,
    );
    expect(mixed).toMatchObject({
      selection: 'custom',
      skillCount: MEASURED.projectSkills - 1,
      agentCount: 34,
    });
    expect(mixed.skills).toHaveLength(MEASURED.projectSkills - 1);
    expect(mixed.agents).toHaveLength(34);
    expect(mixed.ruleCount).toBe(6);
    const angular = JSON.parse(
      (await cli(['init', '--dry-run', '--preset', 'angular-express'])).out,
    );
    expect(angular).toMatchObject({ selection: 'full', ruleCount: 9, destinations: MEASURED.lock.angularExpress });
    expect(angular.selections).toEqual({ skills: 'full', agents: 'full', rules: 'full' });
    expect((await cli(['init', '--dry-run', '--exclude', 'rule:core'])).code).toBe(2);
    expect((await cli(['init', '--dry-run', '--exclude', 'rule:preflight'])).code).toBe(2);
    await expect(fs.access(path.join(root, '.ai-hub'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'manifest.yaml'))).rejects.toThrow();
  });

  it('applies the python preset end to end', async () => {
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "demo"\n');
    expect((await cli(['init', '--preset', 'python', '--preset-only', '--yes'])).code).toBe(0);
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain('python');
    expect(doctor.out).toContain('versionado: no aplica (sin repositorio git)');
    await expect(fs.access(path.join(root, '.ai-hub', 'rules', 'python.md'))).resolves.toBeUndefined();
    const expansion = JSON.parse((await cli(['install', '--full', '--dry-run'])).out);
    expect(expansion).toMatchObject({
      skills: MEASURED.projectSkills,
      agents: 35,
      rules: 7,
    });
    // El preset python suma una regla propia: 5 destinos sobre la cifra full medida.
    expect(expansion.destinations).toBe(MEASURED.lock.full + 5);
  });

  it('applies the base preset in an empty repository', async () => {
    expect((await cli(['init', '--preset', 'base', '--preset-only', '--yes'])).code).toBe(0);
    expect((await cli(['sync'])).code).toBe(0);
    expect((await cli(['context'])).code).toBe(0);
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain('base@1');
  });

  it('re-running init keeps edited scaffold files and gitignore rules idempotent', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    const rule = path.join(root, '.ai-hub', 'rules', 'core.md');
    await fs.appendFile(rule, '\n- project edit\n');
    const second = await cli(['init', '--preset-only', '--yes']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('colisiones');
    expect(await fs.readFile(rule, 'utf8')).toContain('- project edit');
    const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('node_modules/');
    for (const entry of ['.claude/', '.opencode/', '.pi/', '.cursor/', '.github/skills/', '.mcp.json', '.vscode/mcp.json', 'opencode.json']) {
      expect(ignore.split('\n').filter((line) => line === entry)).toHaveLength(1);
    }
    expect(ignore).not.toContain('.ai-hub/');
    expect(ignore).not.toContain('sync.lock.json');
  });

  it('rejects legacy migration outside the engine checkout', async () => {
    await fs.mkdir(path.join(root, 'openspec', 'changes', 'demo'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'openspec', 'state.json'),
      JSON.stringify({ version: 3, active_change: 'demo', changes: [{ name: 'demo', phase: 'implementing' }] }),
    );
    await fs.writeFile(path.join(root, 'openspec', 'changes', 'demo', 'tasks.md'), '- [ ] one\n');
    expect((await cli(['init', '--yes', '--migrate'])).code).toBe(2);
    await expect(fs.access(path.join(root, '.planning', 'state.json'))).rejects.toThrow();
  });

  it('does not mistake a consumer monorepo for the engine checkout', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    await fs.mkdir(path.join(root, 'core'), { recursive: true });
    await fs.writeFile(path.join(root, 'core', 'package.json'), JSON.stringify({ name: 'app-core' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.ai-hub', 'manifest.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'core', 'manifest.json'))).rejects.toThrow();
    expect((await cli(['doctor'])).code).toBe(0);
  });

  it('installs the optional post-merge hook', async () => {
    await fs.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes', '--hooks'])).code).toBe(0);
    const hook = await fs.readFile(path.join(root, '.git', 'hooks', 'post-merge'), 'utf8');
    expect(hook).toContain('ai-hub worktrees reap --auto');
  });
});

describe('sync, drift and doctor', () => {
  it('runs init -> sync -> drift -> doctor -> worktrees with 0', async () => {
    await seeded();
    expect((await cli(['sync'])).code).toBe(0);
    expect((await cli(['context'])).code).toBe(0);
    expect((await cli(['drift'])).code).toBe(0);
    const doctor = await cli(['doctor']);
    expect(doctor.err).toBe('');
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain('8/8');
    expect(doctor.out).toContain('17/17');
    expect(doctor.out).toContain('7/7');
    expect(doctor.out).toContain('copilot');
    expect((await cli(['worktrees'])).code).toBe(0);
  });

  it('drift reports a missing file and exits 1', async () => {
    await seeded();
    await cli(['sync']);
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    const result = await cli(['drift']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('falta .claude/agents/spec-author.md');
  });

  it('upgrade re-synchronizes without losing the project manifest', async () => {
    await seeded();
    await cli(['sync']);
    const before = await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8');
    const result = await cli(['upgrade']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('upgrade:');
    expect(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')).toBe(before);
  });

  it('sync --dry-run reports without writing and upgrade is dry-runnable', async () => {
    await seeded();
    await cli(['sync']);
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    const preview = await cli(['sync', '--dry-run']);
    expect(preview.code).toBe(1);
    expect(preview.out).toContain('falta .claude/agents/spec-author.md');
    await expect(fs.access(path.join(root, '.claude/agents/spec-author.md'))).rejects.toThrow();
    const upgrade = await cli(['upgrade', '--dry-run']);
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain('"action": "upgrade"');
  });

  it('reports lock and drift as not applicable in the engine checkout', async () => {
    await seeded();
    await cli(['sync']);
    await fs.mkdir(path.join(root, 'core', 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'core', 'package.json'),
      JSON.stringify({ name: PACKAGE_NAME }),
    );
    await fs.writeFile(path.join(root, 'core', 'src', 'paths.ts'), 'export {};\n');

    const lock = await cli(['sync', '--check-lock']);
    expect(lock.code).toBe(0);
    expect(lock.out).toContain('no aplica');

    const drift = await cli(['drift']);
    expect(drift.code).toBe(0);
    expect(drift.out).toContain('Modo fuente');
  });

  it('does not require context in an installation', async () => {
    await seeded();
    await cli(['sync']);
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain('context: no aplica en instalación');
  });

  it('keeps MCP as an explicit consumer source', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    expect(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')).not.toContain('mcp:');
    await expect(fs.access(path.join(root, '.mcp.json'))).rejects.toThrow();
    expect((await cli(['doctor'])).out).toContain('MCP: no configurado');

    await fs.writeFile(
      path.join(root, 'mcp-manifest.yaml'),
      'required_mcps:\n  - id: demo\n    type: remote\n    client:\n      url: https://example.com/mcp\n',
    );
    const installed = await cli(['install']);
    expect(installed.code).toBe(0);
    expect(installed.out).toContain('full: no aplica; usa install --full');
    const manifest = await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('mcp:');
    await expect(fs.access(path.join(root, '.mcp.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.cursor', 'mcp.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.vscode', 'mcp.json'))).resolves.toBeUndefined();
    expect((await cli(['doctor'])).out).toContain('MCP configurado');
  });

  it('warns without failing when generated destinations are tracked in git', async ({ skip }) => {
    const gitReason = gitUnavailable();
    if (gitReason !== null) {
      skip(gitReason);
    }
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    const git = (args: string[]) => runGit(args, root);
    expect(git(['init']).status).toBe(0);
    expect(git(['add', '-f', '.claude/agents/spec-author.md']).status).toBe(0);
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain('aviso: destinos generados versionados');
  });

  it('does not warn when generated destinations are ignored', async ({ skip }) => {
    const gitReason = gitUnavailable();
    if (gitReason !== null) {
      skip(gitReason);
    }
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    const git = (args: string[]) => runGit(args, root);
    expect(git(['init']).status).toBe(0);
    expect(git(['add', '.gitignore', '.ai-hub']).status).toBe(0);
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.out).not.toContain('aviso: destinos generados versionados');
  });

  it('keeps scaffold paths portable and survives a move', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    const scaffold = await fs.readFile(path.join(root, '.ai-hub', '.scaffold.json'), 'utf8');
    expect(scaffold).not.toContain(root);
    expect(scaffold).not.toMatch(/[A-Za-z]:[\\/]/);
    const moved = `${root}-moved`;
    await fs.rename(root, moved);
    try {
      const sink = capture();
      const code = await runCli(['doctor'], { cwd: moved, io: sink.io });
      expect(code).toBe(0);
      expect(sink.out.join('\n')).toContain('manifest.json actualizado');
    } finally {
      root = moved;
    }
  });

  it('doctor reports project opt-outs', async () => {
    await seeded();
    await cli(['sync']);
    const manifest = await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8');
    await fs.writeFile(path.join(root, 'manifest.yaml'), manifest.replace('optOuts: []', 'optOuts:\n    - trunk'));
    await cli(['sync']);
    await writeInventory(root);
    expect((await cli(['context'])).code).toBe(0);
    const result = await cli(['doctor']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('opt-outs activos: trunk');
  });

  it('doctor fails with a stale inventory', async () => {
    await seeded();
    await cli(['sync']);
    expect((await cli(['context'])).code).toBe(0);
    await fs.writeFile(path.join(root, '.ai-hub', 'manifest.json'), '{}\n');
    const result = await cli(['doctor']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('manifest.json desactualizado');
  });

  it('repair restores a deleted generated file', async () => {
    await seeded();
    await cli(['sync']);
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    expect((await cli(['repair'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.claude/agents/spec-author.md'))).resolves.toBeUndefined();
  });

  it('install and repair dry-run write nothing', async () => {
    await seeded();
    await cli(['sync']);
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    expect((await cli(['install', '--dry-run'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.claude/agents/spec-author.md'))).rejects.toThrow();
    expect((await cli(['repair', '--dry-run'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.claude/agents/spec-author.md'))).rejects.toThrow();
  });
});

describe('add, list and uninstall', () => {
  it('uninstall removes an agent, add restores it, list reports it', async () => {
    await seeded();
    await cli(['sync']);
    expect((await cli(['uninstall', 'agent', 'reviewer-tests'])).code).toBe(0);
    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.agents).not.toContain('reviewer-tests');
    expect((await cli(['add', 'agent', 'reviewer-tests'])).code).toBe(0);
    const restored = JSON.parse((await cli(['list', '--json'])).out);
    expect(restored.agents).toContain('reviewer-tests');
  });

  it('adds any agent from the package catalog and uninstall restores it', async () => {
    await seeded();
    await cli(['sync']);
    expect((await cli(['add', 'agent', 'typescript-reviewer'])).code).toBe(0);
    await expect(
      fs.access(path.join(root, '.ai-hub/agents/typescript-reviewer.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, '.claude/agents/typescript-reviewer.md')),
    ).resolves.toBeUndefined();
    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.agents).toContain('typescript-reviewer');
    expect(listed.selection).toEqual({ skills: 'preset', agents: 'custom', rules: 'preset' });
    expect((await cli(['doctor'])).code).toBe(0);
    expect((await cli(['uninstall', 'agent', 'typescript-reviewer'])).code).toBe(0);
    const restored = JSON.parse((await cli(['list', '--json'])).out);
    expect(restored.agents).not.toContain('typescript-reviewer');
    await expect(
      fs.access(path.join(root, '.ai-hub/agents/typescript-reviewer.md')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(root, '.claude/agents/typescript-reviewer.md')),
    ).rejects.toThrow();
    expect((await cli(['doctor'])).code).toBe(0);

    const missing = await cli(['add', 'agent', 'no-such-agent']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('catálogo');
  });

  it('adds a development skill from the package catalog', async () => {
    await seeded();
    await cli(['sync']);
    expect((await cli(['add', 'skill', 'code-review'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.ai-hub/skills/code-review/SKILL.md'))).resolves.toBeUndefined();
    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.skills).toContain('code-review');
    expect((await cli(['context'])).code).toBe(0);
    expect((await cli(['doctor'])).code).toBe(0);
  });

  it('add and uninstall dry-run do not mutate the project', async () => {
    await seeded();
    await cli(['sync']);
    expect((await cli(['add', 'agent', 'reviewer-tests', '--dry-run'])).code).toBe(0);
    expect((await cli(['uninstall', 'agent', 'reviewer-tests', '--dry-run'])).code).toBe(0);
    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.agents).toContain('reviewer-tests');
    await expect(fs.access(path.join(root, '.ai-hub/agents/reviewer-tests.md'))).resolves.toBeUndefined();
  });

  it('does not uninstall an engine skill', async () => {
    await seeded();
    const result = await cli(['uninstall', 'skill', 'speckit-plan']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('lo provee Spec Kit');
  });

  it('uninstall updates the manifest and keeps doctor green', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { '@angular/core': '^18' } }));
    await fs.writeFile(path.join(root, 'angular.json'), '{}');
    expect((await cli(['init', '--preset', 'angular-express', '--preset-only', '--yes'])).code).toBe(0);
    expect((await cli(['sync'])).code).toBe(0);
    expect((await cli(['uninstall', 'skill', 'angular-developer'])).code).toBe(0);
    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.skills).not.toContain('angular-developer');
    expect((await cli(['context'])).code).toBe(0);
    expect((await cli(['doctor'])).code).toBe(0);
  });
});

describe('backups, purge and restore', () => {
  it('purge creates a snapshot and restore returns the previous tree', async () => {
    await seeded();
    await cli(['sync']);
    await expect(fs.access(path.join(root, '.ai-hub/rules/core.md'))).resolves.toBeUndefined();

    expect((await cli(['purge'])).code).toBe(1);
    expect((await cli(['purge', '--dry-run'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.ai-hub/rules/core.md'))).resolves.toBeUndefined();
    expect((await cli(['purge', '--yes'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.claude/agents/spec-author.md'))).rejects.toThrow();
    await expect(fs.access(path.join(root, '.ai-hub/rules/core.md'))).rejects.toThrow();
    const snapshots = await listBackups(root);
    expect(snapshots).toHaveLength(1);
    expect((await cli(['backups'])).out).toContain(snapshots[0].id);
    expect((await cli(['restore', snapshots[0].id, '--dry-run'])).code).toBe(0);
    await expect(fs.access(path.join(root, '.ai-hub/rules/core.md'))).rejects.toThrow();
    expect((await cli(['restore', snapshots[0].id])).code).toBe(0);
    await expect(fs.access(path.join(root, '.claude/agents/spec-author.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.ai-hub/rules/core.md'))).resolves.toBeUndefined();
  });
});

describe('memory, context and trunk', () => {
  it('does not expose memory or context in an installation', async () => {
    await seeded();
    expect((await cli(['sync'])).code).toBe(0);
    const added = await cli([
      'memory',
      'add',
      '--session',
      's1',
      '--change',
      'feat-a',
      '--event',
      'decision',
      '--decision',
      'D1',
      '--choice',
      'one package',
      '--alternatives',
      'monorepo',
    ]);
    expect(added.code).toBe(0);
    expect(added.out).toContain('no aplica en instalación');
    const resumed = await cli(['memory', 'resume', '--json']);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('no aplica en instalación');
    const context = await cli(['context']);
    expect(context.code).toBe(0);
    expect(context.out).toContain('no aplica en instalación');
    await expect(fs.access(path.join(root, '.planning'))).rejects.toThrow();
  });

  it('doctor fails when context is stale and context repairs it', async () => {
    await seeded();
    const coreDir = path.join(root, 'core');
    await fs.mkdir(path.join(coreDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(coreDir, 'presets'), { recursive: true });
    await fs.mkdir(path.join(coreDir, 'skills', 'shared'), { recursive: true });
    await fs.mkdir(path.join(coreDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(coreDir, 'dist', 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(coreDir, 'package.json'),
      JSON.stringify({
        name: PACKAGE_NAME,
        files: ['dist', 'schema', 'manifest.json', 'engine', 'presets', 'rules', 'agents', 'skills'],
      }),
    );
    await fs.writeFile(path.join(coreDir, 'src', 'paths.ts'), 'export {};\n');
    await fs.writeFile(path.join(coreDir, 'dist', 'bin', 'ai-hub.js'), '');
    // El fixture pasa a ser un checkout del motor: el inventario se escribe en core/.
    await writeInventory(root);
    const stateFile = path.join(root, '.planning/state.json');
    const state = {
      version: 1,
      project: 'fixture',
      preset: 'generic-ts',
      activeChange: 'feat-a',
      lane: 'feature',
      phase: 'plan',
      tasks: { total: 1, done: 0 },
      branch: null,
      worktree: null,
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    expect((await cli(['context'])).code).toBe(0);
    expect((await cli(['doctor'])).code).toBe(0);

    await fs.writeFile(
      stateFile,
      `${JSON.stringify({ ...state, phase: 'implement' }, null, 2)}\n`,
      'utf8',
    );
    const stale = await cli(['doctor']);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('contexto desactualizado');

    expect((await cli(['context'])).code).toBe(0);
    expect((await cli(['doctor'])).code).toBe(0);
  });

  it('trunk lock and unlock persist state', async () => {
    await seeded();
    expect((await cli(['trunk', 'lock', 'main'])).code).toBe(0);
    expect((await cli(['trunk', 'show'])).out).toContain('main · cerrada');
    expect((await cli(['trunk', 'unlock'])).code).toBe(0);
    expect((await cli(['trunk', 'show'])).out).toContain('main · abierta');
  });
});
