import fs from 'node:fs/promises';
import path from 'node:path';
import { mapLimit } from '../concurrency.js';
import { ENGINE_SKILLS_DIR } from '../engine/engine.js';
import {
  ENGINE_AGENTS_DIR,
  ENGINE_RULES_DIR,
  RUBRIC_RULE_IDS,
  normalizeRuleId,
} from '../catalog.js';
import { sha256 } from '../sync/lock.js';
import { findPresetAsset, type ResolvedPreset } from './resolve.js';

export const ENGINE_AGENTS = ENGINE_AGENTS_DIR;
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
  const files = Object.fromEntries(
    Object.entries(record.files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, 'utf8');
}

async function copyOnce(
  root: string,
  source: string,
  destination: string,
  record: ScaffoldRecord,
  result: MaterializeResult,
  sourceKey: string = source,
): Promise<void> {
  const content = await fs.readFile(source, 'utf8');
  const hash = sha256(content);
  const abs = path.join(root, destination);
  if (await exists(abs)) {
    const previous = record.files[destination];
    const current = sha256(await fs.readFile(abs, 'utf8').catch(() => ''));
    if (previous && previous.sha256 === current) {
      previous.source = sourceKey;
      result.kept.push(destination);
      return;
    }
    result.collisions.push(destination);
    return;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  record.files[destination] = { sha256: hash, source: sourceKey };
  result.written.push(destination);
}

export async function materializePreset(
  root: string,
  preset: ResolvedPreset,
  selectedRules?: string[],
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], kept: [], collisions: [] };
  const record = await readScaffold(root);
  const wantedRules = selectedRules === undefined ? null : new Set(selectedRules);

  for (const rule of preset.rules) {
    if (wantedRules !== null && !wantedRules.has(normalizeRuleId(rule))) {
      continue;
    }
    const source = await findPresetAsset(preset.chain, rule);
    if (source === null) {
      throw new Error(`el preset "${preset.id}" declara la regla "${rule}" pero no existe`);
    }
    await copyOnce(
      root,
      source,
      `.ai-hub/rules/${normalizeRuleId(rule)}.md`,
      record,
      result,
      `@preset/${preset.id}/${rule.replace(/\\/g, '/')}`,
    );
  }

  for (const agent of preset.agents) {
    const fromPreset = await findPresetAsset(preset.chain, `agents/${agent}.md`);
    const source = fromPreset ?? path.join(ENGINE_AGENTS, `${agent}.md`);
    if (!(await exists(source))) {
      throw new Error(`el agente "${agent}" no existe ni en el preset ni en el motor`);
    }
    await copyOnce(
      root,
      source,
      `.ai-hub/agents/${agent}.md`,
      record,
      result,
      fromPreset ? `@preset/${preset.id}/agents/${agent}.md` : `@engine/agents/${agent}.md`,
    );
  }

  const harness = await findPresetAsset(preset.chain, 'harness');
  if (harness !== null) {
    for (const source of await walk(harness)) {
      const relative = path.relative(harness, source).split(path.sep).join('/');
      await copyOnce(
        root,
        source,
        `.ai-hub/harness/${relative}`,
        record,
        result,
        `@preset/${preset.id}/harness/${relative}`,
      );
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
      await copyOnce(
        root,
        source,
        `.ai-hub/skills/${skill}/${relative}`,
        record,
        result,
        `@preset/${preset.id}/skills/${skill}/${relative}`,
      );
    }
  }

  await writeScaffold(root, record);
  return result;
}

/** Copia una skill del catálogo o del preset a `.ai-hub/skills/<id>`. */
export async function materializeSkill(
  root: string,
  id: string,
  sourceDir: string = path.join(ENGINE_SKILLS_DIR, id),
  sourceKey: string = `@engine/skills/shared/${id}`,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], kept: [], collisions: [] };
  const record = await readScaffold(root);
  if (!(await exists(sourceDir))) {
    throw new Error(`la skill "${id}" no existe en ${sourceDir}`);
  }
  for (const source of await walk(sourceDir)) {
    const relative = path.relative(sourceDir, source).split(path.sep).join('/');
    await copyOnce(
      root,
      source,
      `.ai-hub/skills/${id}/${relative}`,
      record,
      result,
      `${sourceKey}/${relative}`,
    );
  }
  await writeScaffold(root, record);
  return result;
}

/** Copia un agente del catálogo o del preset a `.ai-hub/agents/<id>.md`. */
export async function materializeAgent(
  root: string,
  id: string,
  sourceFile: string = path.join(ENGINE_AGENTS, `${id}.md`),
  sourceKey: string = `@engine/agents/${id}.md`,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], kept: [], collisions: [] };
  const record = await readScaffold(root);
  if (!(await exists(sourceFile))) {
    throw new Error(`el agente "${id}" no existe en ${sourceFile}`);
  }
  await copyOnce(root, sourceFile, `.ai-hub/agents/${id}.md`, record, result, sourceKey);
  await writeScaffold(root, record);
  return result;
}

/** Copia las 4 rúbricas universales desde el paquete a `.ai-hub/rules/skill-quality/`. */
export async function materializeUniversalRules(
  root: string,
  preset: ResolvedPreset,
  selectedRules: string[] = [...RUBRIC_RULE_IDS],
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], kept: [], collisions: [] };
  const record = await readScaffold(root);
  const core = await findPresetAsset(preset.chain, 'rules/core.md');
  if (core === null) {
    throw new Error(`el preset "${preset.id}" no declara rules/core.md`);
  }
  await copyOnce(
    root,
    core,
    '.ai-hub/rules/core.md',
    record,
    result,
    `@preset/${preset.id}/rules/core.md`,
  );
  const wanted = new Set(selectedRules.filter((id) => id.startsWith('skill-quality/')));
  for (const id of RUBRIC_RULE_IDS) {
    if (!wanted.has(id)) {
      continue;
    }
    const source = path.join(ENGINE_RULES_DIR, `${id}.md`);
    if (!(await exists(source))) {
      throw new Error(`falta la rúbrica universal "${id}" en ${ENGINE_RULES_DIR}`);
    }
    await copyOnce(root, source, `.ai-hub/rules/${id}.md`, record, result, `@engine/rules/${id}.md`);
  }
  await writeScaffold(root, record);
  return result;
}

/** Copia skills y agentes seleccionados del catálogo. */
export async function materializeCatalog(
  root: string,
  skillIds: string[],
  agentIds: string[],
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], kept: [], collisions: [] };
  const record = await readScaffold(root);
  const copies: Array<{ source: string; destination: string; sourceKey: string }> = [];
  for (const id of [...skillIds].sort()) {
    const sourceDir = path.join(ENGINE_SKILLS_DIR, id);
    if (!(await exists(sourceDir))) {
      throw new Error(`la skill de catálogo "${id}" no existe en ${ENGINE_SKILLS_DIR}`);
    }
    for (const source of await walk(sourceDir)) {
      const relative = path.relative(sourceDir, source).split(path.sep).join('/');
      copies.push({
        source,
        destination: `.ai-hub/skills/${id}/${relative}`,
        sourceKey: `@engine/skills/shared/${id}/${relative}`,
      });
    }
  }
  for (const id of [...agentIds].sort()) {
    const source = path.join(ENGINE_AGENTS, `${id}.md`);
    if (!(await exists(source))) {
      throw new Error(`el agente de catálogo "${id}" no existe en ${ENGINE_AGENTS}`);
    }
    copies.push({
      source,
      destination: `.ai-hub/agents/${id}.md`,
      sourceKey: `@engine/agents/${id}.md`,
    });
  }
  await mapLimit(copies, 24, async (copy) => {
    await copyOnce(
      root,
      copy.source,
      copy.destination,
      record,
      result,
      copy.sourceKey,
    );
  });
  await writeScaffold(root, record);
  return result;
}

/**
 * Borra un activo materializado solo si lo escribió ai-hub (registro de scaffold o marcador);
 * un archivo del proyecto se conserva.
 */
export async function removeOwned(root: string, relative: string, directory: boolean): Promise<void> {
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) {
    return;
  }
  const record = await readScaffold(root);
  const relativePosix = relative.split(path.sep).join('/');
  if (directory) {
    const files = record.files;
    const prefix = `${relativePosix}/`;
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
  const owned = record.files[relativePosix] !== undefined;
  if (text === null || owned || text.includes('GENERADO por ai-hub')) {
    await fs.rm(absolute, { force: true });
  }
}
