import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { frontmatterString, splitFrontmatter } from '../frontmatter.js';
import { resolveSourcePath, type SyncConfig } from './config.js';
import { TARGETS } from './targets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RenderedFile {
  content: string;
  source: string;
  markerSource?: string;
}

export type RenderedFiles = Map<string, RenderedFile>;

const MANIFEST_SOURCE = 'manifest.yaml';
const CLAUDE_AGENT_KEYS = ['name', 'description', 'tools', 'model', 'color', 'memory'];

const PREFLIGHT_SOURCE = '@engine/engine/preflight.md';
const PREFLIGHT_MARKER_SOURCE = 'engine/preflight.md';

export async function renderAll(root: string, config: SyncConfig): Promise<RenderedFiles> {
  const out: RenderedFiles = new Map();
  await renderSkills(root, config, out);
  await renderAgents(root, config, out);
  await renderRules(root, config, out);
  await renderPreflight(root, config, out);
  await renderMcp(root, config, out);
  return out;
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

async function readSource(root: string, sourcePath: string): Promise<string> {
  const text = await fs.readFile(resolveSourcePath(root, sourcePath), 'utf8').catch(() => {
    throw new Error(`fuente no encontrada: ${sourcePath}`);
  });
  return normalize(text);
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
    const claudeData = Object.fromEntries(
      CLAUDE_AGENT_KEYS.filter((key) => key in data).map((key) => [key, data[key]]),
    );
    const subagentData = { description, mode: 'subagent' };
    for (const [tool, target] of Object.entries(targets)) {
      putRendered(out, `${target.path}/${name}.md`, {
        content:
          tool === 'claude'
            ? withMarker(frontmatter(claudeData) + body, sourcePath)
            : withMarker(frontmatter(subagentData) + body, sourcePath),
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
