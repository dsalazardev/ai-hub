import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { createBackup } from '../backup/snapshots.js';
import { readAiHubRc, writeAiHubRc, type AiHubRc } from '../paths.js';
import { detectPreset } from '../presets/detect.js';
import { materializePreset } from '../presets/materialize.js';
import { resolvePreset, type ResolvedPreset } from '../presets/resolve.js';
import { listPresetIds } from '../presets/schema.js';
import { loadManifestContext, writeInventory, type ProjectManifest } from '../manifest/manifest.js';
import { emptyState, migrateLegacyState, readState, StateNotFoundError, writeState } from '../harness/memory/state.js';
import { runSync } from '../sync/sync.js';
import { TOOL_IDS, assertToolIds } from '../sync/targets.js';
import { sha256 } from '../sync/lock.js';
import { flagList, flagString } from './args.js';
import type { CliContext, ParsedArgs } from './types.js';

const RC_NAME = '.ai-hubrc.json';

export async function cliVersion(): Promise<string> {
  const raw = await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

export interface Plan {
  command: 'init';
  project: string;
  preset: string;
  targets: string[];
  migrate: boolean;
  write: string[];
  hash: string;
}

function projectId(root: string): string {
  const base = path.basename(path.resolve(root)).toLowerCase();
  const id = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return /^[a-z]/.test(id) ? id : `project-${id || 'root'}`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function manifestFromPreset(
  id: string,
  preset: ResolvedPreset,
  targets: string[],
  profilePackageManager: string | undefined,
  guardMode: 'shadow' | 'enforce',
  includeMcp: boolean,
): ProjectManifest {
  const rules = [...new Set(preset.rules.map((rule) => path.basename(rule, '.md')))];
  return {
    version: 2,
    project: { id, name: id },
    preset: { id: preset.id, version: preset.version, source: 'package' },
    stack: {
      ...preset.stack,
      packageManager: profilePackageManager ?? preset.stack.packageManager,
    },
    commands: preset.commands,
    paths: preset.paths,
    targets,
    policy: {
      trunk: preset.policy.trunk,
      guardMode,
      worktrees: preset.policy.worktrees,
      optOuts: preset.policy.optOuts,
      ...(preset.policy.dangerPatterns.length > 0
        ? { dangerPatterns: preset.policy.dangerPatterns }
        : {}),
    },
    skills: { source: '.ai-hub/skills', publish: preset.skills },
    agents: { source: '.ai-hub/agents', publish: preset.agents },
    rules: { source: '.ai-hub/rules', publish: rules },
    ...(includeMcp ? { mcp: { source: preset.mcp.source } } : {}),
  };
}

export async function writeManifest(root: string, manifest: ProjectManifest): Promise<void> {
  await fs.writeFile(path.join(root, 'manifest.yaml'), stringify(manifest), 'utf8');
}

async function ensureProjectIgnores(root: string): Promise<void> {
  const file = path.join(root, '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  if (!current.split(/\r?\n/).includes('.worktrees/')) {
    const next = current === '' ? '.worktrees/\n' : `${current.replace(/\s*$/, '')}\n.worktrees/\n`;
    await fs.writeFile(file, next, 'utf8');
  }
}

async function installPostMergeHook(root: string): Promise<{ installed: boolean; reason: string }> {
  if (!(await exists(path.join(root, '.git')))) {
    return { installed: false, reason: 'not a git repository' };
  }
  const hook = path.join(root, '.git', 'hooks', 'post-merge');
  if (await exists(hook)) {
    return { installed: false, reason: 'a post-merge hook already exists; chain ai-hub manually' };
  }
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(
    hook,
    '#!/bin/sh\n# ai-hub managed worktree cleanup\nnpx --no-install ai-hub worktrees reap --auto >/dev/null 2>&1 || true\n',
    'utf8',
  );
  await fs.chmod(hook, 0o755);
  return { installed: true, reason: 'installed' };
}

async function resolveSelection(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<{ preset: ResolvedPreset; profilePackageManager?: string; targets: string[]; migrate: boolean }> {
  const rc = readAiHubRc(ctx.cwd);
  const explicit = flagString(args, 'preset') ?? rc?.preset;
  const detected = await detectPreset(ctx.root);
  if (!explicit && detected.ambiguous.length > 0) {
    throw new Error(
      `detección ambigua entre ${detected.ambiguous.join(', ')}; elige con --preset <id>`,
    );
  }
  const presetId = explicit ?? detected.id;
  const preset = await resolvePreset(presetId);
  const requested = flagList(args, 'targets');
  const targets =
    requested.length > 0
      ? assertToolIds(requested)
      : rc?.targets && rc.targets.length > 0
        ? assertToolIds(rc.targets)
        : [...TOOL_IDS];
  return {
    preset,
    profilePackageManager: detected.profile.packageManagers[0],
    targets,
    migrate: Boolean(args.flags.migrate),
  };
}

export async function cmdInit(args: ParsedArgs, ctx: CliContext): Promise<number> {
  let selection;
  try {
    selection = await resolveSelection(args, ctx);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  const id = projectId(ctx.cwd);
  const rc: AiHubRc = {
    version: 2,
    dir: '.',
    preset: selection.preset.id,
    targets: selection.targets,
    guardMode: 'shadow',
  };
  const write: string[] = [RC_NAME, 'manifest.yaml', '.ai-hub/'];
  if (selection.migrate) {
    write.push('.planning/state.json');
  }
  const planBody: Omit<Plan, 'hash'> = {
    command: 'init',
    project: id,
    preset: selection.preset.id,
    targets: selection.targets,
    migrate: selection.migrate,
    write,
  };
  const plan: Plan = { ...planBody, hash: sha256(JSON.stringify(planBody)) };

  if (!args.flags.yes || args.flags['dry-run']) {
    ctx.io.out(JSON.stringify(plan, null, 2));
    if (!args.flags['dry-run']) {
      ctx.io.out('Nada escrito. Repite con --yes para aplicar este plan.');
    }
    return 0;
  }

  if (await exists(path.join(ctx.root, 'manifest.yaml'))) {
    await createBackup(ctx.root, 'init');
  }
  const materialized = await materializePreset(
    ctx.root,
    selection.preset,
  );
  const includeMcp = await exists(path.join(ctx.root, selection.preset.mcp.source));
  const manifest = manifestFromPreset(
    id,
    selection.preset,
    selection.targets,
    selection.profilePackageManager,
    rc.guardMode ?? 'shadow',
    includeMcp,
  );
  await writeManifest(ctx.root, manifest);
  await writeInventory(ctx.root);
  const existingRc = readAiHubRc(ctx.cwd);
  if (!existingRc || existingRc.version === 1 || args.flags.force) {
    writeAiHubRc(ctx.cwd, rc);
  }
  try {
    await readState(ctx.root);
  } catch (error) {
    if (error instanceof StateNotFoundError) {
      await writeState(ctx.root, emptyState(id, selection.preset.id));
    } else {
      throw error;
    }
  }
  if (selection.migrate) {
    await migrateLegacyState(ctx.root, id, selection.preset.id);
  }
  await ensureProjectIgnores(ctx.root);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `init: ${selection.preset.id} · ${selection.targets.join(', ')} · ${materialized.written.length} archivos nuevos, ${materialized.kept.length} conservados, ${materialized.collisions.length} colisiones`,
  );
  if (materialized.collisions.length > 0) {
    ctx.io.err(`colisiones (no se sobrescribieron): ${materialized.collisions.join(', ')}`);
  }
  ctx.io.out(`plan: ${plan.hash}`);
  return 0;
}

export async function cmdInstall(args: ParsedArgs, ctx: CliContext): Promise<number> {
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  if (args.flags['dry-run']) {
    ctx.io.out(
      JSON.stringify(
        {
          dryRun: true,
          action: 'install',
          preset: context.preset.id,
          targets: context.manifest.targets,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const materialized = await materializePreset(ctx.root, context.preset);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  await ensureProjectIgnores(ctx.root);
  if (args.flags.hooks) {
    const hook = await installPostMergeHook(ctx.root);
    ctx.io.out(`hooks: ${hook.installed ? 'post-merge instalado' : hook.reason}`);
  }
  ctx.io.out(
    `install: ${materialized.written.length} nuevos · ${materialized.kept.length} conservados · ${sync.written.length} sincronizados`,
  );
  return 0;
}

export async function cmdRepair(args: ParsedArgs, ctx: CliContext): Promise<number> {
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  if (args.flags['dry-run']) {
    ctx.io.out(
      JSON.stringify(
        {
          dryRun: true,
          action: 'repair',
          preset: context.preset.id,
          targets: context.manifest.targets,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const materialized = await materializePreset(ctx.root, context.preset);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  ctx.io.out(`repair: ${materialized.written.length} scaffold · ${sync.written.length} archivos · ${sync.removed.length} eliminados`);
  return 0;
}

export async function availablePresets(): Promise<string[]> {
  return listPresetIds();
}
