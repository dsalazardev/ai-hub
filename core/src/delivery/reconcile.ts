import type { MergeEvidence } from '../control/tracker.js';
import { TrackerError } from '../control/tracker.js';
import { readAssociations, save, type Association } from './association.js';
import { cleanupAssociation, remoteDeleteCapability, remoteDeleteContext, reportClosedWithoutMerge } from './cleanup.js';

/**
 * Evidencia de merge y reconciliación de la entrega (R-073, R-076). La evidencia se guarda en la asociación con la
 * cabeza de origen integrada y el commit resultante por separado; un tracker inalcanzable no registra ni limpia. La
 * reconciliación es idempotente y la disparan el evento, cada poll del control y el arranque: un merge ocurrido con
 * el host apagado se limpia una sola vez al volver.
 */

export interface MergeSource {
  mergeEvidence(iid: number): Promise<MergeEvidence>;
}

export type MergeRecord = { recorded: true; association: Association } | { recorded: false; detail: string };

/** Registra la evidencia del CR de la asociación de `iid` (4.64). */
export async function recordMergeEvidence(root: string, iid: number, source: MergeSource): Promise<MergeRecord> {
  const entry = Object.entries(await readAssociations(root)).find(([, item]) => item.iid === iid);
  if (entry === undefined || entry[1].changeRequest === null) {
    return { recorded: false, detail: `#${iid}: sin asociación con petición de cambio; nada que registrar` };
  }
  const [key, association] = entry;
  let evidence: MergeEvidence;
  try {
    evidence = await source.mergeEvidence(association.changeRequest!.id);
  } catch (error) {
    if (error instanceof TrackerError) {
      return { recorded: false, detail: `#${iid}: tracker inalcanzable (${error.failureClass}); no se registra ni se limpia` };
    }
    throw error;
  }
  if (evidence.state !== 'merged') {
    return { recorded: false, detail: `#${iid}: la petición de cambio está ${evidence.state}; sin merge que registrar` };
  }
  if (evidence.sourceHead === null) {
    return { recorded: false, detail: `#${iid}: el tracker no da la cabeza de origen integrada; no se registra ni se limpia` };
  }
  const next: Association = { ...association, merge: { sourceHead: evidence.sourceHead, result: evidence.result } };
  await save(root, key, next);
  return { recorded: true, association: next };
}

/** Reconciliación de todas las asociaciones con petición de cambio (4.67). Devuelve líneas para la persona. */
export async function reconcileDeliveries(root: string, source: MergeSource & { changeRequestState?(id: number): Promise<string> }): Promise<string[]> {
  const lines: string[] = [];
  for (const association of Object.values(await readAssociations(root))) {
    if (association.changeRequest === null) {
      continue;
    }
    const done = association.steps.cleanup;
    if (done.worktree !== undefined && done.worktree !== 'kept' && done.branch !== undefined && done.branch !== 'kept') {
      continue;
    }
    const merged = await recordMergeEvidence(root, association.iid, source);
    if (!merged.recorded) {
      if (merged.detail.includes('está closed')) {
        const closed = await reportClosedWithoutMerge(root, association.iid);
        if (closed !== null) {
          lines.push(closed);
        }
      } else if (merged.detail.includes('inalcanzable') || merged.detail.includes('cabeza de origen')) {
        lines.push(merged.detail);
      }
      continue;
    }
    // R-108: el paso remoto solo con capacidad declarada para el tracker; si no, la rama remota se conserva.
    const report = await cleanupAssociation(root, association.branch, association.iid, merged.association.merge!.sourceHead, remoteDeleteCapability(association.kind, remoteDeleteContext(root)) ? { remote: { name: 'origin' } } : {});
    lines.push(`#${association.iid}: limpieza tras el merge: worktree ${report.worktree}, rama ${report.branch}, remoto ${report.remote}${report.notes.length > 0 ? ` (${report.notes.join('; ')})` : ''}`);
  }
  return lines;
}
