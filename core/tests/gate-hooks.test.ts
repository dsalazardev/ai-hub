import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli/run.js';
import { runHook, globToRegExp, scopeViolations, changedPaths } from '../src/cli/hook.js';
import { featureSeal } from '../src/speckit/seal.js';
import { mergeClaudeHooks, missingClaudeHooks, projectSettingsHooks, HOOK_COMMAND } from '../src/sync/hooks.js';
import { findCollisions, cosine, terms } from '../src/catalog/collisions.js';
import { readLock } from '../src/sync/lock.js';
import type { ProcessRunner, RunResult } from '../src/speckit/runner.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { gitUnavailable, runGit } from './git.js';
import { seedFixture } from './fixtures.js';
import { writeInventory } from '../src/manifest/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, '..');
const GIT = gitUnavailable();

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-gate-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function cli(argv: string[], exec: ProcessRunner = fakeRunner().run): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd: root, io, exec });
  return { code, out: out.join('\n') };
}

async function consumer(): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  const result = await cli(['init', '--preset-only', '--yes']);
  expect(result.code, result.out).toBe(0);
}

async function feature(name: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, 'specs', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content, 'utf8');
  }
}

/** Runner que acepta `bash -c 'echo ok'` como shell y registra cada comando del manifiesto. */
function shellRunner(statusFor: (line: string) => number = () => 0): { run: ProcessRunner; lines: string[]; shells: string[] } {
  const lines: string[] = [];
  const shells: string[] = [];
  const run: ProcessRunner = async (command, args): Promise<RunResult> => {
    if (args[1] === 'echo ok' || args.at(-1) === 'echo ok') {
      return command === 'bash' ? { status: 0, stdout: 'ok\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    shells.push(command);
    const line = args.at(-1) ?? '';
    lines.push(line);
    return { status: statusFor(line), stdout: `ran ${line}\n`, stderr: '' };
  };
  return { run, lines, shells };
}

describe('ai-hub gate (3.6)', () => {
  it('an incomplete feature fails naming the missing artifact', async () => {
    await consumer();
    await feature('001-demo', { 'spec.md': '# s\n', 'plan.md': '# p\n' });
    const result = await cli(['gate', '--quick']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('specs/001-demo: falta tasks.md');
  });

  it('two features in progress exceed WIP 1', async () => {
    await consumer();
    const half = '- [x] T001 a\n- [ ] T002 b\n';
    await feature('001-a', { 'spec.md': 's', 'plan.md': 'p', 'tasks.md': half });
    await feature('002-b', { 'spec.md': 's', 'plan.md': 'p', 'tasks.md': half });
    const result = await cli(['gate', '--quick']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('2 features en curso superan el máximo 1: 001-a, 002-b');
  });

  it('a seal mismatch fails closed without running commands', async () => {
    await consumer();
    await feature('001-demo', { 'spec.md': '# Demo\n', 'plan.md': '# Plan\n', 'tasks.md': '- [ ] T001 Demo\n' });
    const runner = shellRunner();
    const bad = await cli(['gate', '--seal', '0'.repeat(64)], runner.run);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('el sello no coincide');
    expect(runner.lines).toEqual([]);
    const good = await cli(['gate', '--quick', '--seal', await featureSeal(root, 'specs/001-demo')]);
    expect(good.code).toBe(0);
    expect(good.out).toContain('el sello coincide');
  });

  it('runs the manifest commands through the resolved shell; invalid input exits 2', async () => {
    await consumer();
    const runner = shellRunner();
    const ok = await cli(['gate'], runner.run);
    expect(ok.code).toBe(0);
    expect(runner.lines).toEqual(['npx tsc --noEmit', 'npm run lint', 'npm test']);
    expect(runner.shells.every((shell) => shell === 'bash')).toBe(true);
    const failing = shellRunner((line) => (line === 'npm test' ? 3 : 0));
    const red = await cli(['gate'], failing.run);
    expect(red.code).toBe(1);
    expect(red.out).toContain('[FAIL] gate:test: npm test (exit 3)');
    expect((await cli(['gate', '--seal'])).code).toBe(2);
  });
});

describe('verify is an alias of gate (3.7, F-12)', () => {
  it('same output and exit code', async () => {
    await consumer();
    await feature('001-demo', { 'spec.md': 's', 'plan.md': 'p' });
    const gate = await cli(['gate', '--quick']);
    const verify = await cli(['verify', '--quick']);
    expect(verify.code).toBe(gate.code);
    expect(verify.out).toBe(gate.out);
  });

  it.skipIf(process.platform !== 'win32')('a broken WSL bash is skipped for Git Bash', async () => {
    await consumer();
    const lines: string[] = [];
    const run: ProcessRunner = async (command, args) => {
      if (args.at(-1) === 'echo ok') {
        // `bash` del PATH = lanzador de WSL sin distribución; Git Bash responde.
        return command !== 'bash' && command.toLowerCase().endsWith('bash.exe')
          ? { status: 0, stdout: 'ok', stderr: '' }
          : { status: 1, stdout: '', stderr: 'wsl: no distribution' };
      }
      lines.push(`${command}|${args.at(-1)}`);
      return { status: 0, stdout: '', stderr: '' };
    };
    expect((await cli(['gate'], run)).code).toBe(0);
    expect(lines.length).toBe(3);
    expect(lines.every((line) => line.toLowerCase().includes('bash.exe|'))).toBe(true);
  });

  it('no source spawns bash from PATH directly', async () => {
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.name.endsWith('.ts') && /spawnSync\(\s*'bash'/.test(await fs.readFile(abs, 'utf8'))) {
          hits.push(path.relative(CORE, abs));
        }
      }
    };
    await walk(path.join(CORE, 'src'));
    expect(hits).toEqual([]);
    const preset = await fs.readFile(path.join(CORE, 'presets', 'angular-express', 'preset.yaml'), 'utf8');
    expect(preset).not.toMatch(/:\s*bash /);
  });
});

describe('ai-hub hook (3.8, 3.11)', () => {
  async function gitConsumer(mode: 'shadow' | 'enforce'): Promise<void> {
    runGit(['init', '-q'], root);
    await consumer();
    const manifest = path.join(root, 'manifest.yaml');
    await fs.writeFile(manifest, (await fs.readFile(manifest, 'utf8')).replace('guardMode: shadow', `guardMode: ${mode}`));
    runGit(['add', '-A'], root);
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], root);
  }

  const payload = (command: string): string =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 's1' });

  it('fails open on invalid input', async () => {
    expect((await runHook('pre', 'not json', root)).output).toEqual({});
    expect((await runHook('pre', '[]', root)).output).toEqual({});
    expect((await runHook('post', '{}', root)).output).toEqual({});
  });

  it.skipIf(GIT !== null)('enforce: mkfs is denied, a forced push and a hard reset ask', async () => {
    await gitConsumer('enforce');
    const denied = (await runHook('pre', payload('mkfs.ext4 /dev/sda1'), root)).output as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('danger:mkfs');
    for (const command of ['git push --force origin main', 'git reset --hard HEAD~1']) {
      const asked = (await runHook('pre', payload(command), root)).output as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(asked.hookSpecificOutput.permissionDecision, command).toBe('ask');
    }
  });

  it.skipIf(GIT !== null)('shadow allows and reports the rule', async () => {
    await gitConsumer('shadow');
    const output = (await runHook('pre', payload('git push --force origin main'), root)).output as {
      hookSpecificOutput: { permissionDecision: string };
      systemMessage: string;
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(output.systemMessage).toContain('[shadow] danger:force-push');
  });

  it('cli: unknown event exits 2; a valid event always exits 0', async () => {
    expect((await cli(['hook', 'nope'])).code).toBe(2);
  });
});

describe('real hook projection (3.9, 3.10)', () => {
  it('merges managed entries and preserves every user key; idempotent', () => {
    const user = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    const merged = mergeClaudeHooks(user);
    expect(merged.permissions).toEqual(user.permissions);
    expect(JSON.stringify(merged)).toContain('echo mine');
    expect(missingClaudeHooks(merged)).toEqual([]);
    expect(mergeClaudeHooks(merged)).toEqual(merged);
    expect(Object.keys(merged)).toEqual(['permissions', 'hooks']);
    expect(JSON.stringify(merged)).toContain(`${HOOK_COMMAND} pre`);
  });

  it('an invalid user settings file is never touched', async () => {
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude', 'settings.json'), '{ broken', 'utf8');
    const result = await projectSettingsHooks(root, ['claude'], false);
    expect(result.written).toEqual([]);
    expect(result.problems[0]).toContain('no es JSON válido');
    expect(await fs.readFile(path.join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ broken');
  });

  it('sync projects the Claude hooks and the OpenCode plugin; settings stay out of the lock', async () => {
    await seedFixture(root);
    await writeInventory(root);
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ model: 'x' }), 'utf8');
    expect((await cli(['sync'])).code).toBe(0);
    const settings = JSON.parse(await fs.readFile(path.join(root, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings.model).toBe('x');
    expect(missingClaudeHooks(settings)).toEqual([]);
    const plugin = await fs.readFile(path.join(root, '.opencode', 'plugins', 'ai-hub.js'), 'utf8');
    expect(plugin).toContain("'tool.execute.before'");
    const lock = await readLock(root);
    expect(Object.keys(lock?.files ?? {})).toContain('.opencode/plugins/ai-hub.js');
    expect(Object.keys(lock?.files ?? {})).not.toContain('.claude/settings.json');
    const doctor = await cli(['doctor']);
    expect(doctor.out).toContain('claude: hooks en .claude/settings.json');
    expect(doctor.out).toContain('opencode: plugin');
    expect(doctor.out).toContain('copilot: solo regla (el host no admite hooks)');
    expect(doctor.out).toContain('cursor: solo regla (el host no admite hooks)');
  });

  it('doctor fails when the managed entry is removed', async () => {
    await seedFixture(root);
    await writeInventory(root);
    await cli(['sync']);
    const file = path.join(root, '.claude', 'settings.json');
    const settings = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks: Record<string, unknown> };
    delete settings.hooks.PreToolUse;
    await fs.writeFile(file, JSON.stringify(settings), 'utf8');
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(1);
    expect(doctor.out).toContain('[FAIL] hooks: faltan: .claude/settings.json: PreToolUse(Bash) → ai-hub hook pre');
  });
});

describe('post-step scope guard (3.12)', () => {
  it('globs and diff helpers', () => {
    expect(globToRegExp('.ai-hub/work/**').test('.ai-hub/work/001/review.md')).toBe(true);
    expect(globToRegExp('.planning/review_arch_*.md').test('.planning/review_arch_x.md')).toBe(true);
    expect(globToRegExp('src/**').test('srcx/a.ts')).toBe(false);
    expect(changedPaths({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual(['b', 'c']);
    expect(scopeViolations(['src/a.ts', '.planning/review_arch_x.md'], ['.planning/review_arch_*.md'])).toEqual(['src/a.ts']);
  });

  it.skipIf(GIT !== null)('a reviewer writing source is reported and nothing is reverted', async () => {
    runGit(['init', '-q'], root);
    await consumer();
    runGit(['add', '-A'], root);
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], root);
    const previous = process.env.AI_HUB_ROLE;
    process.env.AI_HUB_ROLE = 'reviewer-architecture';
    try {
      const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'scope1' });
      await runHook('pre', event, root);
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src', 'x.ts'), 'export {};\n');
      await fs.mkdir(path.join(root, 'newdir', 'inner'), { recursive: true });
      await fs.writeFile(path.join(root, 'newdir', 'inner', 'f.txt'), 'x');
      const post = (await runHook('post', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'scope1' }), root)).output as {
        systemMessage: string;
      };
      expect(post.systemMessage).toContain('reviewer-architecture');
      expect(post.systemMessage).toContain('src/x.ts');
      expect(post.systemMessage).toContain('newdir/inner/f.txt');
      expect(await fs.readFile(path.join(root, 'src', 'x.ts'), 'utf8')).toBe('export {};\n');
    } finally {
      if (previous === undefined) {
        delete process.env.AI_HUB_ROLE;
      } else {
        process.env.AI_HUB_ROLE = previous;
      }
    }
  });
});

describe('list --collisions (3.13)', () => {
  it('near-identical descriptions are listed with their score', () => {
    expect(cosine(terms('review pull requests'), terms('review pull requests'))).toBeCloseTo(1);
    const found = findCollisions({
      a: 'Review a pull request diff for correctness bugs before merge',
      b: 'Review a pull request diff for correctness bugs before the merge',
      c: 'Design a REST API with pagination and versioning',
    });
    expect(found.map((item) => [item.left, item.right])).toEqual([['a', 'b']]);
    expect(found[0].score).toBeGreaterThanOrEqual(0.8);
  });

  it('the command reports and exits 0', async () => {
    await consumer();
    const result = await cli(['list', '--collisions']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('colisiones de descripción (umbral 0.8)');
  });
});
