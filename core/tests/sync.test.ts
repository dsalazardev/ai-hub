import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PACKAGE_NAME } from '../src/package-info.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildLock,
  checkLock,
  runSync,
  SyncSourceCheckoutError,
  SyncSourceError,
} from '../src/sync/sync.js';
import { normalize, putRendered, type RenderedFiles } from '../src/sync/render.js';
import { sha256 } from '../src/sync/lock.js';
import { seedFixture } from './fixtures.js';

const PREFLIGHT_SOURCE = fileURLToPath(new URL('../engine/preflight.md', import.meta.url));

let root: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-sync-'));
  await seedFixture(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('runSync: writing', () => {
  it('projects engine skills and project content to five targets, then checks clean', async () => {
    const result = await runSync(root, { check: false });
    expect(result.written).toContain('.claude/skills/speckit-plan/SKILL.md');
    expect(result.written).toContain('.claude/agents/spec-author.md');
    expect(result.written).toContain('.claude/rules/core.md');
    expect(result.written).toContain('.claude/rules/preflight.md');
    expect(await read('sync.lock.json')).toContain('"version": 2');

    const check = await runSync(root, { check: true });
    expect(check.problems).toEqual([]);
  });

  it('records the generator version and a SHA-256 for every source and output', async () => {
    await runSync(root, { check: false });
    const lock = JSON.parse(await read('sync.lock.json')) as {
      generatorVersion: string;
      sources: Record<string, string>;
      files: Record<string, { sha256: string }>;
    };
    expect(lock.generatorVersion).toBe('1.0.0');
    expect(Object.keys(lock.sources).length).toBeGreaterThan(0);
    for (const hash of Object.values(lock.sources)) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const entry of Object.values(lock.files)) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const projectSource = Object.keys(lock.sources).find((source) => source.startsWith('.ai-hub/'));
    expect(projectSource).toBeDefined();
    expect(lock.sources[projectSource as string]).toBe(sha256(normalize(await read(projectSource as string))));
  });

  it('records a canonical preflight source and keeps its marker', async () => {
    await runSync(root, { check: false });
    const lock = JSON.parse(await read('sync.lock.json')) as {
      sources: Record<string, string>;
      files: Record<string, { sha256: string; source: string; markerSource?: string }>;
    };
    const destination = '.claude/rules/preflight.md';
    expect(lock.files[destination].source).toBe('@engine/engine/preflight.md');
    expect(lock.files[destination].markerSource).toBe('engine/preflight.md');
    expect(lock.sources['@engine/engine/preflight.md']).toBe(
      sha256(normalize(await fs.readFile(PREFLIGHT_SOURCE, 'utf8'))),
    );
    expect(lock.sources['@engine/engine/preflight.md']).not.toBe(sha256(''));
    expect(await read(destination)).toContain(
      '<!-- GENERADO por ai-hub sync desde engine/preflight.md',
    );
    for (const [rel, entry] of Object.entries(lock.files)) {
      expect(lock.sources[entry.source], `source missing for ${rel}`).toBeDefined();
    }
  });

  it('fails with SyncSourceError when a rendered source does not resolve', async () => {
    const rendered: RenderedFiles = new Map([
      ['destino.md', { content: 'x', source: 'missing.md' }],
    ]);
    await expect(buildLock(root, rendered)).rejects.toBeInstanceOf(SyncSourceError);
    await expect(buildLock(root, rendered)).rejects.toThrow(/missing\.md/);
  });

  it('explains engine sources without exposing the package path', async () => {
    await runSync(root, { check: false });
    await fs.rm(path.join(root, '.claude/skills/speckit-plan/SKILL.md'));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('viene del motor; actualiza el paquete');
  });

  it('refuses to write in an engine checkout without force', async () => {
    await write('core/package.json', JSON.stringify({ name: PACKAGE_NAME }));
    await write('core/src/paths.ts', 'export {};\n');
    await expect(runSync(root, { check: false })).rejects.toBeInstanceOf(
      SyncSourceCheckoutError,
    );
    const forced = await runSync(root, { check: false, force: true });
    expect(forced.written.length).toBeGreaterThan(0);
  });

  it('is idempotent on a second run', async () => {
    await runSync(root, { check: false });
    const second = await runSync(root, { check: false });
    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('normalizes CRLF to LF in generated copies', async () => {
    await write('.ai-hub/rules/core.md', '# Core\r\n\r\n- rule\r\n');
    await runSync(root, { check: false });
    const copy = await read('.claude/rules/core.md');
    expect(copy).not.toContain('\r');
    expect(copy).toContain('- rule\n');
  });

  it('marks generated Markdown with its source below the frontmatter', async () => {
    await runSync(root, { check: false });
    const copy = await read('.claude/agents/spec-author.md');
    expect(copy).toMatch(
      /^---\nname: spec-author\ndescription: fixture agent spec-author\n---\n<!-- GENERADO por ai-hub sync desde \.ai-hub\/agents\/spec-author\.md — no editar -->\n/,
    );
  });

  it('uses the target shape: Cursor .mdc, Copilot instructions, Claude settings-free rule', async () => {
    await runSync(root, { check: false });
    expect(await read('.cursor/rules/core.mdc')).toContain('alwaysApply: true');
    expect(await read('.github/instructions/core.instructions.md')).toContain('applyTo: "**"');
    expect(await read('.claude/rules/core.md')).toContain('# Fixture core rules');
    expect(await read('.github/skills/speckit-plan/SKILL.md')).toContain('speckit-plan');
    expect(await read('.opencode/skills/speckit-plan/SKILL.md')).toContain('speckit-plan');
    expect(await read('.pi/skills/speckit-plan/SKILL.md')).toContain('speckit-plan');
    expect(await read('.cursor/rules/speckit-plan.mdc')).toContain('speckit-plan');
  });

  it('writes MCP configuration per client', async () => {
    await runSync(root, { check: false });
    const claude = JSON.parse(await read('.mcp.json'));
    const cursor = JSON.parse(await read('.cursor/mcp.json'));
    const opencode = JSON.parse(await read('opencode.json'));
    expect(claude.mcpServers.demo).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(cursor.mcpServers.demo).toEqual({ url: 'https://example.com/mcp' });
    expect(opencode.mcp.demo.type).toBe('remote');
    expect(opencode.instructions).toEqual(['.ai-hub/rules/core.md']);
  });

  it('migrates a v1 lock and preserves the destination set', async () => {
    await runSync(root, { check: false });
    const current = JSON.parse(await read('sync.lock.json')) as {
      sources: Record<string, string>;
      files: Record<string, unknown>;
    };
    await write('sync.lock.json', JSON.stringify({ version: 1, sources: current.sources, files: current.files }));
    const result = await runSync(root, { check: false });
    expect(result.written).toEqual([]);
    const migrated = JSON.parse(await read('sync.lock.json')) as {
      version: number;
      files: Record<string, unknown>;
    };
    expect(migrated.version).toBe(2);
    expect(Object.keys(migrated.files).sort()).toEqual(Object.keys(current.files).sort());
  });

  it('restores a deleted generated file and leaves hand-written files alone', async () => {
    await runSync(root, { check: false });
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    await write('notes/manual.md', 'manual\n');
    const result = await runSync(root, { check: false });
    expect(result.written).toContain('.claude/agents/spec-author.md');
    expect(await read('notes/manual.md')).toBe('manual\n');
  });

  it('removes destinations that leave the manifest', async () => {
    await runSync(root, { check: false });
    const manifest = await read('manifest.yaml');
    await write('manifest.yaml', manifest.replace('    - reviewer-tests\n', ''));
    const result = await runSync(root, { check: false });
    expect(result.removed).toContain('.claude/agents/reviewer-tests.md');
  });

  it('rejects an agent without name or description', async () => {
    await write('.ai-hub/agents/spec-author.md', '# No frontmatter\n');
    await expect(runSync(root, { check: false })).rejects.toThrow(/sin frontmatter/);
  });
});

describe('runSync: check', () => {
  beforeEach(async () => {
    await runSync(root, { check: false });
  });

  it('does not write in check mode', async () => {
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    const before = await fs.readdir(path.join(root, '.claude/agents'));
    await runSync(root, { check: true });
    expect(await fs.readdir(path.join(root, '.claude/agents'))).toEqual(before);
  });

  it('detects a missing copy and names its source', async () => {
    await fs.rm(path.join(root, '.claude/agents/spec-author.md'));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain(
      'falta .claude/agents/spec-author.md (fuente: .ai-hub/agents/spec-author.md)',
    );
  });

  it('detects a stale copy when the source changes', async () => {
    await write('.ai-hub/agents/spec-author.md', '---\nname: spec-author\ndescription: changed\n---\n\n# New\n');
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('desactualizado: .claude/agents/spec-author.md');
  });

  it('detects a hand-edited copy and names the source to edit', async () => {
    await write('.claude/agents/spec-author.md', `${await read('.claude/agents/spec-author.md')}edited\n`);
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain(
      'editado a mano: .claude/agents/spec-author.md (edita la fuente: .ai-hub/agents/spec-author.md',
    );
  });

  it('detects an obsolete destination', async () => {
    const manifest = await read('manifest.yaml');
    await write('manifest.yaml', manifest.replace('    - reviewer-tests\n', ''));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('destino obsoleto: .claude/agents/reviewer-tests.md');
  });

  it('returns no problems on a clean tree', async () => {
    expect((await runSync(root, { check: true })).problems).toEqual([]);
  });

  const itSymlink = process.platform === 'win32' ? it.skip : it;
  itSymlink('rejects symlinks inside generated folders', async () => {
    await fs.symlink(path.join(root, '.ai-hub/agents'), path.join(root, '.claude/agents/enlace'));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('enlace simbólico no permitido: .claude/agents/enlace');
  });
});

describe('checkLock', () => {
  beforeEach(async () => {
    await runSync(root, { check: false });
  });

  it('reports a clean fixture with the category breakdown', async () => {
    const result = await checkLock(root);
    expect(result.ok).toBe(true);
    expect(result.expectedCount).toBe(123);
    expect(result.actualCount).toBe(123);
    expect(result.breakdown).toEqual({
      skills: 85,
      agents: 24,
      rules: 5,
      preflight: 5,
      mcp: 4,
      other: 0,
    });
  });

  it('reports missing entries without writing', async () => {
    const lock = JSON.parse(await read('sync.lock.json')) as {
      files: Record<string, unknown>;
    };
    delete lock.files['.claude/agents/spec-author.md'];
    await write('sync.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    const before = await read('sync.lock.json');
    const result = await checkLock(root);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('.claude/agents/spec-author.md');
    expect(await read('sync.lock.json')).toBe(before);
  });

  it('reports extra entries', async () => {
    const lock = JSON.parse(await read('sync.lock.json')) as {
      files: Record<string, { sha256: string; source: string }>;
    };
    lock.files['.claude/agents/ghost.md'] = {
      sha256: '0'.repeat(64),
      source: 'ghost.md',
    };
    await write('sync.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    const result = await checkLock(root);
    expect(result.ok).toBe(false);
    expect(result.extra).toContain('.claude/agents/ghost.md');
  });

  it('reports changed hashes as different', async () => {
    const lock = JSON.parse(await read('sync.lock.json')) as {
      files: Record<string, { sha256: string; source: string }>;
    };
    lock.files['.claude/agents/spec-author.md'].sha256 = '0'.repeat(64);
    await write('sync.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    const result = await checkLock(root);
    expect(result.ok).toBe(false);
    expect(result.different).toContain('.claude/agents/spec-author.md');
  });

  it('reports invalid source hashes', async () => {
    const lock = JSON.parse(await read('sync.lock.json')) as {
      sources: Record<string, string>;
    };
    lock.sources['manifest.yaml'] = '0'.repeat(64);
    await write('sync.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    const result = await checkLock(root);
    expect(result.ok).toBe(false);
    expect(result.invalidSources).toContain('hash de source no coincide: manifest.yaml');
  });
});

describe('normalization, spaces and collisions', () => {
  it('normalizes CRLF and CR to LF', () => {
    expect(normalize('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('rejects two sources writing the same destination', () => {
    const out: RenderedFiles = new Map();
    putRendered(out, 'destino/comun.md', { content: 'a', source: 'one' });
    expect(() => putRendered(out, 'destino/comun.md', { content: 'b', source: 'two' })).toThrow(
      /colisión de destinos/,
    );
  });

  it('syncs from a path with spaces', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-sync-space-'));
    const spaced = path.join(base, 'repo con espacios');
    await seedFixture(spaced);
    try {
      const result = await runSync(spaced, { check: false });
      expect(result.written).toContain('.claude/skills/speckit-plan/SKILL.md');
      expect((await runSync(spaced, { check: true })).problems).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
