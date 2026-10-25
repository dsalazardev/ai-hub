import fs from 'node:fs/promises';
import path from 'node:path';

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
    if (!entry.isFile() || !TEXT_FILE.test(entry.name)) {
      continue;
    }
    const text = await fs.readFile(path.join(dir, entry.name), 'utf8').catch(() => '');
    for (const marker of LEGACY_CONTENT) {
      if (text.includes(marker)) {
        findings.push(`${childRelative} (contiene "${marker}")`);
        break;
      }
    }
  }
}

async function isEngineCheckout(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, 'core', 'package.json'));
    await fs.access(path.join(root, 'core', 'src', 'paths.ts'));
    return true;
  } catch {
    return false;
  }
}

export async function scanLegacyArtifacts(root: string): Promise<string[]> {
  const findings: string[] = [];
  // En el checkout del motor los destinos de agente son el taller del mantenedor,
  // no salida de instalación: ahí OpenSpec es legítimo. En un consumidor sí se escanean.
  const dirs = (await isEngineCheckout(root))
    ? LEGACY_SOURCE_DIRS
    : [...LEGACY_SOURCE_DIRS, ...LEGACY_TARGET_DIRS];
  for (const relative of dirs) {
    await walk(path.join(root, ...relative.split('/')), relative, findings);
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
