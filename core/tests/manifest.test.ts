import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildInventory,
  checkInventory,
  inventoryPath,
  EXPECTED_COUNTS,
  loadManifest,
  validateManifestData,
  type ProjectManifest,
} from '../src/manifest/manifest.js';
import {
  crossValidate,
  findDuplicateIds,
  loadEngine,
  ENGINE_COUNTS,
  type EngineManifest,
} from '../src/engine/engine.js';
import { resolveCommand, RoleMismatchError, UnknownSpecCommandError } from '../src/manifest/dispatch.js';
import { advanceLabel, dryRunLane, LabelTransitionError, LABELS } from '../src/manifest/labels.js';
import { resolvePreset, resolvePresetWith } from '../src/presets/resolve.js';
import { validatePresetData, type Preset } from '../src/presets/schema.js';
import { chooseDetection, detectPreset } from '../src/presets/detect.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import { fixtureManifest, seedFixture } from './fixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('engine invariants', () => {
  it('declares 9 roles, 17 commands and 7 labels', async () => {
    const engine = await loadEngine();
    expect(engine.roles).toHaveLength(ENGINE_COUNTS.roles);
    expect(engine.commands).toHaveLength(ENGINE_COUNTS.commands);
    expect(engine.labels).toHaveLength(ENGINE_COUNTS.labels);
    expect(engine.targets).toHaveLength(5);
  });

  it('maps every command to a Spec Kit id with artifacts and terminal states', async () => {
    const engine = await loadEngine();
    for (const command of engine.commands) {
      expect(command.speckit).toMatch(/^speckit\./);
      expect(command.artifacts.length).toBeGreaterThan(0);
      expect(command.exit.length).toBeGreaterThan(0);
    }
    expect(engine.commands.find((command) => command.id === 'assess-decide')?.exit).toEqual([
      'GO',
      'NEEDS_CLARIFICATION',
      'KILL',
    ]);
    expect(engine.commands.find((command) => command.id === 'converge')?.exit).toContain('CONVERGED');
    expect(engine.commands.find((command) => command.id === 'bug-test')?.exit).toContain('VERIFIED');
  });

  it('marks exactly two derived roles', async () => {
    const engine = await loadEngine();
    const derived = engine.roles.filter((role) => role.derived);
    expect(derived.map((role) => role.id).sort()).toEqual(['prompt-explorer', 'reviewer-exploration']);
    expect(derived.every((role) => role.canonical === 'orchestrator')).toBe(true);
  });

  it('detects duplicate ids in a fabricated engine', () => {
    const ids = Array.from({ length: 16 }, (_, index) => `cmd-${index}`);
    ids.push('cmd-0');
    const lanes = [
      ...Array(5).fill('assessment'),
      ...Array(9).fill('feature'),
      ...Array(3).fill('bug'),
    ] as EngineManifest['commands'][number]['lane'][];
    const roles: EngineManifest['roles'] = Array.from({ length: 9 }, (_, index) => ({
      id: `r${index}`,
      canonical: `r${index}`,
      derived: false,
      can_modify: [],
      cannot_modify: [],
      commands: index === 0 ? [...ids] : [],
      gate: 'none',
    }));
    const commands: EngineManifest['commands'] = lanes.map((lane, index) => ({
      id: ids[index],
      name: `command ${index}`,
      lane,
      artifacts: ['artifact'],
      exit: ['GO'],
      role: 'r0',
      speckit: `speckit.cmd${index}`,
    }));
    const labels = Array.from({ length: 7 }, (_, index) => `label-${index}`);
    const errors = crossValidate({
      version: 2,
      roles,
      commands,
      exit_effects: { GO: 'mantiene ai::in-spec' },
      labels,
      targets: ['claude'],
      speckit: {
        package: 'specify-cli',
        supported: '>=1.2.3 <1.3.0',
        script: 'sh',
        extensions: { assess: '1.0.1', bug: '1.0.1' },
      },
    });

    expect(errors).toEqual(['comando duplicado: cmd-0']);
    expect(findDuplicateIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b']);
  });

  it('rejects a read-only role that declares writes and accepts a well-formed one', () => {
    const ids = Array.from({ length: 17 }, (_, index) => `cmd-${index}`);
    const lanes = [
      ...Array(5).fill('assessment'),
      ...Array(9).fill('feature'),
      ...Array(3).fill('bug'),
    ] as EngineManifest['commands'][number]['lane'][];
    const build = (refuterCanModify: string[]): EngineManifest => ({
      version: 2,
      roles: Array.from({ length: 9 }, (_, index) => ({
        id: `r${index}`,
        canonical: `r${index}`,
        derived: false,
        read_only: index === 1,
        can_modify: index === 1 ? refuterCanModify : [],
        cannot_modify: [],
        commands: index === 0 ? [...ids] : [],
        gate: 'none',
      })),
      commands: lanes.map((lane, index) => ({
        id: ids[index],
        name: `command ${index}`,
        lane,
        artifacts: ['artifact'],
        exit: ['GO'],
        role: 'r0',
        speckit: `speckit.cmd${index}`,
      })),
      exit_effects: { GO: 'mantiene ai::in-spec' },
      labels: Array.from({ length: 7 }, (_, index) => `label-${index}`),
      targets: ['claude'],
      speckit: {
        package: 'specify-cli',
        supported: '>=1.2.3 <1.3.0',
        script: 'sh',
        extensions: { assess: '1.0.1', bug: '1.0.1' },
      },
    });

    const offending = crossValidate(build(['src/**'])).join('\n');
    expect(offending).toContain('roles "r1"');
    expect(offending).toContain('read-only');
    expect(offending).toContain('can_modify');

    expect(crossValidate(build([]))).toEqual([]);
  });
});

describe('project manifest v2', () => {
  it('loads the repository manifest and separates project from engine', async () => {
    const context = await loadManifestContext(REPO_ROOT);
    expect(context.manifest.version).toBe(2);
    expect(context.manifest.preset.id).toBe('generic-ts');
    expect(context.manifest.targets).toHaveLength(5);
    expect(context.manifest.policy.guardMode).toBe('shadow');
    expect(context.engine.commands).toHaveLength(17);
  });

  it('rejects a project that redefines engine roles', async () => {
    const manifest = JSON.parse(JSON.stringify(await loadManifest(REPO_ROOT))) as Record<string, unknown>;
    manifest.roles = [];
    await expect(validateManifestData(manifest)).rejects.toThrow(/roles/);
  });

  it('rejects an unknown preset', async () => {
    const manifest = JSON.parse(JSON.stringify(await loadManifest(REPO_ROOT))) as ProjectManifest;
    manifest.preset.id = 'does-not-exist';
    await expect(validateManifestData(manifest)).rejects.toThrow(/does-not-exist/);
  });

  it('rejects an unknown target', async () => {
    const manifest = JSON.parse(JSON.stringify(await loadManifest(REPO_ROOT))) as ProjectManifest;
    manifest.targets = ['claude', 'nope'];
    await expect(validateManifestData(manifest)).rejects.toThrow(/nope/);
  });

  it('generates a stable inventory with engine and project counts', async () => {
    const context = await loadManifestContext(REPO_ROOT);
    const inventory = buildInventory(context.manifest, context.engine);
    expect(inventory.counts).toMatchObject({ roles: 9, commands: 17, labels: 7, targets: 5 });
    expect(inventory.preset).toEqual({ id: 'generic-ts', version: 1 });
  });

  it('places the inventory in core/ for the engine and in .ai-hub/ for a consumer', async () => {
    const consumer = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-inventory-'));
    try {
      expect(inventoryPath(REPO_ROOT)).toBe(path.join(REPO_ROOT, 'core', 'manifest.json'));
      expect(inventoryPath(consumer)).toBe(path.join(consumer, '.ai-hub', 'manifest.json'));
    } finally {
      await fs.rm(consumer, { recursive: true, force: true });
    }
  });

  it('detects a stale manifest.json', async () => {
    const result = await checkInventory(REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(result.actual).not.toBeNull();
  });
});

describe('dispatch and labels', () => {
  it('resolves a command for its primary and co-role', async () => {
    const engine = await loadEngine();
    expect(resolveCommand(engine, 'assess-intake', 'spec-explorer').lane).toBe('assessment');
    expect(resolveCommand(engine, 'implement', 'implementer-backend').id).toBe('implement');
    expect(() => resolveCommand(engine, 'assess-intake', 'reviewer-tests')).toThrow(RoleMismatchError);
    expect(() => resolveCommand(engine, 'nope', 'spec-author')).toThrow(UnknownSpecCommandError);
  });

  it('walks todo -> in-spec -> spec-ready without skipping the gate', () => {
    expect(dryRunLane('ai::todo', ['spec-start', 'spec-ready'])).toEqual([
      'ai::todo',
      'ai::in-spec',
      'ai::spec-ready',
    ]);
    expect(() => advanceLabel('ai::in-spec', 'approve')).toThrow(LabelTransitionError);
    expect(advanceLabel('ai::spec-ready', 'approve')).toBe('ai::in-dev');
    expect([...LABELS]).toHaveLength(7);
  });
});

describe('presets', () => {
  it('resolves inheritance from base to angular-express', async () => {
    const preset = await resolvePreset('angular-express');
    expect(preset.chain).toEqual(['base', 'generic-ts', 'angular-express']);
    expect(preset.stack.frontend).toBe('angular');
    expect(preset.stack.packageManager).toBe('npm');
    expect(preset.commands.test).toBe('npm test');
    expect(preset.policy.trunk).toBe('auto');
  });

  it('rejects an invalid preset and names the field', async () => {
    await expect(
      validatePresetData({
        id: 'bad',
        version: 1,
        description: 'invalid preset with an unknown command',
        commands: { deploy: 'npm run deploy' },
      }),
    ).rejects.toThrow(/commands/);
  });

  it('rejects an artificial inheritance cycle', async () => {
    const presets: Record<string, Preset> = {
      'cycle-a': { id: 'cycle-a', version: 1, description: 'cycle a', extends: 'cycle-b' },
      'cycle-b': { id: 'cycle-b', version: 1, description: 'cycle b', extends: 'cycle-a' },
    };
    await expect(resolvePresetWith('cycle-a', async (id) => presets[id])).rejects.toThrow(/ciclo/);
  });

  it('does not auto-detect the client preset and falls back to generic-ts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-detect-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { '@angular/core': '^18.0.0' } }),
      );
      await fs.writeFile(path.join(root, 'angular.json'), '{}');
      const detection = await detectPreset(root);
      expect(detection.id).toBe('generic-ts');
      expect(detection.ambiguous).toEqual([]);
      expect(detection.candidates.map((candidate) => candidate.id)).not.toContain(
        'angular-express',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a tie instead of guessing', () => {
    expect(
      chooseDetection([
        { id: 'generic-ts', score: 5 },
        { id: 'python', score: 5 },
      ]),
    ).toEqual({ id: 'base', ambiguous: ['generic-ts', 'python'] });
    expect(chooseDetection([{ id: 'python', score: 4 }])).toEqual({ id: 'python', ambiguous: [] });
  });

  it('detects python from pyproject.toml', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-detect-py-'));
    try {
      await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
      const detection = await detectPreset(root);
      expect(detection.id).toBe('python');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('validates a fixture manifest against the real presets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-manifest-'));
    try {
      await seedFixture(root);
      const context = await loadManifestContext(root);
      expect(context.preset.id).toBe('generic-ts');
      expect(context.manifest.project.id).toBe('fixture');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
