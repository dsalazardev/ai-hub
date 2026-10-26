import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/run.js';
import { resolveAiHubDir } from '../src/paths.js';
import type { CliIO } from '../src/cli/types.js';

let root: string;

function capture(): { io: CliIO; out: string[] } {
  const out: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => out.push(line) }, out };
}

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const sink = capture();
  const code = await runCli(argv, { cwd: root, io: sink.io });
  return { code, out: sink.out.join('\n') };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-install-generic-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('full generic-ts installation', () => {
  it('installs 191 skills, 35 agents, 6 rules and 4.662 destinations', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }),
    );
    const result = await cli(['init', '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('191 skills');
    expect(result.out).toContain('35 agentes');
    expect(result.out).toContain('6 reglas');
    expect(result.out).toContain('4662 destinos');

    const rc = JSON.parse(await fs.readFile(path.join(root, '.ai-hubrc.json'), 'utf8'));
    expect(rc).toMatchObject({ version: 2, preset: 'generic-ts', guardMode: 'shadow' });
    expect(rc.targets).toEqual(['claude', 'opencode', 'pi', 'cursor', 'copilot']);
    expect(resolveAiHubDir(root).source).toBe('rc');

    await expect(fs.access(path.join(root, '.ai-hub', 'rules', 'core.md'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, '.ai-hub', 'rules', 'skill-quality', 'skill-rubric.md')),
    ).resolves.toBeUndefined();
    const materializedRules = await fs.readdir(path.join(root, '.ai-hub', 'rules'), {
      recursive: true,
    });
    expect(materializedRules.filter((entry) => entry.endsWith('.md'))).toHaveLength(5);
    expect(await fs.readFile(path.join(root, '.ai-hub', 'rules', 'core.md'), 'utf8')).not.toContain(
      'AI Hub engine',
    );
    await expect(fs.access(path.join(root, '.ai-hub', 'agents', 'spec-author.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.planning', 'state.json'))).rejects.toThrow();
    expect(
      (await fs.readdir(path.join(root, '.ai-hub', 'skills'), { withFileTypes: true })).filter(
        (entry) => entry.isDirectory(),
      ),
    ).toHaveLength(174);
    expect(
      (await fs.readdir(path.join(root, '.ai-hub', 'agents'))).filter((file) => file.endsWith('.md')),
    ).toHaveLength(35);

    const lock = JSON.parse(await fs.readFile(path.join(root, 'sync.lock.json'), 'utf8'));
    expect(Object.keys(lock.files)).toHaveLength(4662);
    const manifest = await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('selection: full');
    expect(manifest).toContain('catalog:');
    expect(manifest).not.toContain('mcp:');
    await expect(fs.access(path.join(root, '.mcp.json'))).rejects.toThrow();

    const listed = JSON.parse((await cli(['list', '--json'])).out);
    expect(listed.selection).toEqual({ skills: 'full', agents: 'full', rules: 'full' });
  });
});
