import { sharedLockPath, withLock, type LockOptions } from '../harness/lock.js';
import type { ProjectManifest } from '../manifest/manifest.js';
import { trackerCapability, type CapabilityResult } from './capabilities.js';

/**
 * Política de escritura de etiquetas (R-004, R-111, R-112, D-48, SC-01).
 *
 * Sin actualización condicional declarada por el adaptador (ninguno la declara hoy), toda operación que
 * mueve etiqueta se RETIENE por defecto, también en instalaciones existentes: `label_update_unprotected`.
 *
 * El modo `control.labels.mode: unprotected` es opt-in por proyecto y no lo activa ninguna instalación
 * por defecto. NO ofrece garantía atómica remota: su lock (tracker + proyecto + iid, en el directorio de
 * locks del usuario) solo coordina a los escritores del motor de este host —procesos y worktrees—; no a
 * la interfaz web, a otros hosts ni a clientes externos. La relectura y la escritura siguen siendo dos
 * peticiones. No satisface #1-C6 ni #3-C9. Cada escritura se registra como `label_update_unprotected`.
 */

export type LabelMode = 'withhold' | 'unprotected';

export type LabelPermit =
  | { kind: 'protected'; capability: CapabilityResult }
  | { kind: 'unprotected'; capability: CapabilityResult }
  | { kind: 'withheld'; capability: CapabilityResult };

export const LABEL_LOCK_WAIT_MS = 10_000;

export function labelMode(manifest: ProjectManifest): LabelMode {
  return manifest.control?.labels?.mode ?? 'withhold';
}

/** Producto del tracker configurado (hoy solo GitLab; GitHub llega con 4.68). */
function product(manifest: ProjectManifest): 'gitlab' | 'github' {
  return manifest.tracker?.kind ?? 'gitlab';
}

export function labelPermit(manifest: ProjectManifest, trackerVersion: string | null = null): LabelPermit {
  const capability = trackerCapability(product(manifest), 'conditional_label_update', trackerVersion);
  if (capability.available) {
    return { kind: 'protected', capability };
  }
  return labelMode(manifest) === 'unprotected' ? { kind: 'unprotected', capability } : { kind: 'withheld', capability };
}

/** Lock compartido por la identidad completa de la issue: el iid solo no es único. */
export function issueLockPath(trackerBase: string, project: string, iid: number, env: NodeJS.ProcessEnv = process.env): string {
  return sharedLockPath(`label|${trackerBase.replace(/\/+$/, '').toLowerCase()}|${project}|${iid}`, env);
}

export async function withIssueLock<T>(trackerBase: string, project: string, iid: number, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const configured = Number.parseInt(process.env.AI_HUB_LABEL_LOCK_WAIT_MS ?? '', 10);
  const waitMs = Number.isInteger(configured) && configured >= 0 ? configured : LABEL_LOCK_WAIT_MS;
  return withLock(issueLockPath(trackerBase, project, iid), `etiqueta #${iid}`, fn, { waitMs, ...options });
}

export const WITHHELD_TEXT = 'label_update_unprotected: el tracker no ofrece actualización condicional verificada; el movimiento de etiqueta se retiene';
export const UNPROTECTED_TEXT = 'label_update_unprotected: escrito sin garantía atómica remota (el lock no coordina la interfaz web, otros hosts ni clientes externos)';
