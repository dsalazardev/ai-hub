#!/usr/bin/env node
// Regenera los artefactos de OpenSpec en una copia temporal y trae a la fuente
// solo lo que pertenece a las herramientas configuradas (ver ai-openspec-upgrade).
import { mkdtemp, cp, readdir, rm, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = 'claude,opencode,cursor,github-copilot';
const SHARED_SKILLS = path.join(ROOT, '.ai-hub', 'skills', 'shared');
const MANIFEST = path.join(ROOT, '.ai-hub', 'manifest.yaml');
const SYNC_CLI = path.join(ROOT, '.ai-hub', 'core', 'dist', 'bin', 'ai-hub.js');
const OPENSPEC_BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} terminó con código ${result.status ?? 'desconocido'}`);
  }
}

async function exists(p) {
  return access(p).then(() => true, () => false);
}

async function listDir(dir) {
  return (await exists(dir)) ? readdir(dir, { withFileTypes: true }) : [];
}

// Las cuatro herramientas leen la misma copia de .claude/skills, pero Claude
// nombra los comandos /opsx:x y el resto /opsx-x. El lookahead obliga a consumir
// el nombre completo para que una segunda pasada no recorte "apply" a "appl".
const COMMAND = /(?<!\(o )\/opsx[:-]([a-z][a-z-]*)(?![a-z-])(?! \(o \/opsx-)/g;

export function neutralizeCommands(text) {
  return text.replace(COMMAND, (_, name) => `/opsx:${name} (o /opsx-${name} fuera de Claude Code)`);
}

async function neutralizeSkill(dir) {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(entry.parentPath, entry.name);
    await writeFile(file, neutralizeCommands(await readFile(file, 'utf8')), 'utf8');
  }
}

async function importSkills(temp) {
  const generated = path.join(temp, '.claude', 'skills');
  const imported = [];
  for (const entry of await listDir(generated)) {
    if (!entry.isDirectory() || !entry.name.startsWith('openspec-')) continue;
    const dest = path.join(SHARED_SKILLS, entry.name);
    await rm(dest, { recursive: true, force: true });
    await cp(path.join(generated, entry.name), dest, { recursive: true });
    await neutralizeSkill(dest);
    imported.push(entry.name);
  }
  return imported;
}

async function importCommands(temp) {
  const copies = [
    { from: path.join('.opencode', 'commands'), to: path.join('.opencode', 'commands'), filter: /^opsx-.*\.md$/ },
    { from: path.join('.cursor', 'commands'), to: path.join('.cursor', 'commands'), filter: /^opsx-.*\.md$/ },
    { from: path.join('.github', 'prompts'), to: path.join('.github', 'prompts'), filter: /^opsx-.*\.prompt\.md$/ },
  ];
  let count = 0;
  for (const { from, to, filter } of copies) {
    for (const entry of await listDir(path.join(temp, from))) {
      if (!entry.isFile()) continue;
      if (filter && !filter.test(entry.name)) continue;
      await mkdir(path.join(ROOT, to), { recursive: true });
      await cp(path.join(temp, from, entry.name), path.join(ROOT, to, entry.name));
      count += 1;
    }
  }
  if (await exists(path.join(temp, '.claude', 'commands', 'opsx'))) {
    await rm(path.join(ROOT, '.claude', 'commands', 'opsx'), { recursive: true, force: true });
    await cp(path.join(temp, '.claude', 'commands', 'opsx'), path.join(ROOT, '.claude', 'commands', 'opsx'), { recursive: true });
  }
  return count;
}

async function unpublishedSkills(names) {
  const manifest = await readFile(MANIFEST, 'utf8');
  return names.filter((name) => !new RegExp(`^\\s+- ${name}\\s*$`, 'm').test(manifest));
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'openspec-upgrade-'));
  try {
    console.log(`[INFO]  Generando OpenSpec en una copia temporal para: ${TOOLS}`);
    run(OPENSPEC_BIN, ['init', '--tools', TOOLS], { cwd: temp });

    const skills = await importSkills(temp);
    const commands = await importCommands(temp);
    console.log(`[OK]    Skills openspec-* actualizadas: ${skills.length}`);
    console.log(`[OK]    Comandos /opsx copiados: ${commands}`);

    const pending = await unpublishedSkills(skills);
    for (const name of pending) {
      console.log(`[WARN]  Skill nueva sin publicar: ${name}. Añádela a sync.skills.publish en .ai-hub/manifest.yaml`);
    }

    if (!(await exists(SYNC_CLI))) {
      console.log('[WARN]  Falta .ai-hub/core/dist: ejecuta npm run ai:setup y después npm run ai:sync');
      return;
    }
    run(process.execPath, [SYNC_CLI, 'sync'], { cwd: ROOT });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FAIL]  ${error.message}`);
    process.exit(1);
  });
}
