import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAiHubRc } from '../paths.js';
import { ENGINE_COUNTS, ENGINE_LANES, ENGINE_SKILLS_DIR } from '../engine/engine.js';
import { scanCoupling, scanLegacyArtifacts } from '../engine/gates.js';
import {
  checkInventory,
  loadManifestContext,
  type ProjectManifest,
} from '../manifest/manifest.js';
import type { EngineManifest } from '../engine/engine.js';
import { checkLock, runSync } from '../sync/sync.js';
import { CONTEXT_RELATIVE, contextHash } from './context.js';
import { TARGETS, TOOL_IDS, isToolId } from '../sync/targets.js';
import { sourceCheckout } from './source.js';
import type { CliContext } from './types.js';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  root: string;
  source: string;
  checks: DoctorCheck[];
  ok: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COUPLING_FILE = path.join(__dirname, '..', '..', 'engine', 'coupling.json');

interface CouplingRules {
  terms: string[];
  legacySkillPrefix: string;
}

async function couplingRules(): Promise<CouplingRules> {
  const raw = await fs.readFile(COUPLING_FILE, 'utf8').catch(() => '{"terms":[],"legacySkillPrefix":""}');
  const parsed = JSON.parse(raw) as { terms?: unknown; legacySkillPrefix?: unknown };
  return {
    terms:
      Array.isArray(parsed.terms) && parsed.terms.every((term) => typeof term === 'string')
        ? (parsed.terms as string[])
        : [],
    legacySkillPrefix:
      typeof parsed.legacySkillPrefix === 'string' ? parsed.legacySkillPrefix : '',
  };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function diagnose(ctx: CliContext): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const source = await sourceCheckout(ctx.root);

  let manifest: ProjectManifest | null = null;
  let engine: EngineManifest | null = null;
  try {
    const context = await loadManifestContext(ctx.root);
    manifest = context.manifest;
    engine = context.engine;
    add('manifest', true, `manifest.yaml válido (proyecto ${manifest.project.id})`);
  } catch (error) {
    add('manifest', false, error instanceof Error ? error.message : String(error));
  }

  if (manifest && engine) {
    add('preset', true, `${manifest.preset.id}@${manifest.preset.version} (${manifest.preset.source})`);
    add(
      'engine:roles',
      engine.roles.length === ENGINE_COUNTS.roles,
      `${engine.roles.length}/${ENGINE_COUNTS.roles}`,
    );
    add(
      'engine:commands',
      engine.commands.length === ENGINE_COUNTS.commands,
      `${engine.commands.length}/${ENGINE_COUNTS.commands}`,
    );
    add(
      'engine:labels',
      engine.labels.length === ENGINE_COUNTS.labels,
      `${engine.labels.length}/${ENGINE_COUNTS.labels}`,
    );
    for (const [lane, expected] of Object.entries(ENGINE_LANES)) {
      const actual = engine.commands.filter((command) => command.lane === lane).length;
      add(`lane:${lane}`, actual === expected, `${actual}/${expected}`);
    }

    const unknownTargets = manifest.targets.filter((target) => !isToolId(target));
    add(
      'targets:declared',
      unknownTargets.length === 0,
      unknownTargets.length === 0
        ? manifest.targets.join(', ')
        : `desconocidos: ${unknownTargets.join(', ')}`,
    );
    add(
      'targets:registry',
      TOOL_IDS.length >= 5,
      `${TOOL_IDS.length} destinos disponibles (${TOOL_IDS.join(', ')})`,
    );
    add('policy:trunk', true, manifest.policy.trunk);
    add('policy:guardMode', true, manifest.policy.guardMode);
    add(
      'policy:optOuts',
      true,
      manifest.policy.optOuts.length === 0
        ? 'ninguno'
        : `opt-outs activos: ${manifest.policy.optOuts.join(', ')}`,
    );

    const missingSkills: string[] = [];
    for (const command of engine.commands) {
      if (!(await exists(path.join(ENGINE_SKILLS_DIR, command.skill, 'SKILL.md')))) {
        missingSkills.push(`${command.id} -> ${command.skill}`);
      }
    }
    for (const skill of manifest.skills.publish) {
      if (!(await exists(path.join(ctx.root, manifest.skills.source, skill, 'SKILL.md')))) {
        missingSkills.push(`${skill} -> ${manifest.skills.source}`);
      }
    }
    add(
      'skills',
      missingSkills.length === 0,
      missingSkills.length === 0 ? '17 skills nativas + extras' : missingSkills.join(', '),
    );

    if (source.isSource) {
      const required = ['dist', 'schema', 'manifest.json', 'engine', 'presets', 'agents', 'skills'];
      const missing = required.filter((entry) => !source.files.includes(entry));
      add(
        'package:files',
        missing.length === 0,
        missing.length === 0 ? required.join(', ') : `faltan: ${missing.join(', ')}`,
      );
      add(
        'package:entry',
        await exists(path.join(ctx.root, 'core', 'dist', 'bin', 'ai-hub.js')),
        'core/dist/bin/ai-hub.js',
      );
      add(
        'engine:source-layout',
        (await exists(path.join(ctx.root, 'core', 'agents'))) &&
          (await exists(path.join(ctx.root, 'core', 'presets'))) &&
          (await exists(path.join(ctx.root, 'core', 'skills', 'shared'))),
        'core/agents + core/presets + core/skills',
      );
    } else {
      const missingHooks: string[] = [];
      for (const target of manifest.targets) {
        if (!isToolId(target)) {
          continue;
        }
        const hook = TARGETS[target].hook;
        if (!(await exists(path.join(ctx.root, hook)))) {
          missingHooks.push(hook);
        }
      }
      add('hooks', missingHooks.length === 0, missingHooks.length === 0 ? 'superficies presentes' : missingHooks.join(', '));
    }

    const legacy = await scanLegacyArtifacts(ctx.root);
    add(
      'engine:no-legacy-prefix',
      legacy.length === 0,
      legacy.length === 0
        ? source.isSource
          ? 'sin artefactos OpenSpec en el catálogo publicado'
          : 'sin artefactos OpenSpec en catálogo y destinos'
        : legacy.slice(0, 5).join('; '),
    );

    try {
      const inventory = await checkInventory(ctx.root);
      add(
        'inventory',
        inventory.ok,
        inventory.ok ? 'manifest.json actualizado' : 'manifest.json desactualizado; ejecuta npm run manifest:build',
      );
    } catch (error) {
      add('inventory', false, error instanceof Error ? error.message : String(error));
    }

    if (source.isSource) {
      try {
        const content = await fs.readFile(path.join(ctx.root, CONTEXT_RELATIVE), 'utf8').catch(() => null);
        if (content === null) {
          add('context', false, `${CONTEXT_RELATIVE} no existe; ejecuta ai-hub context`);
        } else {
          const match = /<!-- context-hash: ([a-f0-9]{64}) -->/.exec(content);
          if (match === null) {
            add('context', false, 'falta <!-- context-hash -->; ejecuta ai-hub context');
          } else {
            const expected = await contextHash(ctx.root);
            add(
              'context',
              match[1] === expected,
              match[1] === expected ? 'contexto fresco' : 'contexto desactualizado; ejecuta ai-hub context',
            );
          }
        }
      } catch (error) {
        add('context', false, error instanceof Error ? error.message : String(error));
      }
    } else {
      add('context', true, 'no aplica en instalación');
    }

    if (source.isSource) {
      add('lock', true, 'no aplica en el checkout del motor');
      add('drift', true, 'no aplica en el checkout del motor');
    } else {
      try {
        const result = await checkLock(ctx.root);
        add(
          'lock',
          result.ok,
          result.ok
            ? `versión 2, ${result.actualCount} destinos, sources OK`
            : `esperados ${result.expectedCount} / actuales ${result.actualCount}; faltan ${result.missing.length}, sobran ${result.extra.length}, difieren ${result.different.length}, sources inválidas ${result.invalidSources.length}${result.error !== null ? `; ${result.error}` : ''}`,
        );
      } catch (error) {
        add('lock', false, error instanceof Error ? error.message : String(error));
      }

      try {
        const result = await runSync(ctx.root, { check: true });
        const count = (prefix: string): number =>
          result.problems.filter((problem) => problem.startsWith(prefix)).length;
        add(
          'drift',
          result.problems.length === 0,
          `faltan ${count('falta ')} · desactualizados ${count('desactualizado: ')} · editados ${count('editado a mano: ')} · obsoletos ${count('destino obsoleto: ')}`,
        );
      } catch (error) {
        add('drift', false, error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (!source.isSource) {
    try {
      const rc = readAiHubRc(ctx.root);
      add('rc', true, rc === null ? '.ai-hubrc.json opcional, no presente' : `v${rc.version} dir=${rc.dir ?? '.'} preset=${rc.preset ?? '-'}`);
    } catch (error) {
      add('rc', false, error instanceof Error ? error.message : String(error));
    }
  }

  if (await exists(path.join(ctx.root, '.git'))) {
    const ignore = await fs.readFile(path.join(ctx.root, '.gitignore'), 'utf8').catch(() => '');
    const ignored = ignore.split(/\r?\n/).includes('.worktrees/');
    add(
      'worktrees:ignored',
      ignored,
      ignored ? '.worktrees/ ignorado' : 'añade .worktrees/ a .gitignore',
    );
  }

  const coupling = await couplingRules();
  if (source.isSource) {
    const findings = await scanCoupling(ctx.root, coupling.terms);
    add(
      'engine:no-coupling',
      findings.length === 0,
      findings.length === 0
        ? 'sin términos de dominio en el motor'
        : findings.slice(0, 5).join('; '),
    );
  }

  const sharedSkills = path.join(ctx.root, 'core', 'skills', 'shared');
  if (await exists(sharedSkills)) {
    const entries = await fs.readdir(sharedSkills).catch(() => []);
    const legacy =
      coupling.legacySkillPrefix === ''
        ? []
        : entries.filter((entry) => entry.startsWith(coupling.legacySkillPrefix));
    add(
      'engine:no-legacy-skills',
      legacy.length === 0,
      legacy.length === 0 ? 'sin skills de la metodología anterior' : legacy.join(', '),
    );
  }

  return {
    root: ctx.root,
    source: ctx.source ?? 'none',
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export function printReport(report: DoctorReport, ctx: CliContext): void {
  ctx.io.out(`ai-hub doctor — ${report.root} (fuente: ${report.source})`);
  for (const check of report.checks) {
    ctx.io.out(`${check.ok ? '[OK]  ' : '[FAIL]'} ${check.id}: ${check.detail}`);
  }
  ctx.io.out(report.ok ? 'Resultado: sano' : 'Resultado: hay comprobaciones fallidas');
}
