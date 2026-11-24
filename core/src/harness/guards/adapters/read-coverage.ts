import fs from 'node:fs/promises';
import path from 'node:path';
import { READ_OPT_OUT } from '../read-policy.js';

/**
 * Cobertura de la política de lectura (R-048, R-051, tarea 4.35) que informa `doctor`. El hook proyectado ejecuta
 * `npx --no-install ai-hub hook pre`; si ese evaluador no resuelve, el hook falla abierto y la política no es efectiva
 * en ese host. Solo los lectores reconocidos se evalúan: la shell arbitraria no está protegida.
 */

export interface CoverageInput {
  root: string;
  targets: string[];
  guardMode: 'shadow' | 'enforce';
  optOuts: string[];
  /** Hooks de Claude gestionados presentes. */
  claudeHooks: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

/** ¿Resuelve `npx --no-install ai-hub` (binario local del proyecto o en el PATH)? */
export async function evaluatorAvailable(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const names = platform === 'win32' ? ['ai-hub.cmd', 'ai-hub.exe', 'ai-hub'] : ['ai-hub'];
  for (const name of names) {
    if (await exists(path.join(root, 'node_modules', '.bin', name))) {
      return true;
    }
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      if (await exists(path.join(dir, name))) {
        return true;
      }
    }
  }
  return false;
}

export async function checkReadCoverage(input: CoverageInput): Promise<{ id: 'read-policy'; ok: boolean; detail: string }> {
  if (input.optOuts.includes(READ_OPT_OUT)) {
    return { id: 'read-policy', ok: true, detail: 'desactivada por policy.optOuts (las demás guardias siguen activas)' };
  }
  const available = await evaluatorAvailable(input.root, input.env, input.platform);
  const hosts: string[] = [];
  for (const target of input.targets) {
    if (!available && (target === 'claude' || target === 'opencode')) {
      hosts.push(`${target}: no efectiva (el hook no puede ejecutar el evaluador: npx --no-install ai-hub no resuelve; el host continúa sin la política)`);
    } else if (target === 'claude') {
      hosts.push(input.claudeHooks ? 'claude: efectiva (lecturas, ediciones, búsquedas y lectores de shell reconocidos)' : 'claude: no efectiva (faltan los hooks gestionados)');
    } else if (target === 'opencode') {
      hosts.push(`opencode: aviso por mensaje y telemetría; ${input.guardMode === 'enforce' ? 'el bloqueo desde el hook no está verificado (opencode_block_unverified)' : 'shadow no bloquea'}`);
    } else {
      hosts.push(`${target}: no efectiva (el host no admite hooks)`);
    }
  }
  return {
    id: 'read-policy',
    ok: true,
    detail: `modo ${input.guardMode}; ${hosts.join('; ')}; la shell arbitraria no está protegida: solo se evalúan los lectores reconocidos`,
  };
}
