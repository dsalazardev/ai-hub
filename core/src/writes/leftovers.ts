import fs from 'node:fs/promises';
import path from 'node:path';
import { isTransactionTemp } from './transaction.js';

/**
 * Temporales huérfanos de escrituras interrumpidas (R-025, tarea 4.5): al arrancar, `doctor` los informa por
 * nombre (nunca su contenido). El destino válido sigue intacto; el temporal no se usa ni se borra solo.
 */

const SKIP = new Set(['.git', 'node_modules']);

async function scan(dir: string, depth: number, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !SKIP.has(entry.name)) {
        await scan(full, depth - 1, out);
      }
    } else if (isTransactionTemp(entry.name)) {
      out.push(full);
    }
  }
}

/** Busca en la raíz, `.ai-hub/`, `.claude/` y los perfiles de Hermes, con profundidad acotada. */
export async function findLeftovers(root: string, hermesHome: string | null): Promise<string[]> {
  const found: string[] = [];
  await scan(root, 0, found);
  await scan(path.join(root, '.ai-hub'), 4, found);
  await scan(path.join(root, '.claude'), 1, found);
  if (hermesHome !== null) {
    await scan(hermesHome, 2, found);
  }
  return [...new Set(found)].sort();
}

export async function checkLeftovers(root: string, hermesHome: string | null): Promise<{ id: 'leftover-temps'; ok: boolean; detail: string }> {
  const found = await findLeftovers(root, hermesHome);
  if (found.length === 0) {
    return { id: 'leftover-temps', ok: true, detail: 'sin temporales de escrituras interrumpidas' };
  }
  return {
    id: 'leftover-temps',
    ok: true,
    detail: `aviso: ${found.length} temporal(es) de una escritura interrumpida (el destino válido está intacto; no se usan): ${found.join(', ')}; revísalos y bórralos a mano`,
  };
}
