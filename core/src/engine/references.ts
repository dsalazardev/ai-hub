import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_COMMAND_NAMES } from '../cli/command-names.js';
import { readScaffold } from '../presets/materialize.js';
import { sha256 } from '../sync/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.join(__dirname, '..', '..');
export const CATALOG_BASELINE_FILE = path.join(CORE_DIR, 'engine', 'catalog-baseline.json');

/**
 * Gate de referencias del catálogo (factory-evolution B1, cierra F-17b y la clase de F-03/G-04):
 * todo lo que un activo publicado nombra debe existir en el consumidor.
 */
export type ReferenceKind = 'harness-path' | 'command' | 'agent' | 'link' | 'planning';

export interface ReferenceFinding {
  /** Ruta legible del archivo escaneado (relativa a la raíz escaneada). */
  file: string;
  /** Clave estable del activo en el catálogo (`@engine/...`, `@preset/*\/...`) o su ruta local. */
  key: string;
  line: number;
  kind: ReferenceKind;
  ref: string;
}

export interface BaselineEntry {
  key: string;
  kind: ReferenceKind;
  ref: string;
  reason: string;
  /** Fecha `YYYY-MM-DD` propia; sin ella rige la del archivo. */
  expires?: string;
}

export interface CatalogBaseline {
  version: 1;
  expires: string;
  entries: BaselineEntry[];
}

export interface ReferenceScan {
  violations: ReferenceFinding[];
  baselined: ReferenceFinding[];
  expired: ReferenceFinding[];
  /** Caducidad más próxima entre las excepciones en uso. */
  nextExpiry: string | null;
  /** Copias intactas del catálogo omitidas (ámbito `project`). */
  pristine: number;
}

export interface ReferenceScanOptions {
  now?: Date;
  baseline?: CatalogBaseline;
}

/** Rutas del arnés que `init`/`install` materializan o que el consumidor crea con contrato. */
const HARNESS_EXACT = new Set([
  '.ai-hub/.env',
  '.ai-hub/.env.example',
  '.ai-hub/.scaffold.json',
  '.ai-hub/manifest.json',
  '.ai-hub/lessons.md',
]);
const HARNESS_PREFIXES = [
  '.ai-hub/runs/',
  '.ai-hub/work/',
  '.ai-hub/examples/',
  '.ai-hub/skills/',
  '.ai-hub/agents/',
  '.ai-hub/rules/',
  '.ai-hub/harness/',
];
/** Tipos de subagente propios de los hosts, válidos sin archivo de agente. */
const HOST_SUBAGENTS = new Set(['general-purpose', 'Explore', 'Plan']);
const TEXT = /\.(md|mdc|ya?ml)$/i;

export function isMaterializableHarnessPath(ref: string): boolean {
  if (HARNESS_EXACT.has(ref) || ref === '.ai-hub/') {
    return true;
  }
  const withSlash = ref.endsWith('/') ? ref : `${ref}/`;
  return HARNESS_PREFIXES.some((prefix) => ref.startsWith(prefix) || withSlash === prefix);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/** Rangos `[inicio, fin)` de los bloques de código cercados (```), donde los enlaces no cuentan. */
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^(```|~~~)/gm;
  let open: number | null = null;
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    if (open === null) {
      open = index;
    } else {
      ranges.push([open, index]);
      open = null;
    }
  }
  if (open !== null) {
    ranges.push([open, text.length]);
  }
  return ranges;
}

export interface ReferenceContext {
  agents: Set<string>;
  commands: Set<string>;
  /** Escanear `.planning/` (solo catálogo publicado: G-03). */
  planning: boolean;
}

/** Detectores puros sobre el texto de un archivo; `exists` resuelve los enlaces relativos. */
export async function findReferences(
  text: string,
  absoluteFile: string,
  context: ReferenceContext,
  exists: (absolute: string) => Promise<boolean>,
): Promise<Array<Omit<ReferenceFinding, 'file' | 'key'>>> {
  const found: Array<Omit<ReferenceFinding, 'file' | 'key'>> = [];
  const push = (kind: ReferenceKind, ref: string, index: number): void => {
    found.push({ kind, ref, line: lineOf(text, index) });
  };
  for (const match of text.matchAll(/\.ai-hub\/[\w./-]*[\w/]/g)) {
    if (!isMaterializableHarnessPath(match[0])) {
      push('harness-path', match[0], match.index ?? 0);
    }
  }
  for (const match of text.matchAll(/\bnpx\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:@dsalazardev\/ai-hub-cli|ai-hub)\s+([a-z][\w-]*)/g)) {
    if (!context.commands.has(match[1])) {
      push('command', match[1], match.index ?? 0);
    }
  }
  for (const match of text.matchAll(/subagent_type["'`]?\s*[:=]?\s*["'`]?([A-Za-z][\w-]*)/g)) {
    if (!context.agents.has(match[1]) && !HOST_SUBAGENTS.has(match[1])) {
      push('agent', match[1], match.index ?? 0);
    }
  }
  const fences = fencedRanges(text);
  for (const match of text.matchAll(/\]\((?!https?:|#|mailto:|\/)([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const index = match.index ?? 0;
    const target = match[1];
    if (/[{}<>*$]/.test(target) || fences.some(([start, end]) => index >= start && index < end)) {
      continue;
    }
    if (!(await exists(path.resolve(path.dirname(absoluteFile), decodeURI(target))))) {
      push('link', target, index);
    }
  }
  if (context.planning) {
    for (const match of text.matchAll(/\.planning\//g)) {
      push('planning', '.planning/', match.index ?? 0);
    }
  }
  return found;
}

async function existsPath(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function walkText(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkText(full)));
    } else if (entry.isFile() && TEXT.test(entry.name)) {
      files.push(full);
    }
  }
  return files.sort();
}

async function agentNames(dirs: string[]): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
      if (entry.endsWith('.md')) {
        names.add(entry.slice(0, -3));
      }
    }
  }
  return names;
}

export async function loadCatalogBaseline(file: string = CATALOG_BASELINE_FILE): Promise<CatalogBaseline> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    return { version: 1, expires: '1970-01-01', entries: [] };
  }
  return JSON.parse(raw) as CatalogBaseline;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Clave del catálogo para un archivo del motor: `@engine/<rel>` o `@preset/*\/<rel>`. */
function publishedKey(coreRelative: string): string {
  const preset = /^presets\/[^/]+\/(.*)$/.exec(coreRelative);
  return preset ? `@preset/*/${preset[1]}` : `@engine/${coreRelative}`;
}

/** Clave del catálogo para un archivo del consumidor, a partir de su registro de scaffold. */
function projectKey(relative: string, scaffold: Record<string, { source: string; sha256: string }>): string {
  const source = scaffold[relative]?.source;
  if (!source) {
    return relative;
  }
  const preset = /^@preset\/[^/]+\/(.*)$/.exec(source);
  return preset ? `@preset/*/${preset[1]}` : source;
}

function matchesBaseline(finding: ReferenceFinding, entry: BaselineEntry): boolean {
  return entry.key === finding.key && entry.kind === finding.kind && entry.ref === finding.ref;
}

/**
 * Escanea el catálogo publicado (`published`, en el checkout del motor: `core/`) o las fuentes del
 * proyecto (`project`, en una instalación: `.ai-hub/skills|agents|rules`). Las referencias heredadas
 * registradas en la línea base pasan hasta su caducidad; cualquier otra es una violación.
 */
export async function scanCatalogReferences(
  root: string,
  scope: 'published' | 'project',
  options: ReferenceScanOptions = {},
): Promise<ReferenceScan> {
  const baseline = options.baseline ?? (await loadCatalogBaseline());
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  const commands = new Set(CLI_COMMAND_NAMES);
  const files: Array<{ absolute: string; file: string; key: string }> = [];
  const result: ReferenceScan = { violations: [], baselined: [], expired: [], nextExpiry: null, pristine: 0 };
  let agents: Set<string>;
  if (scope === 'published') {
    const core = path.join(root, 'core');
    agents = await agentNames([path.join(core, 'agents')]);
    for (const dir of ['skills', 'agents', 'presets', 'rules', 'engine']) {
      for (const absolute of await walkText(path.join(core, dir))) {
        const rel = toPosix(path.relative(core, absolute));
        files.push({ absolute, file: `core/${rel}`, key: publishedKey(rel) });
      }
    }
  } else {
    const scaffold = (await readScaffold(root)).files;
    agents = await agentNames([path.join(CORE_DIR, 'agents'), path.join(root, '.ai-hub', 'agents')]);
    // Solo lo que el proyecto escribió o editó: una copia intacta del catálogo ya la cubre el gate de
    // publicación del paquete que la instaló (y "Scaffolding is once": no se refresca sola).
    for (const dir of ['.ai-hub/skills', '.ai-hub/agents', '.ai-hub/rules']) {
      for (const absolute of await walkText(path.join(root, ...dir.split('/')))) {
        const rel = toPosix(path.relative(root, absolute));
        const recorded = scaffold[rel]?.sha256;
        if (recorded !== undefined && recorded === sha256(await fs.readFile(absolute, 'utf8').catch(() => ''))) {
          result.pristine += 1;
          continue;
        }
        files.push({ absolute, file: rel, key: projectKey(rel, scaffold) });
      }
    }
  }
  const context: ReferenceContext = { agents, commands, planning: scope === 'published' };
  const seen = new Set<string>();
  for (const { absolute, file, key } of files) {
    const text = await fs.readFile(absolute, 'utf8').catch(() => '');
    for (const found of await findReferences(text, absolute, context, existsPath)) {
      const finding: ReferenceFinding = { ...found, file, key };
      const dedupe = `${key}\u0000${finding.kind}\u0000${finding.ref}`;
      if (seen.has(dedupe)) {
        continue;
      }
      seen.add(dedupe);
      const entry = baseline.entries.find((candidate) => matchesBaseline(finding, candidate));
      if (!entry) {
        result.violations.push(finding);
        continue;
      }
      const expires = entry.expires ?? baseline.expires;
      if (expires < today) {
        result.expired.push(finding);
        continue;
      }
      result.baselined.push(finding);
      if (result.nextExpiry === null || expires < result.nextExpiry) {
        result.nextExpiry = expires;
      }
    }
  }
  return result;
}

export function formatFinding(finding: ReferenceFinding): string {
  return `${finding.file}:${finding.line} ${finding.kind} ${finding.ref}`;
}
