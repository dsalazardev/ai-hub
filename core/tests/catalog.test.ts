import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_SKILLS_DIR } from '../src/engine/engine.js';
import { frontmatterString, splitFrontmatter } from '../src/frontmatter.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import { loadSyncConfig } from '../src/sync/config.js';
import { renderAll } from '../src/sync/render.js';
import { seedFixture } from './fixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('real catalog', () => {
  it('validates 35 agents and 191 skills', async () => {
    const context = await loadManifestContext(REPO_ROOT);
    const engineSkills = [...new Set(context.engine.commands.map((command) => command.skill))];

    expect(context.manifest.agents.publish).toHaveLength(35);
    expect(context.manifest.skills.publish).toHaveLength(174);
    expect(engineSkills).toHaveLength(17);
    expect(context.manifest.skills.publish.length + engineSkills.length).toBe(191);

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

    for (const skill of engineSkills) {
      const file = path.join(ENGINE_SKILLS_DIR, skill, 'SKILL.md');
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
          publish: source.publish.filter((id) => id === 'speckit-plan' || id === 'code-review'),
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
      '.pi/agents/spec-author.md',
      '.github/agents/spec-author.md',
      '.cursor/rules/speckit-plan.mdc',
      '.claude/rules/core.md',
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
});
