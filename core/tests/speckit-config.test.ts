import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crossValidate, loadEngine, type EngineManifest } from '../src/engine/engine.js';
import { TARGETS, TOOL_IDS } from '../src/sync/targets.js';
import {
  effectiveSpeckit,
  validateProjectSpeckit,
} from '../src/speckit/settings.js';
import { satisfiesRange } from '../src/speckit/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(__dirname, 'fixtures', 'speckit-1.2.3', 'dot.specify');

describe('speckit engine data (1.1, 1.2)', () => {
  it('declares the pin, range, date, script and extensions', async () => {
    const engine = await loadEngine();
    expect(engine.speckit).toEqual({
      package: 'specify-cli',
      pin: '1.2.3',
      supported: '>=1.2.3 <1.3.0',
      excludeNewer: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      script: 'sh',
      extensions: { assess: '1.0.1', bug: '1.0.1' },
    });
    expect(satisfiesRange(engine.speckit.pin, engine.speckit.supported)).toBe(true);
  });

  it('rejects engine data without bug or without excludeNewer', async () => {
    const engine = await loadEngine();
    const withoutBug = structuredClone(engine) as EngineManifest;
    delete (withoutBug.speckit.extensions as Record<string, string>).bug;
    expect(crossValidate(withoutBug).join('\n')).toContain('speckit.extensions.bug');
    const withoutDate = structuredClone(engine) as EngineManifest;
    (withoutDate.speckit as { excludeNewer?: string }).excludeNewer = undefined;
    expect(crossValidate(withoutDate).join('\n')).toContain('speckit.excludeNewer');
  });

  it('keeps the date as a single constant in engine.yaml', async () => {
    const raw = await fs.readFile(path.join(__dirname, '..', 'engine', 'engine.yaml'), 'utf8');
    const { excludeNewer } = (await loadEngine()).speckit;
    expect(raw.split(excludeNewer)).toHaveLength(2);
    expect(raw).toMatch(/se fija el día de la publicación de 0\.3\.0/);
  });
});

describe('version ranges', () => {
  it('evaluates comparator ranges', () => {
    expect(satisfiesRange('1.2.3', '>=1.2.3 <1.3.0')).toBe(true);
    expect(satisfiesRange('1.2.9', '>=1.2.3 <1.3.0')).toBe(true);
    expect(satisfiesRange('1.3.0', '>=1.2.3 <1.3.0')).toBe(false);
    expect(satisfiesRange('1.2.1.dev0', '>=1.2.3 <1.3.0')).toBe(false);
  });
});

describe('target registry (1.3)', () => {
  it('declares exactly four Spec Kit integrations and none for copilot', () => {
    const rows = TOOL_IDS.map((tool) => [tool, TARGETS[tool].speckit] as const);
    expect(rows.filter(([, speckit]) => speckit !== null)).toHaveLength(4);
    expect(TARGETS.copilot.speckit).toBeNull();
    expect(TARGETS.cursor.speckit?.integration).toBe('cursor-agent');
    expect(TARGETS.claude.speckit).toMatchObject({ separator: '-', commandsDir: '.claude/skills', layout: 'skill-dir' });
    expect(TARGETS.opencode.speckit).toMatchObject({ separator: '.', commandsDir: '.opencode/commands', layout: 'command-file' });
    expect(TARGETS.pi.speckit).toMatchObject({ separator: '.', commandsDir: '.pi/prompts', layout: 'command-file' });
    expect(TARGETS.cursor.speckit).toMatchObject({ separator: '-', commandsDir: '.cursor/skills', layout: 'skill-dir' });
  });

  it('matches the invoke separators recorded by Spec Kit 1.2.3', async () => {
    const recorded = JSON.parse(await fs.readFile(path.join(SNAPSHOT, 'integration.json'), 'utf8')) as {
      integration_settings: Record<string, { invoke_separator: string }>;
    };
    for (const tool of TOOL_IDS) {
      const speckit = TARGETS[tool].speckit;
      if (speckit === null) {
        continue;
      }
      const settings = recorded.integration_settings[speckit.integration];
      expect(settings, `integración desconocida en Spec Kit: ${speckit.integration}`).toBeDefined();
      expect(settings.invoke_separator).toBe(speckit.separator);
    }
  });
});

describe('project speckit block (1.4)', () => {
  const targets = ['claude', 'opencode', 'pi', 'cursor', 'copilot'];

  it('uses the package pin when the block is missing', async () => {
    const engine = await loadEngine();
    const effective = effectiveSpeckit({ targets }, engine);
    expect(effective).toMatchObject({
      managed: true,
      version: '1.2.3',
      excludeNewer: engine.speckit.excludeNewer,
      script: 'sh',
      defaultTarget: 'claude',
      defaultIntegration: 'claude',
      targets: ['claude', 'opencode', 'pi', 'cursor'],
      integrations: ['claude', 'opencode', 'pi', 'cursor-agent'],
    });
    expect(validateProjectSpeckit(undefined, targets, engine)).toEqual([]);
  });

  it('accepts a version inside the range and script ps', async () => {
    const engine = await loadEngine();
    expect(validateProjectSpeckit({ version: '1.2.3', script: 'ps' }, targets, engine)).toEqual([]);
    expect(effectiveSpeckit({ targets, speckit: { script: 'ps' } }, engine).script).toBe('ps');
  });

  it('rejects widening the pin and naming the range', async () => {
    const engine = await loadEngine();
    const errors = validateProjectSpeckit({ version: '1.3.0' }, targets, engine).join('\n');
    expect(errors).toContain('speckit.version');
    expect(errors).toContain('>=1.2.3 <1.3.0');
  });

  it('rejects engine-owned fields', async () => {
    const engine = await loadEngine();
    for (const field of ['extensions', 'excludeNewer', 'integrations']) {
      const errors = validateProjectSpeckit({ [field]: 'x' }, targets, engine).join('\n');
      expect(errors).toContain(`speckit.${field}`);
      expect(errors).toContain('pertenece al motor');
    }
  });

  it('rejects copilot or an undeclared default target', async () => {
    const engine = await loadEngine();
    const copilot = validateProjectSpeckit({ defaultTarget: 'copilot' }, targets, engine).join('\n');
    expect(copilot).toContain('speckit.defaultTarget');
    expect(copilot).toContain('claude, opencode, pi, cursor');
    expect(validateProjectSpeckit({ defaultTarget: 'pi' }, ['claude'], engine).join('\n')).toContain(
      'speckit.defaultTarget',
    );
  });

  it('honors defaultTarget order: default first, then manifest order', async () => {
    const engine = await loadEngine();
    const effective = effectiveSpeckit({ targets, speckit: { defaultTarget: 'pi' } }, engine);
    expect(effective.targets).toEqual(['pi', 'claude', 'opencode', 'cursor']);
    expect(effective.defaultIntegration).toBe('pi');
  });
});
