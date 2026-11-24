import fs from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from '../harness/state-store.js';

/**
 * Capacidades del advisor que necesitan aislamiento de herramientas (R-085): lectura del repositorio, creación de
 * issues, notas y peticiones de ejecución. Siguen desactivadas mientras no haya una verificación registrada para este
 * host y esta versión de Hermes (experimento 2.3 o frontera alternativa 2.8). Una verificación de otro host o versión
 * no vale. Incluso con una verificación válida, la habilitación es de las tareas condicionadas 5.3–5.5: aquí solo se
 * informa.
 */

export const ADVISOR_CAPABILITIES = ['repo_read', 'issue_create', 'issue_note', 'execution_request'] as const;
export type AdvisorCapability = (typeof ADVISOR_CAPABILITIES)[number];
export const ISOLATION_FILE = `${STATE_DIR}/advisor-isolation.json`;

export interface IsolationRecord {
  host: string;
  hermesVersion: string;
  boundary: 'hermes' | 'os-user' | 'container';
  verifiedAt: string;
  evidence: string;
}

export interface AdvisorCapabilityReport {
  enabled: AdvisorCapability[];
  lines: string[];
}

export async function readIsolation(root: string): Promise<IsolationRecord | null> {
  const text = await fs.readFile(path.join(root, ...ISOLATION_FILE.split('/')), 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    const record = JSON.parse(text) as Partial<IsolationRecord>;
    return typeof record.host === 'string' && typeof record.hermesVersion === 'string' ? (record as IsolationRecord) : null;
  } catch {
    return null;
  }
}

export async function advisorCapabilities(root: string, current: { host: string; hermesVersion: string | null }): Promise<AdvisorCapabilityReport> {
  const record = await readIsolation(root);
  let why: string;
  if (record === null) {
    why = 'falta la verificación de aislamiento del perfil hermes-advisor (experimento 2.3 o frontera alternativa 2.8)';
  } else if (record.host !== current.host || record.hermesVersion !== current.hermesVersion) {
    why = `la verificación registrada es de ${record.host} con Hermes ${record.hermesVersion}; este host es ${current.host} con Hermes ${current.hermesVersion ?? 'desconocido'}`;
  } else {
    why = `aislamiento verificado (${record.boundary}, ${record.verifiedAt}); la habilitación es de las tareas condicionadas 5.3–5.5`;
  }
  return { enabled: [], lines: ADVISOR_CAPABILITIES.map((capability) => `${capability}: desactivada (${why})`) };
}
