import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../sync/lock.js';
import { findPresetAsset, type ResolvedPreset } from './resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_AGENTS = path.join(__dirname, '..', '..', 'agents');
export const SCAFFOLD_RELATIVE = '.ai-hub/.scaffold.json';

export interface ScaffoldFile {
  sha256: string;
  source: string;
}

export interface ScaffoldRecord {
  version: 1;
  files: Record<string, ScaffoldFile>;
}

export interface MaterializeResult {
  written: string[];
  kept: string[];
  collisions: string[];
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

export async function readScaffold(root: string): Promise<ScaffoldRecord> {
  const raw = await fs.readFile(path.join(root, SCAFFOLD_RELATIVE), 'utf8').catch(() => null);
  if (raw === null) {
    return { version: 1, files: {} };
  }
  try {
    const parsed = JSON.parse(raw) as ScaffoldRecord;
    return { version: 1, files: parsed.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

async function writeScaffold(root: string, record: ScaffoldRecord): Promise<void> {
  const file = path.join(root, SCAFFOLD_RELATIVE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function copyOnce(
  root: string,
  source: string,
  destination: string,
  record: ScaffoldRecord,
  result: MaterializeResult,
): Promise<void> {
  const content = await fs.readFile(source, 'utf8');
  const hash = sha256(content);
  const abs = path.join(root, destination);
  if (await exists(abs)) {
    const previous = record.files[destination];
    const current = sha256(await fs.readFile(abs, 'utf8').catch(() => ''));
    if (previous && previous.sha256 === current) {
      result.kept.push(destination);
      return;
    }
    result.collisions.push(destination);
    return;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  record.files[destination] = { sha256: hash, source };
  result.written.push(destination);
}

export async function materializePreset(
  root: string,
  preset: ResolvedPreset,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], kept: [], collisions: [] };
  const record = await readScaffold(root);

  for (const rule of preset.rules) {
    const source = await findPresetAsset(preset.chain, rule);
    if (source === null) {
      throw new Error(`el preset "${preset.id}" declara la regla "${rule}" pero no existe`);
    }
    await copyOnce(root, source, `.ai-hub/rules/${path.basename(rule)}`, record, result);
  }

  for (const agent of preset.agents) {
    const fromPreset = await findPresetAsset(preset.chain, `agents/${agent}.md`);
    const source = fromPreset ?? path.join(ENGINE_AGENTS, `${agent}.md`);
    if (!(await exists(source))) {
      throw new Error(`el agente "${agent}" no existe ni en el preset ni en el motor`);
    }
    await copyOnce(root, source, `.ai-hub/agents/${agent}.md`, record, result);
  }

  const harness = await findPresetAsset(preset.chain, 'harness');
  if (harness !== null) {
    for (const source of await walk(harness)) {
      const relative = path.relative(harness, source).split(path.sep).join('/');
      await copyOnce(root, source, `.ai-hub/harness/${relative}`, record, result);
    }
  }

  for (const skill of preset.skills) {
    const dir = await findPresetAsset(preset.chain, `skills/${skill}`);
    if (dir === null) {
      throw new Error(`la skill "${skill}" no existe en el preset "${preset.id}"`);
    }
    const files = await walk(dir);
    for (const source of files) {
      const relative = path.relative(dir, source).split(path.sep).join('/');
      await copyOnce(root, source, `.ai-hub/skills/${skill}/${relative}`, record, result);
    }
  }

  await writeScaffold(root, record);
  return result;
}
