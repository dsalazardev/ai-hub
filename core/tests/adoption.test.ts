import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { runCli } from '../src/cli/run.js';
import { runHook } from '../src/cli/hook.js';
import { loadEngine } from '../src/engine/engine.js';
import { resolveRoleScopes } from '../src/engine/scopes.js';
import { bindingRule } from '../src/speckit/binding.js';
import { materializeCatalog, readScaffold } from '../src/presets/materialize.js';
import { loadManifestContext, writeInventory } from '../src/manifest/manifest.js';
import { readLock } from '../src/sync/lock.js';
import { ENGINE_SKILLS_DIR } from '../src/engine/engine.js';
import { REGION_END, REGION_START } from '../src/sync/region.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { seedFixture } from './fixtures.js';
import { gitUnavailable, runGit } from './git.js';
import { LEGACY_FILES, LEGACY_SENTINEL, seedLegacyV1 } from './legacy-fixture.js';

const GIT = gitUnavailable();
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-adopt-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
  return { code, out: out.join('\n') };
}

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(entry.parentPath, entry.name);
    const stat = await fs.stat(abs);
    const rel = path.relative(dir, abs).replace(/\\/g, '/');
    result[rel] = entry.isFile()
      ? `${createHash('sha256').update(await fs.readFile(abs)).digest('hex')}@${stat.mtimeMs}`
      : `dir@${stat.mtimeMs}`;
  }
  return result;
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(root, ...rel.split('/'))).then(
    () => true,
    () => false,
  );
}

describe('adopt F0: detection without writes (6.3)', () => {
  it('detects the eight legacy items and leaves the tree byte for byte, mtimes included', async () => {
    await seedLegacyV1(root);
    const before = await snapshotTree(root);
    const result = await cli(['adopt', '--dry-run']);
    expect(result.code).toBe(0);
    for (const id of ['vendored-core', 'manifest-v1', 'lock-v1', 'harness-mcp', 'openspec', 'planning', 'ai-scripts', 'githooks']) {
      expect(result.out, id).toContain(`[DETECTADO] ${id}:`);
    }
    expect(result.out).toContain('F1 convertir — snapshot');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('a repository without a legacy harness has nothing to adopt', async () => {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}');
    expect((await cli(['adopt', '--dry-run'])).code).toBe(1);
  });
});

describe('adopt F1–F4 (6.4, 6.5, 6.6)', () => {
  it('snapshots first, converts v1 to a valid v2, moves MCP to the root and never snapshots the .env', async () => {
    await seedLegacyV1(root);
    const result = await cli(['adopt', '--yes']);
    expect(result.out).toMatch(/\[F1\] snapshot \S+/);
    const context = await loadManifestContext(root);
    expect(context.manifest.version).toBe(2);
    expect(context.manifest.rules.publish).toEqual(expect.arrayContaining(['frontend', 'backend']));
    expect(context.manifest.paths.areas).toEqual([
      { id: 'frontend', paths: ['frontend/src'], role: 'implementer-frontend' },
      { id: 'backend', paths: ['backend/src'], role: 'implementer-backend' },
    ]);
    expect(context.manifest.targets).toEqual(['claude', 'opencode']);
    expect(context.manifest.policy.legacy?.openspec).toBe('archive');
    expect(await exists('.ai-hubrc.json')).toBe(true);
    const mcp = parse(await read('mcp-manifest.yaml')) as { required_mcps: Array<Record<string, unknown>> };
    expect(mcp.required_mcps).toEqual([{ id: 'browser', type: 'local', client: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] } }]);
    expect(result.out).toContain('sin equivalente: prompts');
    expect(await read('.ai-hub/legacy/manifest.v1.yaml')).toBe(LEGACY_FILES['.ai-hub/manifest.yaml']);
    expect(await exists('.ai-hub/manifest.yaml')).toBe(false);
    const snapshotId = /\[F1\] snapshot (\S+)/.exec(result.out)?.[1] ?? '';
    const record = JSON.parse(await read(`.backups/${snapshotId}/snapshot.json`)) as { files: string[] };
    expect(record.files).toContain('.ai-hub/manifest.yaml');
    expect(record.files).not.toContain('.ai-hub/.env');
    for (const rel of await fs.readdir(path.join(root, '.backups'), { recursive: true })) {
      const abs = path.join(root, '.backups', rel);
      if ((await fs.stat(abs)).isFile()) {
        expect(await fs.readFile(abs, 'utf8'), rel).not.toContain(LEGACY_SENTINEL);
      }
    }
    expect((await cli(['restore', snapshotId])).code).toBe(0);
    expect(await read('.ai-hub/manifest.yaml')).toBe(LEGACY_FILES['.ai-hub/manifest.yaml']);
    expect(await read('.ai-hub/core/package.json')).toBe(LEGACY_FILES['.ai-hub/core/package.json']);
  });

  it('F2: legacy artifacts warn while coexistence lasts and fail after it; openspec stays intact', async () => {
    await seedLegacyV1(root);
    await cli(['adopt', '--yes']);
    const warned = await cli(['doctor']);
    expect(warned.out).toMatch(/\[OK\] {3}engine:no-legacy-prefix: aviso: convivencia con la metodología anterior hasta \d{4}-\d{2}-\d{2}/);
    expect(await read('openspec/specs/billing/spec.md')).toBe(LEGACY_FILES['openspec/specs/billing/spec.md']);
    const manifestFile = path.join(root, 'manifest.yaml');
    const text = await fs.readFile(manifestFile, 'utf8');
    await fs.writeFile(manifestFile, text.replace(/until: '?\d{4}-\d{2}-\d{2}'?/, "until: '2020-01-01'"));
    const expired = await cli(['doctor']);
    expect(expired.code).toBe(1);
    expect(expired.out).toContain('[FAIL] engine:no-legacy-prefix: caducada');
  });

  it('F3: removes the vendored core, prints the scripts diff and never edits user files; F4 reports', async () => {
    await seedLegacyV1(root);
    const result = await cli(['adopt', '--yes', '--archive-planning']);
    expect(await exists('.ai-hub/core')).toBe(false);
    expect(await read('package.json')).toBe(LEGACY_FILES['package.json']);
    expect(await read('.githooks/pre-commit')).toBe(LEGACY_FILES['.githooks/pre-commit']);
    expect(result.out).toContain('[F3] package.json NO se edita');
    expect(result.out).toContain('-   "ai:sync": "node .ai-hub/core/dist/cli.js sync",');
    expect(result.out).toContain('+   "ai:sync": "npx ai-hub sync",');
    expect(result.out).toContain('-   "ai:custom": "echo custom",');
    expect(await read('.ai-hub/work/legacy-planning/findings.md')).toBe(LEGACY_FILES['.planning/findings.md']);
    expect(result.out).toMatch(/\[F4\] drift: sin deriva/);
    expect(result.out, result.out.split('\n').filter((line) => line.startsWith('[F4]')).join(' | ')).toMatch(/\[F4\] doctor: sano/);
    expect(result.code).toBe(0);
  });
});

describe('agents-md region (6.7, 6.8)', () => {
  async function seededAgentsMd(): Promise<void> {
    await seedFixture(root);
    await fs.appendFile(path.join(root, 'manifest.yaml'), 'agentsMd: true\n');
    await fs.writeFile(path.join(root, 'AGENTS.md'), '# Team guide\n\nOur own text.\n');
    await writeInventory(root);
  }

  it('writes only between the markers, preserves user text and locks the region hash', async () => {
    await seededAgentsMd();
    expect((await cli(['sync'])).code).toBe(0);
    const text = await read('AGENTS.md');
    expect(text.startsWith('# Team guide\n\nOur own text.\n')).toBe(true);
    expect(text).toContain(REGION_START);
    expect(text).toContain('## Contrato de cierre');
    const lock = await readLock(root);
    expect(lock?.files['AGENTS.md']?.region).toBe('ai-hub');
    await fs.writeFile(path.join(root, 'AGENTS.md'), `${text}\n## More team notes\n`);
    expect((await cli(['drift'])).code).toBe(0);
    await fs.writeFile(path.join(root, 'AGENTS.md'), text.replace('## Contrato de cierre', '## Edited by hand'));
    expect((await cli(['drift'])).code).toBe(1);
    expect((await cli(['sync'])).code).toBe(0);
    expect(await read('AGENTS.md')).toContain('## Contrato de cierre');
  });

  it('not selected means untouched; disabling removes only the region', async () => {
    await seedFixture(root);
    await writeInventory(root);
    await fs.writeFile(path.join(root, 'AGENTS.md'), '# Team guide\n');
    await cli(['sync']);
    expect(await read('AGENTS.md')).toBe('# Team guide\n');
    await fs.appendFile(path.join(root, 'manifest.yaml'), 'agentsMd: true\n');
    await writeInventory(root);
    await cli(['sync']);
    expect(await read('AGENTS.md')).toContain(REGION_END);
    const manifestFile = path.join(root, 'manifest.yaml');
    await fs.writeFile(manifestFile, (await fs.readFile(manifestFile, 'utf8')).replace('agentsMd: true\n', ''));
    await writeInventory(root);
    await cli(['sync']);
    expect(await read('AGENTS.md')).toBe('# Team guide\n');
  });

  it('doctor warns about a 266 KB AGENTS.md without degrading', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    const before = await cli(['doctor']);
    await fs.writeFile(path.join(root, 'AGENTS.md'), `# Guide\n${'x'.repeat(266 * 1024)}\n`);
    const after = await cli(['doctor']);
    expect(after.out).toMatch(/\[OK\] {3}agents-md:size: aviso: AGENTS.md ocupa 266 KB \(presupuesto 32 KB\)/);
    expect(after.code).toBe(before.code);
  });
});

describe('areas (6.9, 6.10)', () => {
  const AREAS = [
    'areas:',
    '    - id: frontend',
    '      paths: [frontend/src]',
    '      role: implementer-frontend',
    '      rules: [frontend]',
    '    - id: backend',
    '      paths: [backend/src]',
    '      role: implementer-backend',
  ];

  async function withAreas(extra = ''): Promise<void> {
    await seedFixture(root);
    const manifestFile = path.join(root, 'manifest.yaml');
    const text = await fs.readFile(manifestFile, 'utf8');
    await fs.writeFile(manifestFile, `${text.replace(/(paths:\n(?: {2}\w+:.*\n(?: {4}- .*\n)*)+)/, (block) => `${block}  ${AREAS.join('\n')}\n`)}${extra}`);
    await writeInventory(root);
  }

  it('implementer scopes resolve from areas and the role count is unchanged', async () => {
    const engine = await loadEngine();
    const scopes = resolveRoleScopes(engine, [
      { id: 'frontend', paths: ['frontend/src'], role: 'implementer-frontend' },
      { id: 'backend', paths: ['backend/src'], role: 'implementer-backend' },
    ]);
    expect(scopes['implementer-frontend']).toEqual(['frontend/src/**']);
    expect(scopes['implementer-backend']).toEqual(['backend/src/**']);
    expect(Object.keys(scopes)).toHaveLength(engine.roles.length);
    expect(resolveRoleScopes(engine, undefined)['implementer-frontend']).toEqual(['src/**']);
  });

  it('an unknown area role fails the manifest naming it', async () => {
    await withAreas();
    const manifestFile = path.join(root, 'manifest.yaml');
    await fs.writeFile(manifestFile, (await fs.readFile(manifestFile, 'utf8')).replace('role: implementer-backend', 'role: implementer-mobile'));
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(1);
    expect(doctor.out).toContain('paths.areas "backend" usa el rol desconocido "implementer-mobile"');
  });

  it('sync renders one rule per area per target and the area AGENTS.md region', async () => {
    await withAreas('agentsMd: true\n');
    expect((await cli(['sync'])).code).toBe(0);
    expect(await read('.claude/rules/ai-hub-area-frontend.md')).toContain('`frontend/src/**`');
    expect(await read('.cursor/rules/ai-hub-area-frontend.mdc')).toContain('globs: frontend/src/**');
    expect(await read('.github/instructions/ai-hub-area-backend.instructions.md')).toContain('applyTo: backend/src/**');
    const area = await read('frontend/src/AGENTS.md');
    expect(area).toContain(REGION_START);
    expect(area).toContain('implementer-frontend');
  });

  it.skipIf(GIT !== null)('the scope hook catches a frontend implementer writing in backend/', async () => {
    runGit(['init', '-q'], root);
    await withAreas();
    await cli(['sync']);
    runGit(['add', '-A'], root);
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], root);
    const previous = process.env.AI_HUB_ROLE;
    process.env.AI_HUB_ROLE = 'implementer-frontend';
    try {
      await runHook('pre', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'area1' }), root);
      await fs.mkdir(path.join(root, 'frontend', 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'frontend', 'src', 'ok.ts'), 'export {};\n');
      await fs.mkdir(path.join(root, 'backend', 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'backend', 'src', 'leak.ts'), 'export {};\n');
      const post = (await runHook('post', JSON.stringify({ session_id: 'area1' }), root)).output as { systemMessage?: string };
      expect(post.systemMessage).toContain('backend/src/leak.ts');
      expect(post.systemMessage).not.toContain('frontend/src/ok.ts');
    } finally {
      if (previous === undefined) {
        delete process.env.AI_HUB_ROLE;
      } else {
        process.env.AI_HUB_ROLE = previous;
      }
    }
  });
});

describe('policy knobs (6.11)', () => {
  it('a value more permissive than the engine fails naming the field; declared knobs reach the rule', async () => {
    await seedFixture(root);
    const manifestFile = path.join(root, 'manifest.yaml');
    const text = await fs.readFile(manifestFile, 'utf8');
    await fs.writeFile(manifestFile, text.replace(/(policy:\n)/, '$1  wip: 2\n'));
    const raised = await cli(['doctor']);
    expect(raised.code).toBe(1);
    expect(raised.out).toContain('policy.wip 2 supera el límite del motor (policy_limits.wip = 1)');
    const engine = await loadEngine();
    expect(bindingRule(engine, 'claude')).not.toContain('## Política del proyecto');
    const rule = bindingRule(engine, 'claude', { wip: 1, maxRounds: 2, requireEars: true, requireTraceability: true });
    expect(rule).toContain('## Política del proyecto');
    expect(rule).toContain('Como máximo 1 feature(s) en curso');
    expect(rule).toContain('como máximo 2 rondas');
    expect(rule).toContain('notación EARS');
    expect(rule).toContain('Cada requisito se traza');
  });
});

describe('three-way scaffold refresh (6.12, E5)', () => {
  const rel = '.ai-hub/skills/code-review/SKILL.md';
  const engineFile = path.join(ENGINE_SKILLS_DIR, 'code-review', 'SKILL.md');
  const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

  async function setRecord(hash: string): Promise<void> {
    const file = path.join(root, '.ai-hub', '.scaffold.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as { files: Record<string, { sha256: string }> };
    record.files[rel].sha256 = hash;
    await fs.writeFile(file, JSON.stringify(record, null, 2));
  }

  it('untouched + same content → kept; record unchanged', async () => {
    await materializeCatalog(root, ['code-review'], []);
    const record = JSON.stringify((await readScaffold(root)).files[rel]);
    const result = await materializeCatalog(root, ['code-review'], []);
    expect(result.kept).toContain(rel);
    expect(result.updated).toEqual([]);
    expect(await read(rel)).toBe(await fs.readFile(engineFile, 'utf8'));
    expect(JSON.stringify((await readScaffold(root)).files[rel])).toBe(record);
  });

  it('untouched + improved package → updated; new content on disk and record updated', async () => {
    await materializeCatalog(root, ['code-review'], []);
    const old = '# old code-review\n';
    await fs.writeFile(path.join(root, ...rel.split('/')), old);
    await setRecord(sha(old));
    const result = await materializeCatalog(root, ['code-review'], []);
    expect(result.updated).toContain(rel);
    const fresh = await fs.readFile(engineFile, 'utf8');
    expect(await read(rel)).toBe(fresh);
    expect((await readScaffold(root)).files[rel].sha256).toBe(sha(fresh));
  });

  it('edited by the project → collision; content and record preserved', async () => {
    await materializeCatalog(root, ['code-review'], []);
    const record = JSON.stringify((await readScaffold(root)).files[rel]);
    await fs.appendFile(path.join(root, ...rel.split('/')), '\n- project edit\n');
    const edited = await read(rel);
    const result = await materializeCatalog(root, ['code-review'], []);
    expect(result.collisions).toContain(rel);
    expect(await read(rel)).toBe(edited);
    expect(JSON.stringify((await readScaffold(root)).files[rel])).toBe(record);
  });
});

describe('upgrade probe (6.13, E5b)', () => {
  it('install refreshes an untouched old skill and preserves a project-edited one as a collision', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes'])).code).toBe(0);
    expect((await cli(['add', 'skill', 'code-review'])).code).toBe(0);
    expect((await cli(['add', 'skill', 'debug'])).code).toBe(0);
    const old = '---\nname: code-review\ndescription: old copy shipped by a previous version\n---\n\n# old\n';
    const oldRel = '.ai-hub/skills/code-review/SKILL.md';
    await fs.writeFile(path.join(root, ...oldRel.split('/')), old);
    const scaffoldFile = path.join(root, '.ai-hub', '.scaffold.json');
    const record = JSON.parse(await fs.readFile(scaffoldFile, 'utf8')) as { files: Record<string, { sha256: string }> };
    record.files[oldRel].sha256 = createHash('sha256').update(old, 'utf8').digest('hex');
    await fs.writeFile(scaffoldFile, JSON.stringify(record, null, 2));
    const editedRel = '.ai-hub/skills/debug/SKILL.md';
    await fs.appendFile(path.join(root, ...editedRel.split('/')), '\n- project rule\n');
    const edited = await read(editedRel);
    const install = await cli(['install', '--yes']);
    expect(install.code, install.out).toBe(0);
    expect(install.out).toMatch(/\d+ actualizados/);
    expect(await read(oldRel)).toBe(await fs.readFile(path.join(ENGINE_SKILLS_DIR, 'code-review', 'SKILL.md'), 'utf8'));
    expect(await read(editedRel)).toBe(edited);
    const doctor = await cli(['doctor']);
    expect(doctor.out).toContain('[OK]   catalog:references');
  });
});
