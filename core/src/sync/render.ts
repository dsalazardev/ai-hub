import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { SyncConfig } from './config.js';

export interface RenderedFile {
  content: string;
  source: string;
}

export type RenderedFiles = Map<string, RenderedFile>;

const MANIFEST_SOURCE = '.ai-hub/manifest.yaml';
const CLAUDE_AGENT_KEYS = ['name', 'description', 'tools', 'model', 'color', 'memory'];

export async function renderAll(root: string, config: SyncConfig): Promise<RenderedFiles> {
  const out: RenderedFiles = new Map();
  await renderSkills(root, config, out);
  await renderAgents(root, config, out);
  await renderRules(root, config, out);
  await renderMcp(root, config, out);
  return out;
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

function splitFrontmatter(text: string, source: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    throw new Error(`sin frontmatter: ${source}`);
  }
  const data = parse(match[1]) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`frontmatter inválido: ${source}`);
  }
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) };
}

async function readSource(root: string, sourcePath: string): Promise<string> {
  const text = await fs.readFile(path.join(root, sourcePath), 'utf8').catch(() => {
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
  const { source, publish, targets } = config.skills;
  for (const name of publish) {
    const skillDir = path.join(root, source, name);
    const files = await listFiles(skillDir).catch(() => {
      throw new Error(`skill publicada no existe: ${source}/${name}`);
    });
    for (const file of files) {
      const rel = toPosix(path.relative(skillDir, file));
      const sourcePath = `${source}/${name}/${rel}`;
      const text = normalize(await fs.readFile(file, 'utf8'));
      const content = rel.endsWith('.md') ? withMarker(text, sourcePath) : text;
      for (const target of targets) {
        out.set(`${target}/${name}/${rel}`, { content, source: sourcePath });
      }
    }
  }
}

async function renderAgents(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const { source, publish, targets } = config.agents;
  for (const name of publish) {
    const sourcePath = `${source}/${name}.md`;
    const { data, body } = splitFrontmatter(await readSource(root, sourcePath), sourcePath);
    if (typeof data.name !== 'string' || typeof data.description !== 'string') {
      throw new Error(`el agente necesita "name" y "description" en su frontmatter: ${sourcePath}`);
    }
    const claudeData = Object.fromEntries(
      CLAUDE_AGENT_KEYS.filter((key) => key in data).map((key) => [key, data[key]]),
    );
    const opencodeData = { description: data.description, mode: 'subagent' };
    out.set(`${targets.claude}/${name}.md`, {
      content: withMarker(frontmatter(claudeData) + body, sourcePath),
      source: sourcePath,
    });
    out.set(`${targets.opencode}/${name}.md`, {
      content: withMarker(frontmatter(opencodeData) + body, sourcePath),
      source: sourcePath,
    });
  }
}

async function renderRules(root: string, config: SyncConfig, out: RenderedFiles): Promise<void> {
  const dir = config.rules.source;
  const names = (await fs.readdir(path.join(root, dir)))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();

  const emit = (outPath: string, sourcePath: string, content: string): void => {
    out.set(outPath, { content: withMarker(content, sourcePath), source: sourcePath });
  };

  for (const area of names) {
    const sourcePath = `${dir}/${area}.md`;
    const body = await readSource(root, sourcePath);
    if (area === 'core') {
      emit('.github/instructions/core.instructions.md', sourcePath, frontmatter({ applyTo: '**' }) + body);
      emit(
        '.cursor/rules/core.mdc',
        sourcePath,
        frontmatter({ description: 'Reglas base de Doligestion', alwaysApply: true }) + body,
      );
      continue;
    }
    emit(`${area}/AGENTS.md`, sourcePath, body);
    emit(`.claude/rules/${area}.md`, sourcePath, frontmatter({ paths: [`${area}/**`] }) + body);
    emit(
      `.cursor/rules/${area}.mdc`,
      sourcePath,
      frontmatter({ description: `Reglas de ${area}`, globs: `${area}/**`, alwaysApply: false }) + body,
    );
    emit(
      `.github/instructions/${area}.instructions.md`,
      sourcePath,
      frontmatter({ applyTo: `${area}/**` }) + body,
    );
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
  const source = config.mcp.source;
  const servers = readMcpServers(await readSource(root, source), source);
  const claude: Record<string, unknown> = {};
  const cursor: Record<string, unknown> = {};
  const vscode: Record<string, unknown> = {};
  const opencode: Record<string, unknown> = {};
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
  out.set('.mcp.json', { content: json({ mcpServers: claude }), source });
  out.set('.cursor/mcp.json', { content: json({ mcpServers: cursor }), source });
  out.set('.vscode/mcp.json', { content: json({ servers: vscode }), source });
  out.set('opencode.json', {
    content: json({
      $schema: 'https://opencode.ai/config.json',
      instructions: config.opencode.instructions,
      mcp: opencode,
    }),
    source: MANIFEST_SOURCE,
  });
}
