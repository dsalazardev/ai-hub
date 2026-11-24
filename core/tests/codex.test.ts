import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAgentCapabilities } from '../src/agents/doctor.js';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { writeInventory } from '../src/manifest/manifest.js';
import { loadSyncConfig } from '../src/sync/config.js';
import { renderAll, renderCodexHooks } from '../src/sync/render.js';
import { runSync } from '../src/sync/sync.js';
import { ALL_TOOL_IDS, TOOL_IDS } from '../src/sync/targets.js';
import { listProposals } from '../src/writes/proposals.js';
import { seedFixture } from './fixtures.js';
import { fakeRunner } from './speckit-fake.js';

/** Destino Codex (4.78–4.81, R-089, R-090): proyección, TOML, regresión de los cinco destinos y hooks verificados. */

/** Huella de lo que generan los cinco destinos con el código anterior a Codex (medida antes del cambio). */
const FIVE_TARGET_BASELINE = { files: 64, sha256: '6a5a5a8069031ea0b12edeaa19ffa7aa44d8bb0cbc96237374287e57b9094dd5' };

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-codex-'));
  await seedFixture(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function withCodex(skill = true): Promise<void> {
  const file = path.join(root, 'manifest.yaml');
  const manifest = parse(await fs.readFile(file, 'utf8')) as { targets: string[]; skills: { source: string; publish: string[] } };
  manifest.targets = [...manifest.targets, 'codex'];
  // Una skill de proyecto, para comprobar que llega a `.agents/skills`.
  if (skill) {
  const skillDir = path.join(root, ...manifest.skills.source.split('/'), 'demo-codex');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo-codex\ndescription: Skill de prueba para el destino Codex.\n---\n\n# Demo\n\nCuerpo.\n');
  manifest.skills.publish = [...manifest.skills.publish, 'demo-codex'];
  }
  await fs.writeFile(file, stringify(manifest));
  await writeInventory(root);
}

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => out.push(line) };
  const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
  return { code, out: out.join('\n') };
}

describe('regresión de los cinco destinos existentes (4.80)', () => {
  it('declarar codex no cambia ni un byte de lo que generan los cinco destinos', async () => {
    // La huella fijada antes de Codex (FIVE_TARGET_BASELINE) dejó de servir cuando el texto de la regla generada
    // cambió por la corrección de los umbrales de delegación; la invariante que exige R-089 es esta: los archivos
    // de los cinco destinos son idénticos con y sin el destino codex declarado.
    await writeInventory(root);
    const five = await renderAll(root, await loadSyncConfig(root));
    await withCodex(false);
    const six = await renderAll(root, await loadSyncConfig(root));
    expect([...five.keys()].length).toBe(FIVE_TARGET_BASELINE.files);
    for (const [rel, file] of five) {
      expect(six.get(rel)?.content, rel).toBe(file.content);
    }
    expect([...six.keys()].filter((rel) => !five.has(rel)).every((rel) => rel.startsWith('.agents/') || rel.startsWith('.codex/') || rel === 'AGENTS.md')).toBe(true);
  });

  it('codex es opt-in: init y el asistente siguen eligiendo los cinco destinos por defecto', () => {
    expect([...TOOL_IDS]).toEqual(['claude', 'opencode', 'pi', 'cursor', 'copilot']);
    expect(ALL_TOOL_IDS).toContain('codex');
  });
});

describe('proyección de Codex (4.78, R-089)', () => {
  it('skills en .agents/skills, agentes TOML en .codex/agents y región de AGENTS.md nuevo, todo en el lock', async () => {
    await withCodex();
    const result = await runSync(root, { check: false });
    expect(result.pending).toEqual([]);
    const lock = JSON.parse(await fs.readFile(path.join(root, 'sync.lock.json'), 'utf8')) as { files: Record<string, { region?: string }> };
    const files = Object.keys(lock.files);
    expect(files).toContain('.agents/skills/demo-codex/SKILL.md');
    expect(files.some((file) => file.startsWith('null/'))).toBe(false);
    expect(files.filter((file) => file.startsWith('.codex/agents/') && file.endsWith('.toml')).length).toBeGreaterThan(0);
    expect(lock.files['AGENTS.md']?.region).toBe('ai-hub');
    const agentsMd = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('## Contrato de cierre');
    expect(agentsMd).toContain('## Delegación');
  });

  it('un AGENTS.md ajeno existente no se edita: queda una propuesta', async () => {
    await withCodex();
    const foreign = '# Instrucciones del equipo\n';
    await fs.writeFile(path.join(root, 'AGENTS.md'), foreign);
    const result = await runSync(root, { check: false });
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(foreign);
    expect(result.pending.join('\n')).toContain('AGENTS.md');
    expect((await listProposals(root)).some((proposal) => proposal.capability === 'managed-region')).toBe(true);
  });
});

describe('agentes TOML con capacidades degradadas declaradas (4.79, R-090)', () => {
  it('un revisor de solo lectura se genera en TOML y doctor declara que solo lectura no se aplica', async () => {
    await withCodex();
    await runSync(root, { check: false });
    const toml = await fs.readFile(path.join(root, '.codex', 'agents', 'reviewer-architecture.toml'), 'utf8');
    const values = Object.fromEntries(
      toml
        .split('\n')
        .filter((line) => /^[a-z_]+ = /.test(line))
        .map((line) => [line.slice(0, line.indexOf(' = ')), JSON.parse(line.slice(line.indexOf(' = ') + 3)) as string]),
    );
    expect(values.name).toBe('reviewer-architecture');
    expect(values.description.length).toBeGreaterThan(0);
    expect(values.developer_instructions.length).toBeGreaterThan(20);
    expect(toml).not.toMatch(/sandbox_mode|readonly/);
    const check = await checkAgentCapabilities({ root: null, source: null, agents: ['reviewer-architecture'], targets: ['codex'] });
    expect(JSON.stringify(check)).toContain('no se aplican por archivo de agente');
  });
});

describe('hooks de Codex solo con formato verificado (4.81, R-089)', () => {
  it('sin formato verificado no se escribe ningún hook y doctor declara que Codex no tiene hooks', async () => {
    await withCodex();
    await runSync(root, { check: false });
    await expect(fs.access(path.join(root, '.codex', 'hooks.json'))).rejects.toThrow();
    const doctor = await cli(['doctor']);
    expect(doctor.out).toContain('codex: sin hooks (formato no verificado');
  });

  it('con un formato verificado declarado, se proyecta lo que esa declaración define', async () => {
    await withCodex();
    const out = new Map();
    renderCodexHooks(await loadSyncConfig(root), out, [
      { range: '>=9.9.9', evidence: 'declaración de prueba', path: '.codex/hooks.json', render: (command) => `${JSON.stringify({ pre: command })}\n` },
    ]);
    expect(out.get('.codex/hooks.json')?.content).toContain('npx --no-install ai-hub hook pre');
  });
});
