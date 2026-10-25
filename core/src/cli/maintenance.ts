import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup, listBackups, purgeGenerated, restoreBackup } from '../backup/snapshots.js';
import { readAiHubRc } from '../paths.js';
import { loadManifestContext, writeInventory } from '../manifest/manifest.js';
import { findPresetAsset } from '../presets/resolve.js';
import { ENGINE_AGENTS, readScaffold, SCAFFOLD_RELATIVE } from '../presets/materialize.js';
import { ENGINE_SKILLS_DIR } from '../engine/engine.js';
import { readLock } from '../sync/lock.js';
import { runSync } from '../sync/sync.js';
import { cliVersion, writeManifest } from './onboarding.js';
import { splitItem } from './items.js';
import type { CliContext, ParsedArgs } from './types.js';

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
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
  const data = {
    project: manifest.project,
    preset: { id: preset.id, version: preset.version, chain: preset.chain },
    targets: manifest.targets,
    commands: engine.commands.map((command) => ({ id: command.id, lane: command.lane, role: command.role })),
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
  ctx.io.out(`commands (${data.commands.length}): ${data.commands.map((command) => command.id).join(', ')}`);
  ctx.io.out(`skills (${data.skills.length}): ${data.skills.join(', ') || 'solo las 17 del motor'}`);
  ctx.io.out(`agents (${data.agents.length}): ${data.agents.join(', ')}`);
  ctx.io.out(`rules (${data.rules.length}): ${data.rules.join(', ')}`);
  return 0;
}

export async function cmdAdd(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const parsed = splitItem(args);
  if (!parsed.id) {
    ctx.io.err('uso: ai-hub add <skill|agent> <id>');
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
  const engineSkill = context.engine.commands.some((command) => command.skill === id);
  const catalogSkill = await exists(path.join(ENGINE_SKILLS_DIR, id, 'SKILL.md'));
  const kind =
    parsed.kind ??
    (preset.skills.includes(id) || engineSkill || catalogSkill ? 'skill' : 'agent');

  if (kind === 'skill') {
    if (engineSkill) {
      ctx.io.out(`"${id}" ya forma parte de las 17 skills del motor`);
      return 0;
    }
    const fromPreset = preset.skills.includes(id)
      ? await findPresetAsset(preset.chain, `skills/${id}`)
      : null;
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
    if (!(await exists(destination))) {
      await fs.cp(source, destination, { recursive: true });
    }
    manifest.skills.publish = [...new Set([...manifest.skills.publish, id])];
  } else {
    if (!preset.agents.includes(id)) {
      ctx.io.err(`el agente "${id}" no pertenece al preset ${preset.id}`);
      return 1;
    }
    const fromPreset = await findPresetAsset(preset.chain, `agents/${id}.md`);
    const source = fromPreset ?? path.join(ENGINE_AGENTS, `${id}.md`);
    const destination = path.join(ctx.root, manifest.agents.source, `${id}.md`);
    if (args.flags['dry-run']) {
      ctx.io.out(JSON.stringify({ dryRun: true, action: 'add', kind, id, destination }, null, 2));
      return 0;
    }
    if (!(await exists(destination))) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
    manifest.agents.publish = [...new Set([...manifest.agents.publish, id])];
  }

  await writeManifest(ctx.root, manifest);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  ctx.io.out(`add: ${kind} "${id}" · ${sync.written.length} archivos sincronizados`);
  return 0;
}

export async function cmdUninstall(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const parsed = splitItem(args);
  if (!parsed.id) {
    ctx.io.err('uso: ai-hub uninstall <skill|agent> <id>');
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
  const kind = parsed.kind ?? (manifest.skills.publish.includes(id) ? 'skill' : 'agent');
  if (kind === 'skill' && context.engine.commands.some((command) => command.skill === id)) {
    ctx.io.err(`"${id}" es una skill del motor y no se puede desinstalar`);
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
  } else {
    manifest.agents.publish = manifest.agents.publish.filter((agent) => agent !== id);
    await removeOwned(ctx.root, path.join(manifest.agents.source, `${id}.md`), false);
  }
  await writeManifest(ctx.root, manifest);
  const sync = await runSync(ctx.root, { check: false });
  await writeInventory(ctx.root);
  ctx.io.out(`uninstall: ${kind} "${id}" · ${sync.removed.length} archivos eliminados`);
  return 0;
}

async function removeOwned(root: string, relative: string, directory: boolean): Promise<void> {
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) {
    return;
  }
  const record = await readScaffold(root);
  if (directory) {
    const files = record.files;
    const prefix = `${relative.split(path.sep).join('/')}/`;
    const owned = Object.entries(files).filter(([name]) => name.startsWith(prefix));
    if (owned.length === 0) {
      const marker = await fs.readFile(path.join(absolute, 'SKILL.md'), 'utf8').catch(() => '');
      if (!marker.includes('GENERADO por ai-hub')) {
        return;
      }
    }
    await fs.rm(absolute, { recursive: true, force: true });
    return;
  }
  const text = await fs.readFile(absolute, 'utf8').catch(() => null);
  if (text === null || text.includes('GENERADO por ai-hub')) {
    await fs.rm(absolute, { force: true });
  }
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
  const result = await runSync(ctx.root, { check: false });
  ctx.io.out(`upgrade: ${result.written.length} archivos regenerados`);
  return 0;
}
