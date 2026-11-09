import type { ProjectManifest } from '../manifest/manifest.js';
import { controlSettings } from './ledger.js';

export interface ControlCheck {
  id: 'control';
  ok: boolean;
  detail: string;
}

/**
 * Check `control` de `doctor` (hermes-control 4.4): sin `manifest.control` informa "no configurado" sin
 * degradar; con él, resume aprobadores, caducidad y sondeo. Nunca lee credenciales.
 */
export function checkControl(manifest: ProjectManifest | null): ControlCheck {
  const settings = manifest ? controlSettings(manifest) : null;
  if (settings === null) {
    return { id: 'control', ok: true, detail: 'no configurado (manifest.control es opcional)' };
  }
  if (!manifest?.tracker) {
    return { id: 'control', ok: false, detail: 'manifest.control necesita manifest.tracker (GitLab)' };
  }
  const summary = `ttl ${settings.ttlHours} h · expire ${settings.expire} · sondeo cada ${settings.pollMinutes} min`;
  if (settings.approvers.length === 0) {
    return { id: 'control', ok: true, detail: `aviso: approvers vacío, las aprobaciones están desactivadas · ${summary}` };
  }
  return { id: 'control', ok: true, detail: `${settings.approvers.length} aprobador(es) en Discord · ${summary}` };
}
