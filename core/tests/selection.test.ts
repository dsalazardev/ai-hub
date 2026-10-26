import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditSelection,
  catalogHash,
  catalogSeal,
  listCatalogAgents,
  listCatalogSkills,
  selectionMode,
  UNIVERSAL_RULE_IDS,
} from '../src/catalog.js';
import { loadEngine } from '../src/engine/engine.js';
import { PACKAGE_VERSION } from '../src/package-info.js';
import { resolvePreset } from '../src/presets/resolve.js';
import {
  buildInventory,
  readManifestFile,
  validateManifestData,
  type ProjectManifest,
} from '../src/manifest/manifest.js';
import { seedFixture } from './fixtures.js';

function manifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    version: 2,
    project: { id: 'selection', name: 'selection' },
    preset: { id: 'generic-ts', version: 1, source: 'package' },
    stack: { languages: ['typescript'] },
    commands: {},
    paths: { source: [], tests: [], docs: [] },
    targets: ['claude', 'opencode', 'pi', 'cursor', 'copilot'],
    policy: { trunk: 'auto', guardMode: 'shadow', worktrees: true, optOuts: [] },
    skills: { source: '.ai-hub/skills', publish: [], selection: 'preset' },
    agents: { source: '.ai-hub/agents', publish: [], selection: 'preset' },
    rules: { source: '.ai-hub/rules', publish: ['core'], selection: 'preset' },
    ...overrides,
  };
}

async function seedPublishedFiles(
  root: string,
  skills: string[],
  agents: string[],
): Promise<void> {
  for (const id of skills) {
    const dir = path.join(root, '.ai-hub', 'skills', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# skill\n', 'utf8');
  }
  await fs.mkdir(path.join(root, '.ai-hub', 'agents'), { recursive: true });
  for (const id of agents) {
    await fs.writeFile(path.join(root, '.ai-hub', 'agents', `${id}.md`), '# agent\n', 'utf8');
  }
  await fs.mkdir(path.join(root, '.ai-hub', 'rules'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-hub', 'rules', 'core.md'), '# core\n', 'utf8');
}

describe('catalog selection', () => {
  it('hashes only the dimensions in full mode', () => {
    const mixed = manifest({
      skills: { source: '.ai-hub/skills', publish: ['b', 'a'], selection: 'full' },
      agents: { source: '.ai-hub/agents', publish: ['z', 'x'], selection: 'full' },
      rules: { source: '.ai-hub/rules', publish: ['core'], selection: 'custom' },
    });
    const sealed = { ...mixed, catalog: catalogSeal(mixed) };
    expect(sealed.catalog.version).toBe(PACKAGE_VERSION);
    expect(catalogHash(sealed)).toBe(sealed.catalog.hash);

    const withoutRubrics = {
      ...sealed,
      rules: { ...sealed.rules, publish: [] },
    };
    expect(catalogHash(withoutRubrics)).toBe(catalogHash(sealed));

    const editedSkill = {
      ...sealed,
      skills: { ...sealed.skills, publish: ['a'] },
    };
    expect(catalogHash(editedSkill)).not.toBe(catalogHash(sealed));

    const rulesFull = {
      ...sealed,
      rules: { ...sealed.rules, publish: ['core', 'skill-quality/skill-rubric'], selection: 'full' as const },
    };
    expect(catalogHash(rulesFull)).not.toBe(catalogHash(sealed));
  });

  it('validates selection and catalog in the schema and inventory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-selection-schema-'));
    try {
      await seedFixture(root);
      const original = (await readManifestFile(root)) as ProjectManifest;
      expect(selectionMode(original.skills)).toBe('preset');
      const data = JSON.parse(JSON.stringify(original)) as ProjectManifest;
      data.skills.selection = 'full';
      data.agents.selection = 'custom';
      data.rules.selection = 'custom';
      data.catalog = { version: PACKAGE_VERSION, hash: 'a'.repeat(64) };
      const context = await validateManifestData(data, root);
      const inventory = buildInventory(context.manifest, context.engine);
      expect(inventory.selection).toEqual({
        skills: 'full',
        agents: 'custom',
        rules: 'custom',
      });
      expect(inventory.catalog).toEqual(data.catalog);

      const invalid = JSON.parse(JSON.stringify(data)) as ProjectManifest;
      invalid.skills.selection = 'all' as never;
      await expect(validateManifestData(invalid, root)).rejects.toThrow(/selection/);

      const badHash = JSON.parse(JSON.stringify(data)) as ProjectManifest;
      badHash.catalog = { version: PACKAGE_VERSION, hash: 'nope' };
      await expect(validateManifestData(badHash, root)).rejects.toThrow(/hash/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails when a full universal rule file is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-selection-rule-'));
    try {
      const engine = await loadEngine();
      const preset = await resolvePreset('generic-ts');
      await fs.mkdir(path.join(root, '.ai-hub', 'rules', 'skill-quality'), { recursive: true });
      for (const rule of UNIVERSAL_RULE_IDS.slice(0, -1)) {
        await fs.mkdir(path.dirname(path.join(root, '.ai-hub', 'rules', `${rule}.md`)), {
          recursive: true,
        });
        await fs.writeFile(path.join(root, '.ai-hub', 'rules', `${rule}.md`), '# rule\n', 'utf8');
      }
      const data = manifest({
        skills: { source: '.ai-hub/skills', publish: [], selection: 'custom' },
        agents: { source: '.ai-hub/agents', publish: [], selection: 'custom' },
        rules: {
          source: '.ai-hub/rules',
          publish: [...UNIVERSAL_RULE_IDS],
          selection: 'full',
        },
      });
      data.catalog = catalogSeal(data);
      const audit = await auditSelection(root, data, preset, engine);
      const missingRule = UNIVERSAL_RULE_IDS.at(-1) ?? '';
      expect(audit.errors.join('\n')).toContain(missingRule);
      expect(audit.missing).toContain(`rule:${missingRule}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports preset drift by naming the missing preset skills', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-selection-preset-'));
    try {
      const engine = await loadEngine();
      const preset = await resolvePreset('angular-express');
      const data = manifest({
        preset: { id: 'angular-express', version: 1, source: 'package' },
        skills: { source: '.ai-hub/skills', publish: [], selection: 'preset' },
        agents: { source: '.ai-hub/agents', publish: [], selection: 'preset' },
        rules: { source: '.ai-hub/rules', publish: [], selection: 'custom' },
      });
      const audit = await auditSelection(root, data, preset, engine);
      expect(audit.errors.join('\n')).toContain('skills.publish incompleto: faltan');
      expect(audit.expectedSkills).toHaveLength(preset.skills.length);
      expect(preset.skills.length).toBe(7);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('audits a mixed full/custom selection without relaxing skills or agents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-selection-'));
    try {
      const engine = await loadEngine();
      const preset = await resolvePreset('generic-ts');
      const skills = await listCatalogSkills(engine);
      const agents = await listCatalogAgents();
      await seedPublishedFiles(root, skills, agents);
      const mixed = manifest({
        skills: { source: '.ai-hub/skills', publish: skills, selection: 'full' },
        agents: { source: '.ai-hub/agents', publish: agents, selection: 'full' },
        rules: { source: '.ai-hub/rules', publish: ['core'], selection: 'custom' },
      });
      mixed.catalog = catalogSeal(mixed);

      const audit = await auditSelection(root, mixed, preset, engine);
      expect(audit.errors).toEqual([]);
      expect(audit.missing).toEqual([]);
      expect(audit.modes).toEqual({ skills: 'full', agents: 'full', rules: 'custom' });
      expect(audit.expectedRules).toBeNull();
      expect(selectionMode(undefined)).toBe('preset');

      const legitimateRuleUninstall = {
        ...mixed,
        rules: { ...mixed.rules, publish: [] },
      };
      expect(catalogHash(legitimateRuleUninstall)).toBe(mixed.catalog.hash);
      expect((await auditSelection(root, legitimateRuleUninstall, preset, engine)).errors).toEqual(
        [],
      );

      const missingSkill = {
        ...mixed,
        skills: { ...mixed.skills, publish: skills.slice(1) },
      };
      missingSkill.catalog = catalogSeal(missingSkill);
      const missingAudit = await auditSelection(root, missingSkill, preset, engine);
      expect(missingAudit.errors.join('\n')).toContain(`skills.publish incompleto: faltan ${skills[0]}`);

      const edited = { ...mixed, agents: { ...mixed.agents, publish: agents.slice(1) } };
      const editedAudit = await auditSelection(root, edited, preset, engine);
      expect(editedAudit.errors.join('\n')).toContain('full incompleto: publish editado');

      const stale = { ...mixed, catalog: { ...mixed.catalog, version: '0.0.1' } };
      const staleAudit = await auditSelection(root, stale, preset, engine);
      expect(staleAudit.errors).toEqual([]);
      expect(staleAudit.warnings.join('\n')).toContain('full desactualizado');

      const noSeal: ProjectManifest = { ...mixed };
      delete noSeal.catalog;
      const noSealAudit = await auditSelection(root, noSeal, preset, engine);
      expect(noSealAudit.errors.join('\n')).toContain('sin catalog.version/catalog.hash');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
