import fs from 'node:fs/promises';
import path from 'node:path';
import { isEngineCheckout } from '../source-checkout.js';
import { ENGINE_AGENTS_DIR, ENGINE_RULES_DIR, catalogIndex } from '../catalog.js';
import { ENGINE_SKILLS_DIR } from './engine.js';

const LEGACY_SOURCE_DIRS = ['core/presets', 'core/skills', 'core/agents'];
const LEGACY_TARGET_DIRS = [
  '.claude',
  '.opencode',
  '.pi',
  '.cursor',
  '.github/skills',
  '.github/agents',
  '.github/instructions',
];
const LEGACY_CONTENT = ['/opsx', 'opsx:', 'Bash(openspec:*)', 'Requires openspec CLI'];
const TEXT_FILE = /\.(md|mdc|ya?ml|json|ts|js|mjs|sh|ps1|txt)$/i;

function isLegacyName(name: string): boolean {
  return name === 'opsx' || name === 'openspec' || name.startsWith('opsx-') || name.startsWith('openspec-');
}

async function scanFile(file: string, relative: string, findings: string[]): Promise<void> {
  const name = path.basename(file);
  if (isLegacyName(name)) {
    findings.push(`${relative} (nombre legacy)`);
    return;
  }
  if (!TEXT_FILE.test(name)) {
    return;
  }
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  for (const marker of LEGACY_CONTENT) {
    if (text.includes(marker)) {
      findings.push(`${relative} (contiene "${marker}")`);
      break;
    }
  }
}

async function walk(dir: string, relative: string, findings: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return;
  }
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    if (isLegacyName(entry.name)) {
      findings.push(`${childRelative} (nombre legacy)`);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), childRelative, findings);
      continue;
    }
    if (entry.isFile()) {
      await scanFile(path.join(dir, entry.name), childRelative, findings);
    }
  }
}

async function scanInstalledCatalog(findings: string[]): Promise<void> {
  const index = await catalogIndex();
  for (const id of index.skills) {
    for (const file of index.skillFiles[id] ?? []) {
      const relative = `@engine/skills/shared/${id}/${path
        .relative(path.join(ENGINE_SKILLS_DIR, id), file)
        .split(path.sep)
        .join('/')}`;
      await scanFile(file, relative, findings);
    }
  }
  for (const id of index.agents) {
    await scanFile(
      path.join(ENGINE_AGENTS_DIR, `${id}.md`),
      `@engine/agents/${id}.md`,
      findings,
    );
  }
  for (const id of Object.keys(index.ruleFiles)) {
    for (const file of index.ruleFiles[id] ?? []) {
      await scanFile(file, `@engine/rules/${id}.md`, findings);
    }
  }
}

export async function scanLegacyArtifacts(root: string): Promise<string[]> {
  const findings: string[] = [];
  const engineCheckout = await isEngineCheckout(root);
  if (engineCheckout) {
    // En el checkout del motor los destinos de agente son el taller del mantenedor.
    for (const relative of LEGACY_SOURCE_DIRS) {
      await walk(path.join(root, ...relative.split('/')), relative, findings);
    }
  } else {
    // En una instalación se escanean el proyecto, los destinos y el catálogo del paquete.
    for (const relative of ['.ai-hub', ...LEGACY_TARGET_DIRS]) {
      await walk(path.join(root, ...relative.split('/')), relative, findings);
    }
    await scanInstalledCatalog(findings);
  }
  return findings.sort();
}

const COUPLING_SOURCE_DIRS = ['core/src', 'core/engine', 'core/agents', 'core/skills/shared'];
const COUPLING_EXCLUDED = new Set(['core/engine/coupling.json']);
const COUPLING_TEXT = /\.(ts|js|mjs|md|ya?ml|json|sh|ps1)$/i;

async function walkCoupling(
  dir: string,
  relative: string,
  terms: string[],
  findings: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return;
  }
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkCoupling(path.join(dir, entry.name), childRelative, terms, findings);
      continue;
    }
    if (
      !entry.isFile() ||
      COUPLING_EXCLUDED.has(childRelative) ||
      !COUPLING_TEXT.test(entry.name)
    ) {
      continue;
    }
    const text = (await fs.readFile(path.join(dir, entry.name), 'utf8')).toLowerCase();
    for (const term of terms) {
      if (text.includes(term)) {
        findings.push(`${childRelative} contiene "${term}"`);
        break;
      }
    }
  }
}

export async function scanCoupling(root: string, terms: string[]): Promise<string[]> {
  const findings: string[] = [];
  const normalized = terms.map((term) => term.toLowerCase());
  for (const relative of COUPLING_SOURCE_DIRS) {
    await walkCoupling(
      path.join(root, ...relative.split('/')),
      relative,
      normalized,
      findings,
    );
  }
  return findings.sort();
}

/** Prefijos que Spec Kit reserva en los directorios de comandos de cada destino. */
export const SPECKIT_RESERVED_PREFIXES = ['speckit-', 'speckit.'] as const;

function reservedName(name: string): boolean {
  return SPECKIT_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Gate del catálogo publicado: ninguna skill, agente o regla puede proyectarse con un nombre
 * del espacio reservado de Spec Kit (`speckit-*` / `speckit.*`).
 */
export async function scanReservedNamespace(
  dirs: { skills: string; agents: string; rules: string } = {
    skills: ENGINE_SKILLS_DIR,
    agents: ENGINE_AGENTS_DIR,
    rules: ENGINE_RULES_DIR,
  },
): Promise<string[]> {
  const findings: string[] = [];
  for (const entry of await fs.readdir(dirs.skills, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && reservedName(entry.name)) {
      findings.push(`skills/shared/${entry.name} (espacio reservado de Spec Kit)`);
    }
  }
  for (const [kind, dir] of [['agents', dirs.agents], ['rules', dirs.rules]] as const) {
    for (const name of await listNames(dir)) {
      if (reservedName(path.basename(name))) {
        findings.push(`${kind}/${name} (espacio reservado de Spec Kit)`);
      }
    }
  }
  return findings.sort();
}

async function listNames(dir: string, prefix = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      names.push(...(await listNames(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      names.push(rel);
    }
  }
  return names;
}

/** Estados retirados que solo existían como estado de salida: se marcan en cualquier contexto. */
const RETIRED_ALWAYS = ['ROOT_CAUSE', 'NEEDS_DATA'];
/** Estados retirados que también son palabras corrientes: se marcan solo usados como estado. */
const RETIRED_IN_STATE_CONTEXT = ['FIXED', 'RESOLVED', 'OPEN', 'DRAFT', 'READY'];
const STATE_CONTEXT = /\b(estados?|exit|exits|termina(n)? en|ends? in|outcome|veredicto|verdict)\b/i;

function retiredInLine(line: string): string[] {
  const found: string[] = [];
  const words = new Set(line.split(/[^A-Za-z0-9_-]+/));
  for (const token of RETIRED_ALWAYS) {
    if (words.has(token)) {
      found.push(token);
    }
  }
  for (const token of RETIRED_IN_STATE_CONTEXT) {
    const quoted = line.includes(`\`${token}\``);
    const inContext = STATE_CONTEXT.test(line) && words.has(token);
    if (quoted || inContext) {
      found.push(token);
    }
  }
  return found;
}

/** Archivos que el gate revisa en el checkout del motor: motor, documentación y catálogo publicado. */
async function retiredStateFiles(root: string): Promise<string[]> {
  const files = [
    path.join(root, 'core', 'engine', 'engine.yaml'),
    path.join(root, 'AGENTS.md'),
    path.join(root, 'README.md'),
    path.join(root, 'core', 'README.md'),
  ];
  for (const dir of ['core/rules', 'core/agents', 'core/skills/shared']) {
    for (const rel of await listNames(path.join(root, ...dir.split('/')))) {
      if (TEXT_FILE.test(rel)) {
        files.push(path.join(root, ...dir.split('/'), ...rel.split('/')));
      }
    }
  }
  return files;
}

/**
 * Gate del vocabulario de estados retirado (`ROOT_CAUSE`, `FIXED`, `READY`…): devuelve
 * `ruta:línea vocabulario obsoleto "TOKEN"` relativo a `root`.
 */
export async function scanRetiredStates(files: string[] | undefined, root: string): Promise<string[]> {
  const findings: string[] = [];
  for (const file of files ?? (await retiredStateFiles(root))) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) {
      continue;
    }
    const rel = path.relative(root, file).split(path.sep).join('/');
    text.split(/\r?\n/).forEach((line, index) => {
      for (const token of retiredInLine(line)) {
        findings.push(`${rel}:${index + 1} vocabulario obsoleto "${token}"`);
      }
    });
  }
  return findings;
}
