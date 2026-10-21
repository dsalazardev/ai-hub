import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runSync } from '../src/sync/sync.js';

const MANIFEST = `sync:
  skills:
    source: .ai-hub/skills/shared
    publish:
      - demo-skill
      - openspec-demo
    targets:
      - .claude/skills
  agents:
    source: .ai-hub/agents
    publish:
      - demo-agent
    targets:
      claude: .claude/agents
      opencode: .opencode/agents
  rules:
    source: .ai-hub/rules
  mcp:
    source: .ai-hub/mcp-manifest.yaml
  opencode:
    instructions:
      - .ai-hub/rules/core.md
`;

const MCP_MANIFEST = `required_mcps:
  - id: playwright
    type: local
    client:
      command: npx
      args:
        - "-y"
        - "@playwright/mcp@0.0.83"
  - id: notion
    type: remote
    client:
      url: https://mcp.notion.com/mcp
`;

const SKILL_SOURCE = '---\nname: demo-skill\ndescription: Skill de prueba\n---\n\n# Demo\r\nLínea con CRLF\r\n';
const AGENT_SOURCE =
  '---\nname: demo-agent\ndescription: Agente de prueba\ntools: Read, Grep\n---\n\n# Cuerpo del agente\n';

let root: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

async function seed(manifest: string = MANIFEST): Promise<void> {
  await write('.ai-hub/manifest.yaml', manifest);
  await write('.ai-hub/skills/shared/demo-skill/SKILL.md', SKILL_SOURCE);
  await write('.ai-hub/agents/demo-agent.md', AGENT_SOURCE);
  await write('.ai-hub/rules/core.md', '# Core\n');
  await write('.ai-hub/rules/frontend.md', '# Frontend\n');
  await write('.ai-hub/skills/shared/openspec-demo/SKILL.md', SKILL_SOURCE.replace('demo-skill', 'openspec-demo'));
  await write('.ai-hub/mcp-manifest.yaml', MCP_MANIFEST);
}

describe('runSync: escritura', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-sync-'));
    await seed();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('genera las copias y el lock, y la comprobación posterior pasa', async () => {
    const result = await runSync(root, { check: false });
    expect(result.written).toContain('.claude/skills/demo-skill/SKILL.md');
    expect(result.written).toContain('.claude/agents/demo-agent.md');
    expect(await read('.ai-hub/sync.lock.json')).toContain('"version": 1');

    const check = await runSync(root, { check: true });
    expect(check.problems).toEqual([]);
  });

  it('no vuelve a escribir nada si la fuente no ha cambiado', async () => {
    await runSync(root, { check: false });
    const second = await runSync(root, { check: false });
    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('normaliza CRLF a LF en las copias', async () => {
    await runSync(root, { check: false });
    const copy = await read('.claude/skills/demo-skill/SKILL.md');
    expect(copy).not.toContain('\r');
    expect(copy).toContain('Línea con CRLF\n');
  });

  it('marca cada Markdown generado con su fuente, debajo del frontmatter', async () => {
    await runSync(root, { check: false });
    const copy = await read('.claude/skills/demo-skill/SKILL.md');
    expect(copy).toMatch(
      /^---\nname: demo-skill\ndescription: Skill de prueba\n---\n<!-- GENERADO por ai-hub sync desde \.ai-hub\/skills\/shared\/demo-skill\/SKILL\.md — no editar -->\n/,
    );
  });

  it('genera el agente para Claude con sus claves y para OpenCode como subagente, con el mismo cuerpo', async () => {
    await runSync(root, { check: false });
    const claude = await read('.claude/agents/demo-agent.md');
    const opencode = await read('.opencode/agents/demo-agent.md');
    expect(claude).toContain('name: demo-agent');
    expect(claude).toContain('tools:');
    expect(opencode).toContain('mode: subagent');
    expect(opencode).not.toContain('tools:');
    expect(claude.endsWith('# Cuerpo del agente\n')).toBe(true);
    expect(opencode.endsWith('# Cuerpo del agente\n')).toBe(true);
  });

  it('genera las reglas por carpeta y la regla core para Cursor y Copilot', async () => {
    await runSync(root, { check: false });
    expect(await read('frontend/AGENTS.md')).toContain('# Frontend');
    expect(await read('.claude/rules/frontend.md')).toContain('paths:');
    expect(await read('.cursor/rules/frontend.mdc')).toContain('globs: frontend/**');
    expect(await read('.github/instructions/core.instructions.md')).toContain('applyTo: "**"');
    expect(await read('.cursor/rules/core.mdc')).toContain('alwaysApply: true');
  });

  it('genera la configuración MCP de cada cliente en su formato y sin claves', async () => {
    await runSync(root, { check: false });
    const claude = JSON.parse(await read('.mcp.json'));
    const cursor = JSON.parse(await read('.cursor/mcp.json'));
    const vscode = JSON.parse(await read('.vscode/mcp.json'));
    const opencode = JSON.parse(await read('opencode.json'));
    expect(claude.mcpServers.notion).toEqual({ type: 'http', url: 'https://mcp.notion.com/mcp' });
    expect(claude.mcpServers.playwright).toEqual({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] });
    expect(cursor.mcpServers.notion).toEqual({ url: 'https://mcp.notion.com/mcp' });
    expect(vscode.servers.playwright.type).toBe('stdio');
    expect(opencode.instructions).toEqual(['.ai-hub/rules/core.md']);
    expect(opencode.mcp.playwright).toEqual({ type: 'local', command: ['npx', '-y', '@playwright/mcp@0.0.83'], enabled: true });
    expect(opencode.mcp.notion.type).toBe('remote');
    expect(Object.keys(claude.mcpServers)).toEqual(['notion', 'playwright']);
  });

  it('elimina los destinos que ya no están en el manifest', async () => {
    await runSync(root, { check: false });
    const reduced = MANIFEST.replace('      - demo-skill\n', '      - demo-skill-none\n');
    await write('.ai-hub/manifest.yaml', reduced);
    await write('.ai-hub/skills/shared/demo-skill-none/SKILL.md', SKILL_SOURCE);
    const result = await runSync(root, { check: false });
    expect(result.removed).toContain('.claude/skills/demo-skill/SKILL.md');
    await expect(fs.access(path.join(root, '.claude/skills/demo-skill/SKILL.md'))).rejects.toThrow();
  });

  it('rechaza un agente sin name o description en su frontmatter', async () => {
    await write('.ai-hub/agents/demo-agent.md', '# Sin frontmatter\n');
    await expect(runSync(root, { check: false })).rejects.toThrow(/sin frontmatter/);
  });
});

describe('runSync: comprobación', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-sync-check-'));
    await seed();
    await runSync(root, { check: false });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('no escribe nada en modo comprobación', async () => {
    await fs.rm(path.join(root, '.claude/agents/demo-agent.md'));
    const before = await fs.readdir(path.join(root, '.claude/agents'));
    await runSync(root, { check: true });
    expect(await fs.readdir(path.join(root, '.claude/agents'))).toEqual(before);
  });

  it('detecta una copia que falta y nombra su fuente', async () => {
    await fs.rm(path.join(root, '.claude/agents/demo-agent.md'));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('falta .claude/agents/demo-agent.md (fuente: .ai-hub/agents/demo-agent.md)');
  });

  it('detecta una copia desactualizada cuando cambia la fuente', async () => {
    await write('.ai-hub/agents/demo-agent.md', AGENT_SOURCE.replace('Cuerpo del agente', 'Cuerpo nuevo'));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('desactualizado: .claude/agents/demo-agent.md');
  });

  it('detecta una edición a mano usando el lock y nombra la fuente a editar', async () => {
    await write('.claude/skills/demo-skill/SKILL.md', (await read('.claude/skills/demo-skill/SKILL.md')) + 'edición\n');
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain(
      'editado a mano: .claude/skills/demo-skill/SKILL.md (edita la fuente: .ai-hub/skills/shared/demo-skill/SKILL.md)',
    );
  });

  it('sugiere ai:openspec-upgrade cuando se edita a mano una skill openspec-*', async () => {
    await write('.claude/skills/openspec-demo/SKILL.md', 'cambiado por openspec update\n');
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('npm run ai:openspec-upgrade');
  });

  it('rechaza enlaces simbólicos dentro de las carpetas generadas', async () => {
    await fs.symlink(path.join(root, '.ai-hub/skills/shared/demo-skill'), path.join(root, '.claude/skills/enlace'));
    const result = await runSync(root, { check: true });
    expect(result.problems.join('\n')).toContain('enlace simbólico no permitido: .claude/skills/enlace');
  });

  it('sin diferencias devuelve cero problemas', async () => {
    const result = await runSync(root, { check: true });
    expect(result.problems).toEqual([]);
  });
});
