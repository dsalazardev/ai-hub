import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup, listBackups, purgeGenerated, restoreBackup } from '../backup/snapshots.js';
import { readAiHubRc } from '../paths.js';
import { loadManifestContext, writeInventory, type ProjectManifest } from '../manifest/manifest.js';
import { findPresetAsset } from '../presets/resolve.js';
import {
  ENGINE_AGENTS,
  materializeAgent,
  materializeSkill,
  removeOwned,
  SCAFFOLD_RELATIVE,
} from '../presets/materialize.js';
import { ENGINE_SKILLS_DIR } from '../engine/engine.js';
import { catalogIndex, catalogSeal, hasFullDimension } from '../catalog.js';
import { readLock } from '../sync/lock.js';
import { runSync } from '../sync/sync.js';
import { cliVersion, cmdInstall, writeManifest } from './onboarding.js';
import { splitItem } from './items.js';
import type { CliContext, ParsedArgs } from './types.js';

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Nombres del espacio de Spec Kit: sus comandos no se añaden ni se desinstalan desde ai-hub. */
function isSpeckitCommandName(id: string): boolean {
  return id.startsWith('speckit-') || id.startsWith('speckit.');
}

function markCustom(manifest: ProjectManifest, dimension: 'skills' | 'agents' | 'rules'): void {
  manifest[dimension].selection = 'custom';
  if (hasFullDimension(manifest)) {
    manifest.catalog = catalogSeal(manifest);
  } else {
    delete manifest.catalog;
  }
}

export async function cmdList(args: ParsedArgs, ctx: CliContext): Promise<number> {
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  const { manifest, engine, preset } = context;
  const mode = manifest.skills.selection ?? 'preset';
  const data = {
    project: manifest.project,
    preset: { id: preset.id, version: preset.version, chain: preset.chain },
    targets: manifest.targets,
    selection: {
      skills: manifest.skills.selection ?? 'preset',
      agents: manifest.agents.selection ?? 'preset',
      rules: manifest.rules.selection ?? 'preset',
    },
    commands: engine.commands.map((command) => ({ id: command.id, lane: command.lane, role: command.role })),
    speckitCommands: engine.commands.map((command) => command.speckit),
    skills: manifest.skills.publish,
    agents: manifest.agents.publish,
    rules: manifest.rules.publish,
  };
  if (args.flags.json) {
    ctx.io.out(JSON.stringify(data, null, 2));
    return 0;
  }
  ctx.io.out(`project: ${manifest.project.id} (${manifest.project.name})`);
  ctx.io.out(`preset: ${preset.id}@${preset.version} [${preset.chain.join(' -> ')}]`);
  ctx.io.out(`targets: ${manifest.targets.join(', ')}`);
  ctx.io.out(
    `selection: skills=${data.selection.skills} agents=${data.selection.agents} rules=${data.selection.rules}`,
  );
  ctx.io.out(`commands (${data.commands.length}): ${data.commands.map((command) => command.id).join(', ')}`);
  ctx.io.out(`skills: ${data.skills.length} de proyecto (${mode}) + ${data.speckitCommands.length} comandos Spec Kit`);
  ctx.io.out(`agents (${data.agents.length}): ${data.agents.join(', ')}`);
  ctx.io.out(
    `rules: ${data.rules.length + 1} universales (${data.rules.length} materializadas + preflight)`,
  );
  return 0;
}

export async function cmdAdd(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const parsed = splitItem(args);
  if (!parsed.id) {
    ctx.io.err('uso: ai-hub add <skill|agent> <id>');
    return 2;
  }
  if (parsed.kind === 'rule') {
    ctx.io.err('las reglas universales se seleccionan con --exclude rule:<id> en init; no se añaden con add');
    return 2;
  }
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  const { manifest, preset } = context;
  const id = parsed.id;
  if (isSpeckitCommandName(id)) {
    ctx.io.err(`"${id}" lo provee Spec Kit; ai-hub no añade ni desinstala sus comandos`);
    return 1;
  }
  const catalogSkill = (await catalogIndex()).skills.includes(id);
  const catalogAgent = await exists(path.join(ENGINE_AGENTS, `${id}.md`));
  const kind =
    parsed.kind ??
    (preset.skills.includes(id) || catalogSkill
      ? 'skill'
      : catalogAgent || preset.agents.includes(id)
        ? 'agent'
        : null);
  if (kind === null) {
    ctx.io.err(`no existe "${id}" en el preset ${preset.id} ni en el catálogo del motor`);
    return 1;
  }

  if (kind === 'skill') {
    const fromPreset = preset.skills.includes(id)
      ? await findPresetAsset(preset.chain, `skills/${id}`)
      : null;
    if (fromPreset === null && !catalogSkill) {
      // Una skill con `runtime: false` sigue en el paquete pero no es instalable.
      ctx.io.err(`la skill "${id}" no pertenece al catálogo instalable (no existe o declara runtime: false)`);
      return 1;
    }
    const source = fromPreset ?? path.join(ENGINE_SKILLS_DIR, id);
    if (!(await exists(path.join(source, 'SKILL.md')))) {
      ctx.io.err(`no existe la skill "${id}" en ${preset.id} ni en el catálogo del motor`);
      return 1;
    }
    const destination = path.join(ctx.root, manifest.skills.source, id);
    if (args.flags['dry-run']) {
      ctx.io.out(JSON.stringify({ dryRun: true, action: 'add', kind, id, destination }, null, 2));
      return 0;
    }
    await materializeSkill(
      ctx.root,
      id,
      source,
      fromPreset ? `@preset/${preset.id}/skills/${id}` : `@engine/skills/shared/${id}`,
    );
    manifest.skills.publish = [...new Set([...manifest.skills.publish, id])];
  } else {
    const fromPreset = await findPresetAsset(preset.chain, `agents/${id}.md`);
    const source = fromPreset ?? path.join(ENGINE_AGENTS, `${id}.md`);
    if (!(await exists(source))) {
      ctx.io.err(`no existe el agente "${id}" en el catálogo ${ENGINE_AGENTS}`);
      return 1;
    }
    const destination = path.join(ctx.root, manifest.agents.source, `${id}.md`);
    if (args.flags['dry-run']) {
      ctx.io.out(JSON.stringify({ dryRun: true, action: 'add', kind, id, destination }, null, 2));
      return 0;
    }
    await materializeAgent(
      ctx.root,
      id,
      source,
      fromPreset ? `@preset/${preset.id}/agents/${id}.md` : `@engine/agents/${id}.md`,
    );
    manifest.agents.publish = [...new Set([...manifest.agents.publish, id])];
  }

  markCustom(manifest, kind === 'agent' ? 'agents' : 'skills');
  await writeManifest(ctx.root, manifest);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  ctx.io.out(`add: ${kind} "${id}" · ${sync.written.length} archivos sincronizados`);
  return 0;
}

export async function cmdUninstall(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const parsed = splitItem(args);
  if (!parsed.id) {
    ctx.io.err('uso: ai-hub uninstall <skill|agent|rule> <id>');
    return 2;
  }
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  const { manifest } = context;
  const id = parsed.id;
  const kind =
    parsed.kind ??
    (manifest.skills.publish.includes(id)
      ? 'skill'
      : manifest.agents.publish.includes(id)
        ? 'agent'
        : manifest.rules.publish.includes(id) || id === 'skill-quality'
          ? 'rule'
          : 'agent');
  if (isSpeckitCommandName(id)) {
    ctx.io.err(`"${id}" lo provee Spec Kit; ai-hub no añade ni desinstala sus comandos`);
    return 1;
  }
  if (kind === 'rule' && (id === 'core' || id === 'preflight')) {
    ctx.io.err(`la regla base "${id}" no se puede desinstalar`);
    return 1;
  }
  if (args.flags['dry-run']) {
    ctx.io.out(JSON.stringify({ dryRun: true, action: 'uninstall', kind, id }, null, 2));
    return 0;
  }
  await createBackup(ctx.root, 'uninstall');
  if (kind === 'skill') {
    manifest.skills.publish = manifest.skills.publish.filter((skill) => skill !== id);
    await removeOwned(ctx.root, path.join(manifest.skills.source, id), true);
    markCustom(manifest, 'skills');
  } else if (kind === 'agent') {
    manifest.agents.publish = manifest.agents.publish.filter((agent) => agent !== id);
    await removeOwned(ctx.root, path.join(manifest.agents.source, `${id}.md`), false);
    markCustom(manifest, 'agents');
  } else {
    const removed =
      id === 'skill-quality'
        ? manifest.rules.publish.filter((rule) => rule.startsWith('skill-quality/'))
        : manifest.rules.publish.filter((rule) => rule === id);
    manifest.rules.publish = manifest.rules.publish.filter((rule) => !removed.includes(rule));
    for (const rule of removed) {
      await removeOwned(ctx.root, path.join(manifest.rules.source, `${rule}.md`), false);
    }
    markCustom(manifest, 'rules');
  }
  await writeManifest(ctx.root, manifest);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  ctx.io.out(`uninstall: ${kind} "${id}" · ${sync.removed.length} archivos eliminados`);
  return 0;
}

export async function cmdBackups(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const snapshots = await listBackups(ctx.root);
  if (args.flags.json) {
    ctx.io.out(JSON.stringify(snapshots, null, 2));
    return 0;
  }
  if (snapshots.length === 0) {
    ctx.io.out('no hay snapshots');
    return 0;
  }
  for (const snapshot of snapshots) {
    ctx.io.out(`${snapshot.id} · ${snapshot.reason} · ${snapshot.files.length} archivos`);
  }
  return 0;
}

export async function cmdRestore(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    ctx.io.err('uso: ai-hub restore <snapshot>');
    return 2;
  }
  if (args.flags['dry-run']) {
    const snapshot = (await listBackups(ctx.root)).find((record) => record.id === id);
    if (!snapshot) {
      ctx.io.err(`snapshot no encontrado: ${id}`);
      return 1;
    }
    ctx.io.out(JSON.stringify({ dryRun: true, action: 'restore', id, files: snapshot.files }, null, 2));
    return 0;
  }
  try {
    const result = await restoreBackup(ctx.root, id);
    ctx.io.out(`restore: ${result.restored.length} archivos restaurados desde ${id}`);
    return 0;
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
}

export async function cmdPurge(args: ParsedArgs, ctx: CliContext): Promise<number> {
  if (args.flags['dry-run']) {
    const lock = await readLock(ctx.root);
    ctx.io.out(
      JSON.stringify(
        { dryRun: true, action: 'purge', generated: Object.keys(lock?.files ?? {}).length },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!args.flags.yes && !args.flags.confirm) {
    ctx.io.err('purge elimina el arnés; repite con --yes (antes crea un snapshot)');
    return 1;
  }
  const result = await purgeGenerated(ctx.root, true);
  for (const rel of ['.ai-hub', 'manifest.yaml', '.planning/state.json', '.planning/memory.jsonl', SCAFFOLD_RELATIVE]) {
    await fs.rm(path.join(ctx.root, rel), { recursive: true, force: true });
  }
  const rc = readAiHubRc(ctx.root);
  if (rc) {
    await fs.rm(path.join(ctx.root, '.ai-hubrc.json'), { force: true });
  }
  ctx.io.out(
    `purge: ${result.removed.length} archivos generados; snapshot ${result.backup?.id ?? 'no creado'}`,
  );
  return 0;
}

export async function cmdUpgrade(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const version = await cliVersion();
  ctx.io.out(`ai-hub ${version}`);
  if (args.flags['dry-run']) {
    ctx.io.out(JSON.stringify({ dryRun: true, action: 'upgrade', version }, null, 2));
    return 0;
  }
  if (args.flags.install) {
    const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: ctx.root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      ctx.io.err('npm install falló; revisa la salida anterior');
      return 1;
    }
  }
  let context;
  try {
    context = await loadManifestContext(ctx.root);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  const refreshFull =
    Boolean(args.flags.full) ||
    (hasFullDimension(context.manifest) && !args.flags['preset-only']);
  if (refreshFull) {
    const code = await cmdInstall(
      {
        positionals: [],
        flags: args.flags.full ? { full: true } : {},
      },
      ctx,
    );
    if (code === 0) {
      ctx.io.out('upgrade: dimensiones full actualizadas y sello refrescado');
    }
    return code;
  }
  const result = await runSync(ctx.root, { check: false });
  ctx.io.out(`upgrade: ${result.written.length} archivos regenerados`);
  return 0;
}
