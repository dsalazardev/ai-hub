import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEngine } from '../engine/engine.js';
import { listRuns, RUN_SCHEMA_VERSION, runVersion } from './runs.js';
import { danglingIndexEntries, STATE_DIR, STATE_TYPES, StateCorruptError, StateVersionError } from './state-store.js';

/**
 * Versión mínima compatible (VMC, R-114, R-106). La VMC se declara una sola vez en `engine.yaml` ›
 * `compatibility.minimum`; este módulo es su único lector. El aviso de `install`/`upgrade` se emite antes
 * de escribir estado nuevo, y `doctor` muestra la VMC y el estado más nuevo encontrado. Ninguno de los dos
 * afirma una recuperación que no existe: la telemetría podada por un binario anterior no se recupera.
 */

export async function compatibilityMinimum(): Promise<string> {
  return (await loadEngine()).compatibility.minimum;
}

/** Aviso previo a escribir estado nuevo (R-114): qué se pierde al volver por debajo de la VMC. */
export function compatWarning(minimum: string): string {
  return (
    `aviso: versión mínima compatible ${minimum}. Esta versión escribe telemetría runs v${RUN_SCHEMA_VERSION} y estado en ` +
    `${STATE_DIR}/; volver a un binario anterior a ${minimum} no está soportado: poda esa telemetría por nombre ` +
    `(no se recupera) y no lee concesiones ni asociaciones. Copia .ai-hub/runs/ a mano antes de volver atrás.`
  );
}

export interface NewestState {
  /** Versión más alta encontrada en los runs (null sin runs con versión). */
  runs: number | null;
  /** Archivos de estado duradero presentes, con su versión o su problema. */
  state: string[];
  /** Entradas del índice de ejecución cuyo run ya no existe. */
  dangling: string[];
}

export async function newestState(root: string): Promise<NewestState> {
  let runs: number | null = null;
  for (const run of await listRuns(root)) {
    const v = await runVersion(root, run);
    if (v !== null && (runs === null || v > runs)) {
      runs = v;
    }
  }
  const state: string[] = [];
  for (const type of STATE_TYPES) {
    const file = path.join(root, ...STATE_DIR.split('/'), `${type}.json`);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) {
      continue;
    }
    try {
      const v = (JSON.parse(text) as { v?: unknown }).v;
      state.push(`${type} v${typeof v === 'number' ? v : '?'}`);
    } catch {
      state.push(`${type} ilegible`);
    }
  }
  let dangling: string[] = [];
  try {
    dangling = await danglingIndexEntries(root);
  } catch (error) {
    if (!(error instanceof StateVersionError || error instanceof StateCorruptError)) {
      throw error;
    }
  }
  return { runs, state, dangling };
}

/** Comprobación informativa de `doctor`: la VMC (de `engine.yaml`) y el estado más nuevo encontrado. */
export async function checkCompatibility(root: string): Promise<{ id: 'compat'; ok: boolean; detail: string }> {
  const minimum = await compatibilityMinimum();
  const found = await newestState(root);
  const parts = [
    `versión mínima compatible ${minimum}`,
    `runs: ${found.runs === null ? 'sin runs' : `v${found.runs} como máximo`}`,
    `estado duradero: ${found.state.length === 0 ? 'ninguno' : found.state.join(', ')}`,
  ];
  if (found.dangling.length > 0) {
    parts.push(
      `aviso: ${found.dangling.length} entrada(s) del índice sin su run (${found.dangling.slice(0, 5).join(', ')}); ` +
        'la telemetría podada no se recupera; revisa las decisiones de esas ejecuciones',
    );
  }
  return { id: 'compat', ok: true, detail: parts.join('; ') };
}
