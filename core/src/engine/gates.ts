import fs from 'node:fs/promises';
import path from 'node:path';
import { isEngineCheckout } from '../source-checkout.js';
import { ENGINE_AGENTS_DIR, catalogIndex } from '../catalog.js';
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
