import fs from 'node:fs/promises';
import { renderAgentHeader } from '../agents/header.js';
import { areaGlob } from '../engine/scopes.js';
import { readScaffold } from '../presets/materialize.js';
import { sha256 } from './lock.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { frontmatterString, splitFrontmatter } from '../frontmatter.js';
import { resolveSourcePath, type SyncConfig } from './config.js';
import { TARGETS, type ToolId } from './targets.js';
import { loadEngine } from '../engine/engine.js';
import { BINDING_MARKER_SOURCE, BINDING_RULE_ID, BINDING_SOURCE, bindingRule } from '../speckit/binding.js';
import { closingContractSection } from '../speckit/status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RenderedFile {
  content: string;
  source: string;
  markerSource?: string;
  /** Región reservada (E2): `content` es solo el interior de la región del archivo del usuario. */
  region?: string;
}

export type RenderedFiles = Map<string, RenderedFile>;

const MANIFEST_SOURCE = 'manifest.yaml';

const PREFLIGHT_SOURCE = '@engine/engine/preflight.md';
const PREFLIGHT_MARKER_SOURCE = 'engine/preflight.md';

export async function renderAll(root: string, config: SyncConfig): Promise<RenderedFiles> {
  interpolation = { scaffold: (await readScaffold(root)).files, stack: config.stack };
  try {
    return await renderAllWith(root, config);
  } finally {
    interpolation = null;
  }
}

async function renderAllWith(root: string, config: SyncConfig): Promise<RenderedFiles> {
  const out: RenderedFiles = new Map();
  await renderSkills(root, config, out);
  await renderAgents(root, config, out);
  await renderRules(root, config, out);
  await renderPreflight(root, config, out);
  await renderHookPlugins(config, out);
  await renderLessons(root, config, out);
  renderAreaRules(config, out);
  await renderAgentsMd(config, out);
  await renderSpeckitBinding(config, out);
  await renderMcp(root, config, out);
  return out;
}

const HOOK_PLUGIN_SOURCE = '@engine/engine/templates/opencode-plugin.js';

/** Hooks ejecutables de tipo plugin (G-01): archivo propio del destino, versionado por el lock. */
async function renderHookPlugins(config: SyncConfig, out: RenderedFiles): Promise<void> {
  const sourcePath = path.join(__dirname, '..', '..', 'engine', 'templates', 'opencode-plugin.js');
  const content = normalize(await fs.readFile(sourcePath, 'utf8'));
  for (const tool of config.tools) {
    const spec = TARGETS[tool];
    if (spec.hookFormat === 'plugin' && spec.hookPath !== null) {
      putRendered(out, spec.hookPath, { content, source: HOOK_PLUGIN_SOURCE });
    }
  }
}

const AGENTS_MD = 'AGENTS.md';
const AGENTS_MD_REGION = 'ai-hub';

/**
 * Región reservada de AGENTS.md (E2, M-17): índice de reglas, lecciones y contrato de cierre en el
 * AGENTS.md raíz (lo leen Codex y Copilot coding agent sin destino propio) y el resumen de cada área
 * en `<ruta del área>/AGENTS.md`. Solo con `agentsMd: true`; el resto del archivo es del usuario.
 */
async function renderAgentsMd(config: SyncConfig, out: RenderedFiles): Promise<void> {
  if (!config.agentsMd) {
    return;
  }
  const engine = await loadEngine();
  const ruleDirs = [...new Set(config.tools.map((tool) => TARGETS[tool].rules))];
  const body = [
    '# AI-Hub',
    '',
    'Este bloque lo mantiene `ai-hub sync`; el resto del archivo es del proyecto.',
    '',
    `- Reglas del proyecto proyectadas en: ${ruleDirs.map((dir) => `\`${dir}\``).join(', ')}.`,
    '- Lecciones del proyecto: `.ai-hub/lessons.md` (regla `ai-hub-lessons`).',
    '- Metodología: Spec Kit (regla `ai-hub-speckit`).',
    '',
    ...closingContractSection(engine),
    '',
  ].join('\n');
  putRendered(out, AGENTS_MD, { content: body, source: BINDING_SOURCE, region: AGENTS_MD_REGION });
  for (const area of config.areas) {
    const first = area.paths[0]?.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\*.*$/, '');
    if (!first) {
      continue;
    }
    const content = [
      `# Área ${area.id}`,
      '',
      `- Rol: \`${area.role}\`; solo escribe en ${area.paths.map(areaGlob).map((glob) => `\`${glob}\``).join(', ')}.`,
      '- Contrato de cierre y reglas generales: ver el `AGENTS.md` de la raíz.',
      '',
    ].join('\n');
    putRendered(out, `${first}/${AGENTS_MD}`, { content, source: 'manifest.yaml', region: AGENTS_MD_REGION });
  }
}

/** Una regla por área (E3): rol, rutas de escritura y reglas del área. Fuente: manifest.yaml. */
function renderAreaRules(config: SyncConfig, out: RenderedFiles): void {
  for (const area of config.areas) {
    const globs = area.paths.map(areaGlob);
    const body = [
      `# Área ${area.id}`,
      '',
      `- Rol: \`${area.role}\`; solo escribe dentro de estas rutas.`,
      `- Rutas: ${globs.map((glob) => `\`${glob}\``).join(', ')}.`,
      ...(area.rules && area.rules.length > 0
        ? [`- Reglas del área: ${area.rules.map((rule) => `\`${rule}\``).join(', ')} (en \`.ai-hub/rules/\`).`]
        : []),
      '',
    ].join('\n');
    for (const tool of config.tools) {
      const spec = TARGETS[tool];
      const id = `ai-hub-area-${area.id}`;
      if (spec.ruleShape === 'mdc') {
        putRendered(out, `${spec.rules}/${id}.mdc`, {
          source: 'manifest.yaml',
          content: withMarker(frontmatter({ description: `Área ${area.id}`, globs: globs.join(','), alwaysApply: false }) + body, 'manifest.yaml'),
        });
        continue;
      }
      if (spec.ruleShape === 'instructions') {
        putRendered(out, `${spec.rules}/${id}.instructions.md`, {
          source: 'manifest.yaml',
          content: withMarker(frontmatter({ applyTo: globs.join(',') }) + body, 'manifest.yaml'),
        });
        continue;
      }
      putRendered(out, `${spec.rules}/${id}.md`, { source: 'manifest.yaml', content: withMarker(body, 'manifest.yaml') });
    }
  }
}

export const LESSONS_RULE_ID = 'ai-hub-lessons';
const LESSONS_SOURCE = '.ai-hub/lessons.md';

/** Lecciones del proyecto (M-12): `.ai-hub/lessons.md` proyectado como regla en cada destino. */
async function renderLessons(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const text = await fs.readFile(path.join(root, ...LESSONS_SOURCE.split('/')), 'utf8').catch(() => null);
  if (text === null) {
    return;
  }
  const body = normalize(text);
  for (const tool of config.tools) {
    const spec = TARGETS[tool];
    if (spec.ruleShape === 'mdc') {
      putRendered(out, `${spec.rules}/${LESSONS_RULE_ID}.mdc`, {
        source: LESSONS_SOURCE,
        content: withMarker(frontmatter({ description: 'Lecciones del proyecto', alwaysApply: true }) + body, LESSONS_SOURCE),
      });
      continue;
    }
    if (spec.ruleShape === 'instructions') {
      putRendered(out, `${spec.rules}/${LESSONS_RULE_ID}.instructions.md`, {
        source: LESSONS_SOURCE,
        content: withMarker(frontmatter({ applyTo: '**' }) + body, LESSONS_SOURCE),
      });
      continue;
    }
    putRendered(out, `${spec.rules}/${LESSONS_RULE_ID}.md`, { source: LESSONS_SOURCE, content: withMarker(body, LESSONS_SOURCE) });
  }
}

/** Regla de enlace con Spec Kit, generada desde engine.yaml en cada destino declarado. */
async function renderSpeckitBinding(config: SyncConfig, out: RenderedFiles): Promise<void> {
  const engine = await loadEngine();
  for (const tool of config.tools) {
    const spec = TARGETS[tool];
    const body = bindingRule(engine, tool, config.projectPolicy);
    const file = { source: BINDING_SOURCE, markerSource: BINDING_MARKER_SOURCE };
    if (spec.ruleShape === 'mdc') {
      putRendered(out, `${spec.rules}/${BINDING_RULE_ID}.mdc`, {
        ...file,
        content: withMarker(
          frontmatter({ description: 'Spec Kit: roles, estados y etiquetas', alwaysApply: true }) + body,
          BINDING_MARKER_SOURCE,
        ),
      });
      continue;
    }
    if (spec.ruleShape === 'instructions') {
      putRendered(out, `${spec.rules}/${BINDING_RULE_ID}.instructions.md`, {
        ...file,
        content: withMarker(frontmatter({ applyTo: '**' }) + body, BINDING_MARKER_SOURCE),
      });
      continue;
    }
    putRendered(out, `${spec.rules}/${BINDING_RULE_ID}.md`, {
      ...file,
      content: withMarker(body, BINDING_MARKER_SOURCE),
    });
  }
}

async function renderPreflight(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const sourcePath = path.join(__dirname, '..', '..', 'engine', 'preflight.md');
  const body = normalize(await fs.readFile(sourcePath, 'utf8'));
  for (const tool of config.tools) {
    const spec = TARGETS[tool];
    if (spec.hookKind === 'cursor-mdc') {
      putRendered(out, spec.hook, {
        content: withMarker(
          frontmatter({ description: 'Deterministic preflight guard', alwaysApply: true }) + body,
          PREFLIGHT_MARKER_SOURCE,
        ),
        source: PREFLIGHT_SOURCE,
        markerSource: PREFLIGHT_MARKER_SOURCE,
      });
      continue;
    }
    if (spec.hookKind === 'copilot-instructions') {
      putRendered(out, spec.hook, {
        content: withMarker(
          frontmatter({ applyTo: '**' }) + body,
          PREFLIGHT_MARKER_SOURCE,
        ),
        source: PREFLIGHT_SOURCE,
        markerSource: PREFLIGHT_MARKER_SOURCE,
      });
      continue;
    }
    putRendered(out, spec.hook, {
      content: withMarker(body, PREFLIGHT_MARKER_SOURCE),
      source: PREFLIGHT_SOURCE,
      markerSource: PREFLIGHT_MARKER_SOURCE,
    });
  }
}

export class DestinationCollisionError extends Error {
  constructor(
    readonly destination: string,
    readonly first: string,
    readonly second: string,
  ) {
    super(`colisión de destinos: ${destination} (${first} vs ${second})`);
    this.name = 'DestinationCollisionError';
  }
}

export function putRendered(out: RenderedFiles, destination: string, file: RenderedFile): void {
  const existing = out.get(destination);
  if (existing && existing.source !== file.source) {
    throw new DestinationCollisionError(destination, existing.source, file.source);
  }
  out.set(destination, file);
}

export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function markerFor(source: string): string {
  return `<!-- GENERADO por ai-hub sync desde ${source} — no editar -->`;
}

export function withMarker(content: string, source: string): string {
  const marker = markerFor(source);
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (frontmatter) {
    return `${frontmatter[0]}${marker}\n${content.slice(frontmatter[0].length)}`;
  }
  return `${marker}\n${content}`;
}

function frontmatter(data: Record<string, unknown>): string {
  return `---\n${stringify(data)}---\n`;
}

interface InterpolationContext {
  scaffold: Record<string, { sha256: string; source: string }>;
  stack: Record<string, string>;
}

/** Contexto de interpolación de la pasada de render en curso (M-27); `null` fuera de `renderAll`. */
let interpolation: InterpolationContext | null = null;

/**
 * `{{stack.<clave>}}` se resuelve SOLO en fuentes que vienen de un preset y siguen intactas (hash del
 * scaffold); una copia editada por el proyecto o una fuente del motor no se interpola. Una clave
 * desconocida hace fallar sync nombrando archivo y clave.
 */
function interpolate(sourcePath: string, raw: string, text: string): string {
  const record = interpolation?.scaffold[sourcePath];
  if (interpolation === null || !record || !record.source.startsWith('@preset/') || record.sha256 !== sha256(raw)) {
    return text;
  }
  const stack = interpolation.stack;
  return text.replace(/{{s*stack.([A-Za-z0-9_]+)s*}}/g, (_match, key: string) => {
    if (!(key in stack)) {
      throw new Error(`${sourcePath}: {{stack.${key}}} no existe en manifest.stack`);
    }
    return stack[key];
  });
}

async function readSource(root: string, sourcePath: string): Promise<string> {
  const raw = await fs.readFile(resolveSourcePath(root, sourcePath), 'utf8').catch(() => {
    throw new Error(`fuente no encontrada: ${sourcePath}`);
  });
  return interpolate(sourcePath, raw, normalize(raw));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

async function renderSkills(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  for (const { source, publish } of config.skills.sources) {
    for (const name of publish) {
      const skillDir = resolveSourcePath(root, `${source}/${name}`);
      const skillSourcePath = `${source}/${name}/SKILL.md`;
      const skillText = await readSource(root, skillSourcePath);
      const { data: skillData, body: skillBody } = splitFrontmatter(skillText, skillSourcePath);
      frontmatterString(skillData, 'name', skillSourcePath);
      const description = frontmatterString(skillData, 'description', skillSourcePath);
      const files = await listFiles(skillDir).catch(() => {
        throw new Error(`skill publicada no existe: ${source}/${name}`);
      });
      for (const target of config.skills.targets) {
        if (target.shape === 'file') {
          const content =
            frontmatter({ description, alwaysApply: false }) + withMarker(skillBody, skillSourcePath);
          putRendered(out, `${target.path}/${name}.mdc`, { content, source: skillSourcePath });
          continue;
        }
        for (const file of files) {
          const rel = toPosix(path.relative(skillDir, file));
          const sourcePath = `${source}/${name}/${rel}`;
          const text =
            rel === 'SKILL.md'
              ? skillText
              : normalize(await fs.readFile(file, 'utf8'));
          const content = rel.endsWith('.md') ? withMarker(text, sourcePath) : text;
          putRendered(out, `${target.path}/${name}/${rel}`, { content, source: sourcePath });
        }
      }
    }
  }
}

async function renderAgents(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const { source, publish, targets } = config.agents;
  for (const name of publish) {
    const sourcePath = `${source}/${name}.md`;
    const { data, body } = splitFrontmatter(await readSource(root, sourcePath), sourcePath);
    frontmatterString(data, 'name', sourcePath);
    const description = frontmatterString(data, 'description', sourcePath);
    const tier = typeof data.tier === 'string' ? data.tier : null;
    // A3: la cabecera de cada destino sale de su `agentFormat` declarativo; sin ramas por destino.
    for (const tool of Object.keys(targets) as ToolId[]) {
      const format = TARGETS[tool].agentFormat;
      if (format === null) {
        continue;
      }
      const model = tier === null ? null : (config.agentModels[tool]?.[tier] ?? null);
      const header = renderAgentHeader(format, { name, description }, data, model);
      putRendered(out, `${format.path}/${name}${format.extension}`, {
        content: withMarker(frontmatter(header.data) + body, sourcePath),
        source: sourcePath,
      });
    }
  }
}

async function renderRules(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const dir = config.rules.source;
  for (const area of config.rules.publish) {
    const sourcePath = `${dir}/${area}.md`;
    const body = await readSource(root, sourcePath);
    const isCore = area === 'core';
    for (const [tool, target] of Object.entries(config.rules.targets)) {
      if (target.shape === 'mdc') {
        const preferred = `${target.path}/${area}.mdc`;
        const destination = out.has(preferred)
          ? `${target.path}/rule-${area}.mdc`
          : preferred;
        putRendered(out, destination, {
          content: withMarker(
            frontmatter({
              description: isCore ? 'Core project rules' : `Rules for ${area}`,
              globs: isCore ? '**' : `${area}/**`,
              alwaysApply: isCore,
            }) + body,
            sourcePath,
          ),
          source: sourcePath,
        });
        continue;
      }
      if (target.shape === 'instructions') {
        putRendered(out, `${target.path}/${area}.instructions.md`, {
          content: withMarker(frontmatter({ applyTo: isCore ? '**' : `${area}/**` }) + body, sourcePath),
          source: sourcePath,
        });
        continue;
      }
      const data = isCore ? {} : { paths: [`${area}/**`] };
      putRendered(out, `${target.path}/${area}.md`, {
        content: withMarker(frontmatter(data) + body, sourcePath),
        source: sourcePath,
      });
      void tool;
    }
  }
}

interface McpServer {
  id: string;
  url: string | null;
  command: string | null;
  args: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMcpServers(text: string, source: string): McpServer[] {
  const data = parse(text) as unknown;
  if (!isRecord(data) || !Array.isArray(data.required_mcps)) {
    throw new Error(`${source}: falta la lista required_mcps`);
  }
  return data.required_mcps
    .map((item: unknown): McpServer => {
      if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.client)) {
        throw new Error(`${source}: cada MCP necesita "id" y un bloque "client"`);
      }
      const { url, command, args } = item.client;
      const argList = Array.isArray(args) && args.every((a): a is string => typeof a === 'string') ? args : [];
      if (typeof url !== 'string' && typeof command !== 'string') {
        throw new Error(`${source}: el MCP "${item.id}" necesita client.url o client.command`);
      }
      return {
        id: item.id,
        url: typeof url === 'string' ? url : null,
        command: typeof command === 'string' ? command : null,
        args: argList,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function renderMcp(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const claude: Record<string, unknown> = {};
  const cursor: Record<string, unknown> = {};
  const vscode: Record<string, unknown> = {};
  const opencode: Record<string, unknown> = {};
  const source = config.mcp?.source ?? MANIFEST_SOURCE;
  if (config.mcp) {
    const servers = readMcpServers(await readSource(root, config.mcp.source), config.mcp.source);
    for (const server of servers) {
      if (server.url !== null) {
        claude[server.id] = { type: 'http', url: server.url };
        cursor[server.id] = { url: server.url };
        vscode[server.id] = { type: 'http', url: server.url };
        opencode[server.id] = { type: 'remote', url: server.url, enabled: true };
      } else if (server.command !== null) {
        claude[server.id] = { command: server.command, args: server.args };
        cursor[server.id] = { command: server.command, args: server.args };
        vscode[server.id] = { type: 'stdio', command: server.command, args: server.args };
        opencode[server.id] = { type: 'local', command: [server.command, ...server.args], enabled: true };
      }
    }
    const json = (data: Record<string, unknown>): string => `${JSON.stringify(data, null, 2)}\n`;
    putRendered(out, '.mcp.json', { content: json({ mcpServers: claude }), source });
    putRendered(out, '.cursor/mcp.json', { content: json({ mcpServers: cursor }), source });
    putRendered(out, '.vscode/mcp.json', { content: json({ servers: vscode }), source });
  }
  putRendered(out, 'opencode.json', {
    content: `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        instructions: config.opencode.instructions,
        mcp: opencode,
      },
      null,
      2,
    )}\n`,
    source: MANIFEST_SOURCE,
  });
}
