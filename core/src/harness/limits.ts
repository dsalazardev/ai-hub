import type { ProjectManifest } from '../manifest/manifest.js';
import { listRuns, readRunEvents } from './runs.js';
import { READ_OPT_OUT } from './guards/read-policy.js';

/**
 * Límites de comprobación automática (R-115, design.md › Límites de comprobación automática). Cada límite se
 * informa con tres hechos separados: capacidad (esta versión tiene el mecanismo), configuración (el proyecto lo
 * habilita) y resultado observado (última observación). Sin observación el código es `evidence_missing`, nunca el
 * del límite, y ningún límite se presenta como cumplimiento.
 */

export interface LimitStatus {
  code: string;
  requirement: string;
  capability: boolean;
  configuration: 'habilitado' | 'deshabilitado' | 'no aplica';
  observed: string | null;
}

/** Última nota `guard` de la telemetría (sin ruta ni contenido: solo patrón, acción y herramienta). */
async function lastGuardNote(root: string): Promise<string | null> {
  let last: { ts: string; note: string } | null = null;
  for (const run of await listRuns(root)) {
    for (const event of await readRunEvents(root, run)) {
      if (event.note_type === 'guard' && typeof event.note === 'string' && (last === null || event.ts > last.ts)) {
        last = { ts: event.ts, note: event.note };
      }
    }
  }
  return last === null ? null : `${last.ts} ${last.note}`;
}

export async function verificationLimits(root: string, manifest: ProjectManifest): Promise<LimitStatus[]> {
  const readPolicy = !manifest.policy.optOuts.includes(READ_OPT_OUT);
  return [
    { code: 'guard_coverage_limited', requirement: 'R-051', capability: true, configuration: readPolicy ? 'habilitado' : 'deshabilitado', observed: readPolicy ? await lastGuardNote(root) : null },
    { code: 'writer_gate_limited', requirement: 'R-042', capability: true, configuration: 'no aplica', observed: null },
    { code: 'durability_limited', requirement: 'R-036', capability: true, configuration: 'no aplica', observed: null },
    { code: 'host_credentials_unmanaged', requirement: 'R-072', capability: true, configuration: 'no aplica', observed: null },
    { code: 'delegation_unenforced', requirement: 'R-049, R-054', capability: true, configuration: 'no aplica', observed: null },
    { code: 'context_use_unobserved', requirement: 'R-100', capability: false, configuration: 'no aplica', observed: null },
    { code: 'registry_same_user_limit', requirement: 'R-093', capability: false, configuration: 'no aplica', observed: null },
    { code: 'fail_closed_fixture_only', requirement: 'R-028', capability: true, configuration: 'no aplica', observed: null },
    { code: 'external_guard_reduced', requirement: 'R-105', capability: true, configuration: 'no aplica', observed: null },
  ];
}

/** Línea de `doctor` por límite; nunca «cumple». */
export function describeLimit(limit: LimitStatus): string {
  const observed = limit.observed === null ? 'evidence_missing (sin observación todavía)' : `observado ${limit.observed}`;
  return `${limit.code} (${limit.requirement}): capacidad ${limit.capability ? 'sí' : 'no'}; configuración ${limit.configuration}; ${observed}`;
}
