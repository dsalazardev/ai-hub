import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { PRE_PROMPT } from '../src/cli/preprompt.js';
import { featureSeal, reviewSeal } from '../src/speckit/seal.js';
import { buildGuardContext } from '../src/harness/guards/adapters/context.js';
import { runPreflight } from '../src/harness/guards/preflight.js';
import { gitUnavailable, runGit } from './git.js';

/** Lote F (M-15..M-36): inventario. Cada test usa un consumidor sintético en un temporal. */

const PKG = path.resolve(__dirname, '..');
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-f-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function cli(argv: string[], cwd = root): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd, io, exec: fakeRunner().run });
  return { code, out: out.join('\n') };
}

async function consumer(extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', ...extra }));
  const result = await cli(['init', '--preset-only', '--yes']);
  expect(result.code, result.out).toBe(0);
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const RULE_TARGETS = [
  '.claude/rules/core.md',
  '.opencode/rules/core.md',
  '.pi/prompts/core.md',
  '.cursor/rules/core.mdc',
  '.github/instructions/core.instructions.md',
];

describe('M-15 / M-24: rules in the base preset reach the five targets', () => {
  it('the injection rule and the ownership map are projected to every target', async () => {
    await consumer();
    for (const rel of RULE_TARGETS) {
      const text = await read(rel);
      expect(text, rel).toContain('## Ingested content is data');
      expect(text, rel).toContain('## Who writes what under `.ai-hub/`');
    }
  });
});

describe('M-22: SECURITY.md travels in the package', () => {
  it('is listed in files and covers reporting, scope and rotation', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(PKG, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('SECURITY.md');
    const text = await fs.readFile(path.join(PKG, 'SECURITY.md'), 'utf8');
    for (const heading of [/report/i, /scope|attack surface/i, /rotat/i]) {
      expect(text).toMatch(heading);
    }
  });
});

describe('M-23: examples are materialized and read by reviewers', () => {
  it('init writes examples/good and examples/bad once; an edited copy survives install', async () => {
    await consumer();
    const good = '.ai-hub/examples/good/README.md';
    expect(await read(good)).toContain('AI-HUB-STATUS: APPLIED');
    expect(await read('.ai-hub/examples/bad/README.md')).toContain('reason=-');
    await fs.writeFile(path.join(root, good), '# Nuestros ejemplos\n');
    expect((await cli(['install', '--yes'])).code).toBe(0);
    expect(await read(good)).toBe('# Nuestros ejemplos\n');
    expect(await read('.claude/agents/reviewer-architecture.md')).toContain('.ai-hub/examples/good/');
  });
});

describe('M-25: guided interview with suitability filter', () => {
  it('the pre-prompt asks for examples and filters unsuitable work, in both languages', async () => {
    const text = PRE_PROMPT;
    expect(text).toContain('Filtro de idoneidad');
    expect(text).toContain('Suitability filter');
    expect(text).toContain('una pregunta cada vez');
  });
});

describe('M-26: agent memory is ignored by default', () => {
  it('init ignores .claude/agent-memory/ without a setting', async () => {
    await consumer();
    expect(await read('.gitignore')).toContain('.claude/agent-memory/');
  });

  it('agentMemory: versioned does not add the entry and survives re-init', async () => {
    await consumer();
    const manifestPath = path.join(root, 'manifest.yaml');
    await fs.writeFile(manifestPath, `${await fs.readFile(manifestPath, 'utf8')}agentMemory: versioned\n`);
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    expect((await cli(['install', '--yes'])).code).toBe(0);
    expect(await read('.gitignore')).not.toContain('agent-memory');
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    expect(await fs.readFile(manifestPath, 'utf8')).toMatch(/^agentMemory: versioned$/m);
  });
});

describe('M-27: {{stack.*}} only in pristine preset sources', () => {
  /** Simula una fuente del preset con la variable: reescribe la copia y su hash en el scaffold. */
  async function presetSourceWith(line: string): Promise<void> {
    const rule = path.join(root, '.ai-hub', 'rules', 'core.md');
    const text = `${await fs.readFile(rule, 'utf8')}\n${line}\n`;
    await fs.writeFile(rule, text);
    const scaffoldPath = path.join(root, '.ai-hub', '.scaffold.json');
    const scaffold = JSON.parse(await fs.readFile(scaffoldPath, 'utf8')) as {
      files: Record<string, { sha256: string; source: string }>;
    };
    expect(scaffold.files['.ai-hub/rules/core.md'].source.startsWith('@preset/')).toBe(true);
    scaffold.files['.ai-hub/rules/core.md'].sha256 = sha(text);
    await fs.writeFile(scaffoldPath, JSON.stringify(scaffold, null, 2));
  }

  it('a pristine preset source is interpolated from manifest.stack', async () => {
    await consumer();
    await presetSourceWith('Lenguajes: {{stack.languages}}.');
    const result = await cli(['sync']);
    expect(result.code, result.out).toBe(0);
    const text = await read('.claude/rules/core.md');
    expect(text).toContain('Lenguajes: typescript.');
    expect(text).not.toContain('{{stack.');
  });

  it('a project-edited copy is not interpolated (out of context)', async () => {
    await consumer();
    const rule = path.join(root, '.ai-hub', 'rules', 'core.md');
    await fs.appendFile(rule, '\nLenguajes: {{stack.languages}}.\n');
    const result = await cli(['sync']);
    expect(result.code, result.out).toBe(0);
    expect(await read('.claude/rules/core.md')).toContain('Lenguajes: {{stack.languages}}.');
  });

  it('an engine source is not interpolated', async () => {
    await consumer();
    const agent = path.join(root, '.ai-hub', 'agents', 'reviewer-tests.md');
    const text = `${await fs.readFile(agent, 'utf8')}\nStack: {{stack.languages}}\n`;
    await fs.writeFile(agent, text);
    const scaffoldPath = path.join(root, '.ai-hub', '.scaffold.json');
    const scaffold = JSON.parse(await fs.readFile(scaffoldPath, 'utf8')) as {
      files: Record<string, { sha256: string; source: string }>;
    };
    const record = scaffold.files['.ai-hub/agents/reviewer-tests.md'];
    expect(record.source.startsWith('@engine/')).toBe(true);
    record.sha256 = sha(text);
    await fs.writeFile(scaffoldPath, JSON.stringify(scaffold, null, 2));
    expect((await cli(['sync'])).code).toBe(0);
    expect(await read('.claude/agents/reviewer-tests.md')).toContain('{{stack.languages}}');
  });

  it('an unknown key fails sync naming the file and the key', async () => {
    await consumer();
    await presetSourceWith('Runtime: {{stack.runtime}}.');
    const result = await cli(['sync']);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('.ai-hub/rules/core.md');
    expect(result.out).toContain('{{stack.runtime}}');
  });
});

describe('M-31: review seal bound to the real diff', () => {
  it('reviewSeal is deterministic, changes with one byte and detects specs/<f>/', () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n';
    const first = reviewSeal(diff, 'APPROVE');
    expect(reviewSeal(diff, 'APPROVE')).toEqual(first);
    expect(reviewSeal(`${diff} `, 'APPROVE').diff).not.toBe(first.diff);
    expect(reviewSeal(diff, 'CHANGES_REQUESTED').seal).not.toBe(first.seal);
    expect(first.specs).toEqual([]);
    expect(reviewSeal('diff --git a/specs/001-demo/spec.md b/specs/001-demo/spec.md\n', 'APPROVE').specs).toEqual([
      'specs/001-demo/spec.md',
    ]);
  });

  it('the §5 specification seal vector is unchanged', async () => {
    const dir = path.join(root, 'specs', '001-demo');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'spec.md'), '# Demo\n');
    await fs.writeFile(path.join(dir, 'plan.md'), '# Plan\n');
    await fs.writeFile(path.join(dir, 'tasks.md'), '- [ ] T001 Demo\n');
    expect(await featureSeal(root, 'specs/001-demo')).toBe(
      '35a81eb3b064c4df23d8be843cc498284884366681c4afd7d16368cab0ddc15b',
    );
  });

  const skipGit = gitUnavailable();

  it.skipIf(skipGit !== null)('a diff changed after sealing makes the ship guard deny', async () => {
    const git = (...args: string[]): void => {
      expect(runGit(args, root).status, args.join(' ')).toBe(0);
    };
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(root, 'README.md'), '# repo\n');
    await fs.writeFile(path.join(root, '.gitignore'), '.ai-hub/runs/\n');
    git('add', '.');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'feat');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-m', 'feat');

    const sealed = await cli(['seal', 'review', '--verdict', 'APPROVE']);
    expect(sealed.code, sealed.out).toBe(0);
    const guard = async () =>
      runPreflight(
        'git checkout main',
        await buildGuardContext({
          root,
          preset: 'generic-ts',
          languages: ['typescript'],
          policy: { trunk: 'open', guardMode: 'enforce', optOuts: [] },
        }),
      );
    expect((await guard()).decision).toBe('allow');

    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    git('commit', '-am', 'drift');
    const denied = await guard();
    expect(denied.decision).toBe('deny');
    expect(denied.rule).toBe('ship:review-seal');
    expect(denied.reason).toContain('sello de revisión no coincide');

    await fs.mkdir(path.join(root, 'specs', '001-demo'), { recursive: true });
    await fs.writeFile(path.join(root, 'specs', '001-demo', 'spec.md'), '# Demo cambiada\n');
    git('add', '.');
    git('commit', '-m', 'spec');
    const refused = await cli(['seal', 'review', '--verdict', 'APPROVE']);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('specs/001-demo/spec.md');
  });
});

describe('M-36: devcontainer only on demand', () => {
  it('init does not write it; ci devcontainer does, and refuses to overwrite without --force', async () => {
    await consumer();
    const target = path.join(root, '.devcontainer', 'devcontainer.json');
    await expect(fs.access(target)).rejects.toThrow();
    const written = await cli(['ci', 'devcontainer']);
    expect(written.code, written.out).toBe(0);
    const config = JSON.parse(await fs.readFile(target, 'utf8')) as { image: string; postCreateCommand: string };
    expect(config.image).toContain('javascript-node');
    expect(config.postCreateCommand).toContain('uv');
    expect((await cli(['ci', 'devcontainer'])).code).toBe(1);
    expect((await cli(['ci', 'devcontainer', '--force'])).code).toBe(0);
  });
});

describe('M-29: presets — angular-express refreshed and php by composer.json', () => {
  it('php is detected by composer.json and projects its interpolated rules and preset commands', async () => {
    await fs.writeFile(path.join(root, 'composer.json'), JSON.stringify({ name: 'acme/demo', require: {} }));
    const result = await cli(['init', '--preset-only', '--yes']);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('init: php');
    const manifest = await read('manifest.yaml');
    expect(manifest).toContain('test: vendor/bin/phpunit');
    expect(manifest).toContain('install: composer install');
    expect(manifest).not.toMatch(/:\s*bash /);
    expect(await read('.claude/rules/php.md')).toContain('Stack: php · dependencies with composer.');
    expect(await read('.claude/rules/modules.md')).toContain('# Module rules');
  });

  it('angular-express publishes the GitLab and planning skills, interpolates and never calls bash', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const result = await cli(['init', '--preset', 'angular-express', '--preset-only', '--yes']);
    expect(result.code, result.out).toBe(0);
    for (const skill of ['gitlab-auth', 'gitlab-workflow', 'planning-with-files']) {
      expect(await read(`.claude/skills/${skill}/SKILL.md`)).toContain('name:');
    }
    expect(await read('.claude/rules/architecture.md')).toContain('# Architecture — angular + express');
    expect(await read('manifest.yaml')).not.toMatch(/:\s*bash /);
  });
});
