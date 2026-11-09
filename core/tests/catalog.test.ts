import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontmatterString, splitFrontmatter } from '../src/frontmatter.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import { loadSyncConfig } from '../src/sync/config.js';
import { renderAll } from '../src/sync/render.js';
import { seedFixture } from './fixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('real catalog', () => {
  it('validates 40 agents, 262 project skills and 17 Spec Kit commands', async () => {
    const context = await loadManifestContext(REPO_ROOT);
    const speckitCommands = [...new Set(context.engine.commands.map((command) => command.speckit))];

    expect(context.manifest.agents.publish).toHaveLength(40);
    expect(context.manifest.skills.publish).toHaveLength(262);
    expect(speckitCommands).toHaveLength(17);

    for (const agent of context.manifest.agents.publish) {
      const file = path.join(REPO_ROOT, context.manifest.agents.source, `${agent}.md`);
      const { data } = splitFrontmatter(await fs.readFile(file, 'utf8'), file);
      expect(frontmatterString(data, 'name', file)).toBe(agent);
      expect(frontmatterString(data, 'description', file).length).toBeGreaterThan(0);
    }

    for (const skill of context.manifest.skills.publish) {
      const file = path.join(REPO_ROOT, context.manifest.skills.source, skill, 'SKILL.md');
      const { data } = splitFrontmatter(await fs.readFile(file, 'utf8'), file);
      expect(frontmatterString(data, 'name', file)).toBe(skill);
    }

  });

  it('renders the real catalog with a sample per target', async () => {
    const config = await loadSyncConfig(REPO_ROOT);
    const sampled = {
      ...config,
      skills: {
        ...config.skills,
        sources: config.skills.sources.map((source) => ({
          ...source,
          publish: source.publish.filter((id) => id === 'code-review'),
        })),
      },
      agents: {
        ...config.agents,
        publish: ['spec-author', 'reviewer-tests'].filter((id) =>
          config.agents.publish.includes(id),
        ),
      },
      rules: {
        ...config.rules,
        publish: config.rules.publish.slice(0, 1),
      },
    };
    const rendered = await renderAll(REPO_ROOT, sampled);

    expect(rendered.size).toBeGreaterThan(0);
    for (const sample of [
      '.claude/agents/spec-author.md',
      '.opencode/agents/spec-author.md',
      '.cursor/agents/spec-author.md',
      '.github/agents/spec-author.agent.md',
      '.cursor/rules/code-review.mdc',
      '.claude/rules/ai-hub-speckit.md',
      '.claude/rules/engine-core.md',
    ]) {
      expect(rendered.has(sample)).toBe(true);
    }
  });

  it('preserves a colon description exactly', async () => {
    const file = path.join(REPO_ROOT, 'core/agents/cpp-build-resolver.md');
    const { data } = splitFrontmatter(await fs.readFile(file, 'utf8'), file);
    expect(frontmatterString(data, 'description', file)).toBe(
      'C++ build resolver: reproduces a failing build and applies the minimum verified repair. NOT ownership review or build-system modernization.',
    );
  });

  it('rejects a description with an unquoted colon', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-catalog-'));
    try {
      await seedFixture(root);
      await fs.writeFile(
        path.join(root, '.ai-hub/agents/spec-author.md'),
        '---\nname: spec-author\ndescription: A: B\n---\n\n# spec-author\n',
        'utf8',
      );
      await expect(loadManifestContext(root)).rejects.toThrow(/spec-author\.md/);
      await expect(loadManifestContext(root)).rejects.toThrow(/Nested mappings|frontmatter/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an agent with an unknown role and loads a known one without projecting it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-catalog-'));
    try {
      await seedFixture(root);
      await fs.writeFile(
        path.join(root, '.ai-hub/agents/spec-author.md'),
        '---\nname: spec-author\ndescription: Authors requirements.\nrole: no-such-role\n---\n\n# spec-author\n',
        'utf8',
      );
      await expect(loadManifestContext(root)).rejects.toThrow(/spec-author/);
      await expect(loadManifestContext(root)).rejects.toThrow(/no-such-role/);

      await fs.writeFile(
        path.join(root, '.ai-hub/agents/spec-author.md'),
        '---\nname: spec-author\ndescription: Authors requirements.\nrole: refuter\n---\n\n# spec-author\n',
        'utf8',
      );
      const context = await loadManifestContext(root);
      expect(context.manifest.agents.publish).toContain('spec-author');
      const config = await loadSyncConfig(root);
      const rendered = await renderAll(root, config);
      const claudeAgent = rendered.get('.claude/agents/spec-author.md');
      expect(claudeAgent).toBeDefined();
      expect(claudeAgent).not.toContain('role:');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest asset validation modes (repair-assets)', () => {
  const SKILL = 'code-review';

  /** Publica una skill del catálogo sin materializar su fuente (queda ausente en .ai-hub). */
  async function publishCatalogSkill(dir: string): Promise<void> {
    const file = path.join(dir, 'manifest.yaml');
    const manifest = await fs.readFile(file, 'utf8');
    const needle = 'skills:\n  source: .ai-hub/skills\n  publish: []';
    if (!manifest.includes(needle)) {
      throw new Error('el fixture del manifiesto no contiene el bloque de skills esperado');
    }
    await fs.writeFile(
      file,
      manifest.replace(
        needle,
        `skills:\n  source: .ai-hub/skills\n  publish:\n    - ${SKILL}\n  selection: custom`,
      ),
    );
  }

  it('strict default rejects a restorable missing source', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-assets-'));
    try {
      await seedFixture(dir);
      await publishCatalogSkill(dir);
      await expect(loadManifestContext(dir)).rejects.toThrow(
        `skills.publish "${SKILL}" no existe en .ai-hub/skills`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerant mode accepts restorable missing skill and rule sources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-assets-'));
    try {
      await seedFixture(dir);
      await publishCatalogSkill(dir);
      await fs.rm(path.join(dir, '.ai-hub', 'rules', 'core.md'), { force: true });
      const context = await loadManifestContext(dir, { assets: 'tolerant' });
      expect(context.manifest.skills.publish).toEqual([SKILL]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('unknown publish ids fail in strict and tolerant modes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-assets-'));
    try {
      await seedFixture(dir);
      const file = path.join(dir, 'manifest.yaml');
      const manifest = await fs.readFile(file, 'utf8');
      await fs.writeFile(
        file,
        manifest.replace(
          'skills:\n  source: .ai-hub/skills\n  publish: []',
          'skills:\n  source: .ai-hub/skills\n  publish:\n    - skill-inexistente-xyz',
        ),
      );
      await expect(loadManifestContext(dir)).rejects.toThrow(/skill-inexistente-xyz/);
      await expect(loadManifestContext(dir, { assets: 'tolerant' })).rejects.toThrow(
        /skill-inexistente-xyz/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('corrupt frontmatter of a present source fails in strict and tolerant modes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-assets-'));
    try {
      await seedFixture(dir);
      await publishCatalogSkill(dir);
      await fs.mkdir(path.join(dir, '.ai-hub', 'skills', SKILL), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.ai-hub', 'skills', SKILL, 'SKILL.md'),
        `---\nname: ${SKILL}\ndescription: A: B\n---\n\n# ${SKILL}\n`,
        'utf8',
      );
      await expect(loadManifestContext(dir)).rejects.toThrow(/Nested mappings|frontmatter/i);
      await expect(loadManifestContext(dir, { assets: 'tolerant' })).rejects.toThrow(
        /Nested mappings|frontmatter/i,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
