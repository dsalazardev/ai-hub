import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { scanReservedNamespace } from '../src/engine/gates.js';
import { loadEngine } from '../src/engine/engine.js';
import { speckitSequence, uvxPrefix } from '../src/speckit/commands.js';
import { effectiveSpeckit } from '../src/speckit/settings.js';
import { satisfiesRange } from '../src/speckit/version.js';
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

describe('installation sequence (3.1, 3.2)', () => {
  it('builds the exact uvx argv in order: three inits, chosen last, no extension add --force', async () => {
    const engine = await loadEngine();
    const settings = effectiveSpeckit({ targets: ['claude', 'opencode', 'pi', 'cursor', 'copilot'] }, engine);
    const prefix = uvxPrefix(settings);
    const initFor = (script: string): string[] => [
      ...prefix,
      'init',
      '.',
      '--here',
      '--force',
      '--non-interactive',
      '--integration',
      'claude',
      '--script',
      script,
      '--extension',
      'bug',
      '--extension',
      'assess',
    ];
    expect(speckitSequence(settings)).toEqual([
      initFor('ps'),
      initFor('py'),
      initFor('sh'),
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
    expect(flat).not.toMatch(/--exclude-newer/);
    const psSettings = effectiveSpeckit({ targets: ['claude'], speckit: { script: 'ps' } }, engine);
    expect(
      speckitSequence(psSettings)
        .filter((step) => step.includes('init'))
        .map((step) => step[step.indexOf('--script') + 1]),
    ).toEqual(['sh', 'py', 'ps']);
  });

  it('leaves bug and assess in the four Spec Kit targets and nothing in Copilot', async () => {
    const result = await cli(['init', '--yes', '--preset-only']);
    expect(result.code, result.out).toBe(0);
    const calls = result.fake.specifyCalls().filter((call) => !call.includes('--version'));
    const inits = calls.filter((call) => call.includes('init'));
    expect(inits.map((call) => call[call.indexOf('--script') + 1])).toEqual(['ps', 'py', 'sh']);
    for (const call of inits) {
      expect(call[call.indexOf('--integration') + 1]).toBe('claude');
      expect(call).toContain('--extension');
    }
    const afterInit = calls.filter((call) => !call.includes('init'));
    expect(afterInit.map((call) => call.slice(call.indexOf('specify') + 1, call.indexOf('specify') + 3).join(' '))).toEqual([
      'integration install',
      'integration use',
      'integration install',
      'integration use',
      'integration install',
      'integration use',
      'integration use',
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

  it('accumulates bash, powershell and python with 6 files each and a 24-file integrity manifest', async () => {
    const result = await cli(['init', '--yes', '--preset-only']);
    expect(result.code, result.out).toBe(0);
    const bases = ['check-prerequisites', 'common', 'create-new-feature', 'resolve-template', 'setup-plan', 'setup-tasks'];
    for (const [dir, ext] of [
      ['bash', '.sh'],
      ['powershell', '.ps1'],
      ['python', '.py'],
    ] as const) {
      const files = (await fs.readdir(path.join(root, '.specify', 'scripts', dir))).sort();
      expect(files, dir).toEqual(bases.map((base) => `${base}${ext}`));
    }
    const manifest = JSON.parse(await read('.specify/integrations/speckit.manifest.json')) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toHaveLength(24);
    expect(Object.keys(manifest.files).filter((rel) => rel.startsWith('.specify/scripts/'))).toHaveLength(18);
    const options = JSON.parse(await read('.specify/init-options.json')) as Record<string, string>;
    expect(options.script).toBe('sh');
    expect(satisfiesRange(options.speckit_version, '>=1.2.3 <1.3.0')).toBe(true);
    // El plan impreso informa la versión resuelta, no el rango (design D5).
    expect(result.out).toContain(`Spec Kit ${options.speckit_version} · script sh`);
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

describe('--script flag (3.1, 3.2, 3.3)', () => {
  it('rejects unknown values with exit 2 before probing or writing', async () => {
    for (const argv of [
      ['init', '--yes', '--script', 'zsh'],
      ['init', '--yes', '--script'],
    ]) {
      const result = await cli(argv);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.out, argv.join(' ')).toMatch(/sh.*ps.*py/);
      expect(result.fake.calls, argv.join(' ')).toEqual([]);
      expect((await fs.readdir(root)).sort()).toEqual(['package.json']);
    }
  });

  it('rejects an invalid value from install too, naming the command', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const result = await cli(['install', '--script', 'zsh']);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/ai-hub install --script sh/);
  });

  it('uses the flag over the engine default and persists it in the manifest', async () => {
    const result = await cli(['init', '--yes', '--preset-only', '--script', 'ps']);
    expect(result.code, result.out).toBe(0);
    const initCall = result.fake.specifyCalls().filter((call) => call.includes('init')).at(-1);
    expect(initCall?.[initCall.indexOf('--script') + 1]).toBe('ps');
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).script).toBe('ps');
  });

  it('keeps the manifest script when no flag is passed', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--script', 'ps'])).code).toBe(0);
    const second = await cli(['install']);
    expect(second.code, second.out).toBe(0);
    const initCall = second.fake.specifyCalls().filter((call) => call.includes('init')).at(-1);
    expect(initCall?.[initCall.indexOf('--script') + 1]).toBe('ps');
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).script).toBe('ps');
  });

  it('overrides an existing manifest script with the flag', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--script', 'ps'])).code).toBe(0);
    const back = await cli(['install', '--script', 'sh']);
    expect(back.code, back.out).toBe(0);
    const initCall = back.fake.specifyCalls().filter((call) => call.includes('init')).at(-1);
    expect(initCall?.[initCall.indexOf('--script') + 1]).toBe('sh');
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).script).toBe('sh');
  });

  it('doctor stays green without the flag after init --script ps', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--script', 'ps'])).code).toBe(0);
    const result = await cli(['doctor']);
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain('[FAIL]');
    expect(result.out).toContain('speckit:script:');
  });

  it('two dry-runs with different scripts produce different plan hashes', async () => {
    const sh = await cli(['init', '--dry-run', '--script', 'sh']);
    const ps = await cli(['init', '--dry-run', '--script', 'ps']);
    expect(sh.code).toBe(0);
    expect(ps.code).toBe(0);
    const shPlan = JSON.parse(sh.out) as { hash: string; speckit: { script: string } };
    const psPlan = JSON.parse(ps.out) as { hash: string; speckit: { script: string } };
    expect(shPlan.speckit.script).toBe('sh');
    expect(psPlan.speckit.script).toBe('ps');
    expect(shPlan.hash).not.toBe(psPlan.hash);
  });
});

describe('--scripts flag (script-choice 3.1)', () => {
  it('accepts py as --script and the rejection names sh, ps and py', async () => {
    const plan = await cli(['init', '--dry-run', '--script', 'py']);
    expect(plan.code, plan.out).toBe(0);
    expect((JSON.parse(plan.out) as { speckit: { script: string } }).speckit.script).toBe('py');
    const rejected = await cli(['init', '--yes', '--script', 'zsh']);
    expect(rejected.code).toBe(2);
    expect(rejected.out).toMatch(/acepta sh, ps o py/);
    expect(rejected.fake.calls).toEqual([]);
    expect((await fs.readdir(root)).sort()).toEqual(['package.json']);
  });

  it('rejects an invalid, duplicated or empty --scripts with exit 2 before writing', async () => {
    for (const argv of [
      ['init', '--yes', '--scripts', 'foo'],
      ['init', '--yes', '--scripts', 'sh,sh'],
      ['init', '--yes', '--scripts', ','],
      ['init', '--yes', '--scripts'],
    ]) {
      const result = await cli(argv);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.out, argv.join(' ')).toMatch(/sh, ps, py/);
      expect(result.fake.calls, argv.join(' ')).toEqual([]);
      expect((await fs.readdir(root)).sort()).toEqual(['package.json']);
    }
  });

  it('rejects the active outside the chosen set naming both fields, from init and install', async () => {
    const init = await cli(['init', '--yes', '--script', 'ps', '--scripts', 'sh,py']);
    expect(init.code).toBe(2);
    expect(init.out).toMatch(/--script ps/);
    expect(init.out).toMatch(/--scripts \[sh, py\]/);
    expect(init.fake.calls).toEqual([]);
    expect((await fs.readdir(root)).sort()).toEqual(['package.json']);
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const install = await cli(['install', '--script', 'ps', '--scripts', 'sh,py']);
    expect(install.code).toBe(2);
    expect(install.out).toMatch(/--script ps/);
    expect(install.out).toMatch(/--scripts \[sh, py\]/);
  });

  it('rejects a declared manifest active outside the flag set; an explicit --script migrates', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--script', 'sh'])).code).toBe(0);
    const silent = await cli(['install', '--scripts', 'py']);
    expect(silent.code).toBe(2);
    expect(silent.out).toMatch(/speckit\.script sh del manifest/);
    expect(silent.out).toMatch(/--scripts \[py\]/);
    const migration = await cli(['install', '--scripts', 'py', '--script', 'py']);
    expect(migration.code, migration.out).toBe(0);
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).script).toBe('py');
  });

  it('rejects a flag active outside a manifest-declared set', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    manifest.speckit = { ...(manifest.speckit as Record<string, unknown>), scripts: ['py'] };
    await fs.writeFile(path.join(root, 'manifest.yaml'), stringify(manifest), 'utf8');
    const result = await cli(['install', '--script', 'sh']);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/--script sh/);
    expect(result.out).toMatch(/speckit\.scripts \[py\] del manifest/);
  });
});

describe('scripts persistence (script-choice 3.2)', () => {
  it('persists an explicit --scripts into speckit.scripts and keeps declaration order', async () => {
    const result = await cli(['init', '--yes', '--preset-only', '--scripts', 'py,sh', '--script', 'sh']);
    expect(result.code, result.out).toBe(0);
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).scripts).toEqual(['py', 'sh']);
    expect((manifest.speckit as Record<string, unknown>).script).toBe('sh');
  });

  it('keeps the manifest set when no flag is passed (round-trip)', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--scripts', 'py'])).code).toBe(0);
    const second = await cli(['install']);
    expect(second.code, second.out).toBe(0);
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).scripts).toEqual(['py']);
    const initCall = second.fake.specifyCalls().filter((call) => call.includes('init')).at(-1);
    expect(initCall?.[initCall.indexOf('--script') + 1]).toBe('py');
  });

  it('overrides an existing manifest set with the flag', async () => {
    expect((await cli(['init', '--yes', '--preset-only', '--scripts', 'py'])).code).toBe(0);
    const back = await cli(['install', '--scripts', 'sh,ps,py']);
    expect(back.code, back.out).toBe(0);
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).scripts).toEqual(['sh', 'ps', 'py']);
  });

  it('writes no speckit.scripts without a flag on a fresh project', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    const manifest = parse(await read('manifest.yaml')) as Record<string, unknown>;
    expect((manifest.speckit as Record<string, unknown>).scripts).toBeUndefined();
  });
});

describe('plan body scripts (script-choice 3.3)', () => {
  it('keeps the hash for an explicit default set and omits the scripts field', async () => {
    const bare = await cli(['init', '--dry-run']);
    const explicit = await cli(['init', '--dry-run', '--scripts', 'sh,ps,py']);
    expect(bare.code, bare.out).toBe(0);
    expect(explicit.code, explicit.out).toBe(0);
    const barePlan = JSON.parse(bare.out) as { hash: string; speckit: Record<string, unknown> };
    const explicitPlan = JSON.parse(explicit.out) as { hash: string; speckit: Record<string, unknown> };
    expect(barePlan.speckit.scripts).toBeUndefined();
    expect(explicitPlan.speckit.scripts).toBeUndefined();
    expect(explicitPlan.hash).toBe(barePlan.hash);
  });

  it('includes scripts and changes the hash for a non-default set', async () => {
    const bare = await cli(['init', '--dry-run']);
    const py = await cli(['init', '--dry-run', '--scripts', 'py']);
    expect(py.code, py.out).toBe(0);
    const barePlan = JSON.parse(bare.out) as { hash: string };
    const pyPlan = JSON.parse(py.out) as {
      hash: string;
      speckit: { scripts?: string[]; script: string };
    };
    expect(pyPlan.speckit.scripts).toEqual(['py']);
    expect(pyPlan.speckit.script).toBe('py');
    expect(pyPlan.hash).not.toBe(barePlan.hash);
  });
});

describe('script change reinstalls Spec Kit (3.4)', () => {
  it('install --script ps over an sh installation rewrites init-options and keeps every scripts dir', async () => {
    expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
    expect((JSON.parse(await read('.specify/init-options.json')) as Record<string, unknown>).script).toBe('sh');
    expect(await present('.specify/scripts/bash/check-prerequisites.sh')).toBe(true);
    const result = await cli(['install', '--script', 'ps']);
    expect(result.code, result.out).toBe(0);
    expect((JSON.parse(await read('.specify/init-options.json')) as Record<string, unknown>).script).toBe('ps');
    expect(await present('.specify/scripts/powershell/check-prerequisites.ps1')).toBe(true);
    // Los directorios se acumulan (evidencia medida): bash sigue en disco aunque el elegido sea ps.
    expect(await present('.specify/scripts/bash/check-prerequisites.sh')).toBe(true);
    const doctor = await cli(['doctor']);
    expect(doctor.code, doctor.out).toBe(0);
  });
});

describe('script set (script-choice 1.3)', () => {
  it('{py} runs a single py init, leaves only scripts/python and a 6-file script manifest', async () => {
    const engine = await loadEngine();
    const settings = effectiveSpeckit({ targets: ['claude'], speckit: { scripts: ['py'] } }, engine);
    const inits = speckitSequence(settings).filter((step) => step.includes('init'));
    expect(inits.map((step) => step[step.indexOf('--script') + 1])).toEqual(['py']);
    const fake = fakeRunner();
    for (const step of speckitSequence(settings)) {
      await fake.run('uvx', step, { cwd: root });
    }
    expect(await fs.readdir(path.join(root, '.specify', 'scripts'))).toEqual(['python']);
    const manifest = JSON.parse(await read('.specify/integrations/speckit.manifest.json')) as {
      files: Record<string, string>;
    };
    const scriptFiles = Object.keys(manifest.files).filter((rel) => rel.startsWith('.specify/scripts/'));
    expect(scriptFiles).toHaveLength(6);
    expect((JSON.parse(await read('.specify/init-options.json')) as Record<string, unknown>).script).toBe('py');
  });

  it('{py,sh} with active sh runs py first and sh last', async () => {
    const engine = await loadEngine();
    const settings = effectiveSpeckit({ targets: ['claude'], speckit: { scripts: ['py', 'sh'], script: 'sh' } }, engine);
    const inits = speckitSequence(settings).filter((step) => step.includes('init'));
    expect(inits.map((step) => step[step.indexOf('--script') + 1])).toEqual(['py', 'sh']);
  });
});

