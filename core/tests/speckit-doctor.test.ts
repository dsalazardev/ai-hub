import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { checkIntegrity, readSpeckitState } from '../src/speckit/state.js';
import { fakeRunner, type FakeOptions, type FakeRunner } from './speckit-fake.js';
import { gitUnavailable, runGit } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

let root: string;

async function cli(argv: string[], fake: FakeRunner = fakeRunner(), cwd = root): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd, io, exec: fake.run });
  return { code, out: out.join('\n') };
}

function line(out: string, id: string): string {
  return out.split('\n').find((entry) => entry.includes(` ${id}: `)) ?? `(sin ${id})`;
}

async function doctor(options: FakeOptions = {}): Promise<{ code: number; out: string }> {
  return cli(['doctor'], fakeRunner(options));
}

async function editJson(rel: string, update: (data: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(root, ...rel.split('/'));
  const data = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  update(data);
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

function git(args: string[], cwd = root): { status: number; out: string } {
  // Un git que no arranca lanza GitUnavailableError; nunca se disfraza de exit 1.
  const result = runGit(args, cwd);
  return { status: result.status, out: result.stdout };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-speckit-doctor-'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
  );
  expect((await cli(['init', '--yes', '--preset-only'])).code).toBe(0);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('healthy installation', () => {
  it('passes every speckit check and reports Copilot as informational', async () => {
    const result = await doctor();
    expect(result.out).not.toContain('[FAIL]');
    expect(result.code).toBe(0);
    for (const id of ['managed', 'installed', 'version', 'script', 'shell', 'integrations', 'extensions', 'integrity', 'collision', 'constitution']) {
      expect(result.out).toContain(`speckit:${id}:`);
    }
    expect(result.out).toContain('copilot: sin Spec Kit');
    expect(line(result.out, 'speckit:constitution')).toContain('sigue siendo la plantilla');
  });
});

describe('managed, installed and version (7.1)', () => {
  it('reports a degraded harness and exits 1', async () => {
    const manifestFile = path.join(root, 'manifest.yaml');
    const manifest = parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.speckit = { managed: false };
    await fs.writeFile(manifestFile, stringify(manifest));
    const result = await doctor();
    expect(result.code).toBe(1);
    expect(line(result.out, 'speckit:managed')).toMatch(/\[FAIL\].*degradado/);
  });

  it('fails without init-options.json', async () => {
    await fs.rm(path.join(root, '.specify', 'init-options.json'));
    const result = await doctor();
    expect(result.code).toBe(1);
    expect(line(result.out, 'speckit:installed')).toMatch(/\[FAIL\].*init-options\.json/);
  });

  it('fails on a version outside the pin, naming both', async () => {
    await editJson('.specify/init-options.json', (data) => {
      data.speckit_version = '1.2.1.dev0';
    });
    const result = await doctor();
    expect(result.code).toBe(1);
    expect(line(result.out, 'speckit:version')).toMatch(/\[FAIL\].*1\.2\.1\.dev0.*1\.2\.3/);
  });
});

describe('shell (7.2)', () => {
  it('fails without bash and with a broken bash launcher', async () => {
    expect(line((await doctor({ missing: ['bash'] })).out, 'speckit:shell')).toMatch(/\[FAIL\].*bash/);
    expect(line((await doctor({ brokenBash: true })).out, 'speckit:shell')).toMatch(/\[FAIL\]/);
  });

  it('names the absolute shell resolved outside the PATH', async () => {
    const { speckitShellDetail } = await import('../src/speckit/doctor.js');
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const absolute = speckitShellDetail({ ok: true, command: gitBash, tried: ['bash', gitBash] }, 'sh');
    expect(absolute).toContain('resuelto fuera del PATH');
    expect(absolute).toContain(gitBash);
    const fromPath = speckitShellDetail({ ok: true, command: 'bash', tried: ['bash'] }, 'sh');
    expect(fromPath).toBe('bash ejecuta los scripts sh');
  });
});

describe('script drift (speckit:script)', () => {
  it('fails naming both values when the manifest script differs from the installed one', async () => {
    const manifestFile = path.join(root, 'manifest.yaml');
    const manifest = parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.speckit = { managed: true, script: 'ps' };
    await fs.writeFile(manifestFile, stringify(manifest));
    const result = await doctor();
    expect(result.code).toBe(1);
    expect(line(result.out, 'speckit:script')).toMatch(/\[FAIL\].*ps.*sh/);
  });

  it('passes when manifest and installation agree', async () => {
    const result = await doctor();
    expect(result.code).toBe(0);
    expect(line(result.out, 'speckit:script')).toMatch(/\[OK\]/);
  });
});

describe('integrations and extensions (7.3)', () => {
  it('fails when copilot is installed in Spec Kit', async () => {
    await editJson('.specify/integration.json', (data) => {
      (data.installed_integrations as string[]).push('copilot');
    });
    expect(line((await doctor()).out, 'speckit:integrations')).toMatch(/\[FAIL\].*copilot/);
  });

  it('fails when the default integration differs', async () => {
    await editJson('.specify/integration.json', (data) => {
      data.default_integration = 'opencode';
    });
    expect(line((await doctor()).out, 'speckit:integrations')).toMatch(/\[FAIL\].*opencode.*claude/);
  });

  it('fails when bug is registered only for claude', async () => {
    await editJson('.specify/extensions/.registry', (data) => {
      const extensions = data.extensions as Record<string, { registered_commands: Record<string, string[]> }>;
      extensions.bug.registered_commands = { claude: extensions.bug.registered_commands.claude };
    });
    const detail = line((await doctor()).out, 'speckit:extensions');
    expect(detail).toMatch(/\[FAIL\]/);
    for (const tool of ['opencode', 'pi', 'cursor']) {
      expect(detail).toContain(tool);
    }
  });
});

describe('integrity (7.4)', () => {
  it('detects a missing path on a synthetic .specify manifest with three paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-synthetic-specify-'));
    try {
      const files: Record<string, string> = {};
      for (const [rel, content] of [
        ['.specify/scripts/bash/a.sh', 'echo a\n'],
        ['.specify/templates/b.md', '# b\n'],
        ['.specify/templates/c.md', '# c\n'],
      ] as const) {
        files[rel] = createHash('sha256').update(content).digest('hex');
        if (rel !== '.specify/templates/c.md') {
          await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
          await fs.writeFile(path.join(dir, rel), content);
        }
      }
      await fs.mkdir(path.join(dir, '.specify', 'integrations'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.specify', 'integrations', 'synthetic.manifest.json'),
        JSON.stringify({ integration: 'synthetic', version: '1.2.3', installed_at: '2026-10-26T00:00:00Z', files }),
      );
      const report = await checkIntegrity(dir, await readSpeckitState(dir));
      expect(report).toEqual({ missing: ['.specify/templates/c.md'], modified: [], checked: 3 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails on a missing managed script, warns on an edited template, ignores installed_at', async () => {
    await editJson('.specify/integrations/claude.manifest.json', (data) => {
      data.installed_at = '2030-01-01T00:00:00+00:00';
    });
    expect(line((await doctor()).out, 'speckit:integrity')).toMatch(/\[OK\].*íntegros/);
    await fs.appendFile(path.join(root, '.specify', 'templates', 'plan-template.md'), '\n<!-- custom -->\n');
    const warned = await doctor();
    expect(line(warned.out, 'speckit:integrity')).toMatch(/\[OK\].*aviso.*plan-template\.md/);
    expect(warned.code).toBe(0);
    await fs.rm(path.join(root, '.specify', 'scripts', 'bash', 'create-new-feature.sh'));
    const failed = await doctor();
    expect(failed.code).toBe(1);
    expect(line(failed.out, 'speckit:integrity')).toMatch(/\[FAIL\].*create-new-feature\.sh/);
  });
});

describe('collision and constitution (7.5)', () => {
  it('fails when the lock claims a Spec Kit path', async () => {
    await editJson('sync.lock.json', (data) => {
      (data.files as Record<string, unknown>)['.claude/skills/speckit-plan/SKILL.md'] = {
        sha256: '0'.repeat(64),
        source: '@engine/engine/engine.yaml',
      };
    });
    expect(line((await doctor()).out, 'speckit:collision')).toMatch(/\[FAIL\].*\.claude\/skills\/speckit-plan\/SKILL\.md/);
  });

  it('stops warning once the constitution is the project own', async () => {
    await fs.writeFile(path.join(root, '.specify', 'memory', 'constitution.md'), '# Principios propios\n');
    expect(line((await doctor()).out, 'speckit:constitution')).toContain('constitución propia');
  });
});

describe('versioning (8.1)', () => {
  it('leaves Spec Kit state versionable and fails when the consumer ignores it', async ({ skip }) => {
    const gitReason = gitUnavailable();
    if (gitReason !== null) {
      skip(gitReason);
    }
    expect(git(['init', '-q']).status).toBe(0);
    for (const rel of ['.specify/memory/constitution.md', '.specify/init-options.json', '.specify/scripts/', '.specify/extensions/.registry', 'specs/']) {
      expect(git(['check-ignore', '-q', '--no-index', rel]).status, rel).toBe(1);
    }
    expect(line((await doctor()).out, 'speckit:versioning')).toMatch(/\[OK\]/);
    await fs.appendFile(path.join(root, '.gitignore'), '.specify/\n');
    const result = await doctor();
    expect(result.code).toBe(1);
    expect(line(result.out, 'speckit:versioning')).toMatch(/\[FAIL\].*constitution\.md/);
  });
});

describe('fresh clone (8.2)', () => {
  it('needs only install to become healthy without touching versioned state', async ({ skip }) => {
    const gitReason = gitUnavailable();
    if (gitReason !== null) {
      skip(gitReason);
    }
    expect(git(['init', '-q']).status).toBe(0);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    await fs.mkdir(path.join(root, 'specs', '001-demo'), { recursive: true });
    await fs.writeFile(path.join(root, 'specs', '001-demo', 'spec.md'), '# demo\n');
    expect(git(['add', '-A']).status).toBe(0);
    expect(git(['commit', '-qm', 'base']).status).toBe(0);
    const clone = path.join(os.tmpdir(), `${path.basename(root)}-clone`);
    expect(git(['clone', '-q', root, clone], os.tmpdir()).status).toBe(0);
    try {
      const before = await cli(['doctor'], fakeRunner(), clone);
      expect(before.code).toBe(1);
      expect(line(before.out, 'speckit:integrity')).toMatch(/\[FAIL\].*ai-hub install/);
      expect((await cli(['install'], fakeRunner(), clone)).code).toBe(0);
      const after = await cli(['doctor'], fakeRunner(), clone);
      expect(after.out).not.toContain('[FAIL]');
      expect(after.code).toBe(0);
      // Contenido, no stat: con core.autocrlf=true `git status` marca M un archivo reescrito con LF
      // aunque su contenido normalizado no cambie; `git diff` compara el contenido.
      const state = ['.specify/memory', 'specs', '.specify/assessments'];
      expect(git(['diff', '--name-only', '--', ...state], clone).out).toBe('');
      expect(git(['ls-files', '--others', '--exclude-standard', '--', ...state], clone).out).toBe('');
    } finally {
      await fs.rm(clone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('migration from 0.2.x (8.3)', () => {
  it('transfers ownership, keeps Spec Kit files and retires Copilot copies and runtime: false skills', async () => {
    // Estado 0.2.x: sin .specify ni bloque speckit, cuerpos speckit-* proyectados por AI-Hub y
    // una skill de la tercera cadena materializada y publicada.
    await fs.rm(path.join(root, '.specify'), { recursive: true, force: true });
    for (const dir of ['.claude/skills', '.opencode/commands', '.pi/prompts', '.cursor/skills']) {
      for (const name of await fs.readdir(path.join(root, dir)).catch(() => [])) {
        if (name.startsWith('speckit')) {
          await fs.rm(path.join(root, dir, name), { recursive: true, force: true });
        }
      }
    }
    const manifestFile = path.join(root, 'manifest.yaml');
    const manifest = parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown> & {
      skills: { source: string; publish: string[]; selection?: string };
    };
    delete manifest.speckit;
    manifest.skills.publish = ['specify'];
    manifest.skills.selection = 'custom';
    await fs.writeFile(manifestFile, stringify(manifest));
    const legacySkill = path.join(root, '.ai-hub', 'skills', 'specify');
    await fs.mkdir(legacySkill, { recursive: true });
    await fs.writeFile(
      path.join(legacySkill, 'SKILL.md'),
      '---\nname: specify\ndescription: legacy\n---\n<!-- GENERADO por ai-hub desde @engine/skills/shared/specify -->\n',
    );
    const legacy: Record<string, string> = {
      '.claude/skills/speckit-plan/SKILL.md': 'cuerpo 0.2.x',
      '.opencode/skills/speckit-plan/SKILL.md': 'cuerpo 0.2.x',
      '.pi/skills/speckit-plan/SKILL.md': 'cuerpo 0.2.x',
      '.cursor/rules/speckit-plan.mdc': 'cuerpo 0.2.x',
      '.github/skills/speckit-plan/SKILL.md': 'cuerpo 0.2.x',
      '.claude/skills/specify/SKILL.md': 'skill 0.2.x',
    };
    await editJson('sync.lock.json', (data) => {
      for (const rel of Object.keys(legacy)) {
        (data.files as Record<string, unknown>)[rel] = { sha256: '0'.repeat(64), source: '@engine/skills/shared/speckit-plan/SKILL.md' };
      }
    });
    for (const [rel, content] of Object.entries(legacy)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }

    const install = await cli(['install']);
    expect(install.code, install.out).toBe(0);
    const doctorResult = await doctor();
    expect(doctorResult.out).not.toContain('[FAIL]');
    expect(doctorResult.code).toBe(0);
    expect(await fs.readFile(path.join(root, '.claude/skills/speckit-plan/SKILL.md'), 'utf8')).toContain('author: "github-spec-kit"');
    const survivors: string[] = [];
    const legacyDirs = [
      '.opencode/skills/speckit-plan',
      '.pi/skills/speckit-plan',
      '.github/skills/speckit-plan',
      '.claude/skills/specify',
      '.ai-hub/skills/specify',
    ];
    for (const rel of [...Object.keys(legacy).slice(1), ...legacyDirs]) {
      if (await fs.access(path.join(root, rel)).then(() => true, () => false)) {
        survivors.push(rel);
      }
    }
    expect(survivors).toEqual([]);
    const after = parse(await fs.readFile(manifestFile, 'utf8')) as { speckit?: { managed?: boolean }; skills: { publish: string[] } };
    expect(after.speckit?.managed).toBe(true);
    expect(after.skills.publish).not.toContain('specify');
  });
});

describe('memory resume reads the Spec Kit feature (8.4)', () => {
  it('counts specs/<feature>/tasks.md from state and from the local pointer, without copying content', async () => {
    const workshop = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workshop-'));
    try {
      await fs.mkdir(path.join(workshop, 'core', 'src'), { recursive: true });
      await fs.writeFile(path.join(workshop, 'core', 'package.json'), JSON.stringify({ name: '@dsalazardev/ai-hub-cli', files: [] }));
      await fs.writeFile(path.join(workshop, 'core', 'src', 'paths.ts'), '');
      await fs.copyFile(path.join(root, 'manifest.yaml'), path.join(workshop, 'manifest.yaml'));
      await fs.cp(path.join(root, '.ai-hub'), path.join(workshop, '.ai-hub'), { recursive: true });
      await fs.mkdir(path.join(workshop, 'specs', '001-demo'), { recursive: true });
      await fs.writeFile(
        path.join(workshop, 'specs', '001-demo', 'tasks.md'),
        '# Tasks\n- [ ] a\n- [ ] b\n- [ ] c\n- [x] d\n- [X] e\n',
      );
      await fs.writeFile(path.join(workshop, 'specs', '001-demo', 'spec.md'), 'TEXTO-UNICO-DE-LA-SPEC\n');
      await fs.mkdir(path.join(workshop, '.specify'), { recursive: true });
      await fs.writeFile(path.join(workshop, '.specify', 'feature.json'), JSON.stringify({ feature_directory: 'specs/001-demo' }));

      const local = await cli(['memory', 'resume'], fakeRunner(), workshop);
      expect(local.out).toContain('feature Spec Kit: specs/001-demo · 3 pendientes');
      expect(local.out).toContain('puntero local');

      await fs.mkdir(path.join(workshop, '.planning'), { recursive: true });
      await fs.writeFile(
        path.join(workshop, '.planning', 'state.json'),
        JSON.stringify({
          version: 1,
          project: 'demo',
          preset: 'generic-ts',
          activeChange: 'specs/001-demo',
          lane: 'feature',
          phase: 'implement',
          tasks: { total: 0, done: 0 },
          branch: null,
          worktree: null,
          updatedAt: '2026-10-26T00:00:00.000Z',
        }),
      );
      const fromState = await cli(['memory', 'resume'], fakeRunner(), workshop);
      expect(fromState.out).toContain('tareas: 2/5');
      expect(fromState.out).toContain('3 pendientes');
      expect(fromState.out).not.toContain('puntero local');
      const planning = await fs.readdir(path.join(workshop, '.planning'));
      for (const name of planning) {
        expect(await fs.readFile(path.join(workshop, '.planning', name), 'utf8')).not.toContain('TEXTO-UNICO-DE-LA-SPEC');
      }
    } finally {
      await fs.rm(workshop, { recursive: true, force: true });
    }

    const installation = await cli(['memory', 'resume']);
    expect(installation.out).toContain('no aplica en instalación');
    await expect(fs.access(path.join(root, '.planning'))).rejects.toThrow();
  });
});

describe('workshop doctor', () => {
  it('reports every speckit check as not applicable in the engine checkout', async () => {
    const result = await cli(['doctor'], fakeRunner(), REPO);
    const speckit = result.out.split('\n').filter((entry) => entry.includes(' speckit:'));
    expect(speckit.length).toBeGreaterThanOrEqual(9);
    expect(speckit.every((entry) => entry.includes('no aplica en el checkout del motor'))).toBe(true);
  });
});
