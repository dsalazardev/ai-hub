import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '../frontmatter.js';
import { TARGETS, isToolId } from '../sync/targets.js';
import { readAgentHeader, renderAgentHeader, WRITE_CAPABILITIES } from './header.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_AGENTS = path.join(__dirname, '..', '..', 'agents');

export interface CapabilityCheck {
  id: 'agents:capabilities';
  ok: boolean;
  detail: string;
}

/** Roles de solo lectura: revisores y refuters (por `role` o por su id de catálogo). */
export function isReadOnlyAgent(id: string, role: string | undefined): boolean {
  return (
    role === 'refuter' ||
    role === 'reviewer' ||
    id.startsWith('reviewer-') ||
    id.endsWith('-reviewer') ||
    id.startsWith('refuter-') ||
    id === 'finding-verifier'
  );
}

async function agentData(root: string | null, source: string | null, id: string): Promise<Record<string, unknown> | null> {
  const candidates = [
    ...(root !== null && source !== null ? [path.join(root, ...source.split('/'), `${id}.md`)] : []),
    path.join(ENGINE_AGENTS, `${id}.md`),
  ];
  for (const file of candidates) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text !== null) {
      try {
        return splitFrontmatter(text, file).data;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * `agents:capabilities` (A3): falla si un agente de solo lectura declara escritura; informa lo que
 * cada destino no puede expresar (un límite de seguridad descartado en silencio es una falsa
 * garantía), que Pi no tiene subagentes y el duplicado de Cursor con `.claude/agents`.
 */
export async function checkAgentCapabilities(input: {
  root: string | null;
  source: string | null;
  agents: string[];
  targets: string[];
}): Promise<CapabilityCheck> {
  const violations: string[] = [];
  const degraded = new Map<string, Map<string, number>>();
  const notes: string[] = [];
  for (const id of input.agents) {
    const data = await agentData(input.root, input.source, id);
    if (data === null) {
      continue;
    }
    const header = readAgentHeader(data);
    if (isReadOnlyAgent(id, header.role) && (header.capabilities ?? []).some((cap) => WRITE_CAPABILITIES.includes(cap))) {
      violations.push(`${id} es de solo lectura y declara ${(header.capabilities ?? []).filter((cap) => WRITE_CAPABILITIES.includes(cap)).join('/')}`);
    }
    for (const target of input.targets) {
      if (!isToolId(target)) {
        continue;
      }
      const format = TARGETS[target].agentFormat;
      if (format === null) {
        continue;
      }
      const rendered = renderAgentHeader(format, { name: id, description: '' }, data, null);
      for (const key of rendered.degraded) {
        const byKey = degraded.get(target) ?? new Map<string, number>();
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
        degraded.set(target, byKey);
      }
    }
  }
  for (const target of input.targets) {
    if (isToolId(target) && TARGETS[target].agentFormat === null) {
      notes.push(`${target}: sin subagentes en el núcleo; los agentes no se proyectan (requiere una extensión de subagentes)`);
    }
  }
  if (input.targets.includes('cursor') && input.targets.includes('claude')) {
    notes.push('cursor: también lee .claude/agents; con ambos destinos Cursor ve cada agente dos veces y da precedencia a .cursor/agents');
  }
  for (const [target, byKey] of degraded) {
    notes.push(`${target}: no expresa ${[...byKey].map(([key, count]) => `${key} en ${count} agente(s)`).join(', ')}`);
  }
  if (violations.length > 0) {
    return { id: 'agents:capabilities', ok: false, detail: violations.join('; ') };
  }
  return {
    id: 'agents:capabilities',
    ok: true,
    detail: notes.length === 0 ? 'cabeceras proyectadas sin degradación' : notes.join('; '),
  };
}
