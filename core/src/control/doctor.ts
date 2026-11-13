import type { ProjectManifest } from '../manifest/manifest.js';
import { DECLARE_TRACKER_ACTION } from '../cli/integrations.js';
import { controlSettings } from './ledger.js';
import type { HermesCli } from './hermes.js';
import { resolveListener } from './listener.js';
import { probeWebhook, type ProbeResult } from './webhook-config.js';

export interface ControlCheck {
  id: 'control';
  ok: boolean;
  detail: string;
}

export interface ControlWebhookCheck {
  id: 'control:webhook';
  ok: boolean;
  detail: string;
}

export interface ControlWebhookInput {
  /** Hogar de Hermes (`hermesHome`). */
  home: string;
  /** Sonda del puerto; por defecto `GET /health` real. */
  probe?: (port: number) => Promise<ProbeResult>;
  profile?: string;
  /** CLI de Hermes ya resuelto; sin él solo cuentan los archivos y el puerto. */
  cli?: HermesCli | null;
}

/**
 * Check `control:webhook` de `doctor` (webhook-operativo 4.3): distingue «declarado» de «escuchando». El dueño del
 * listener, el bloque y el puerto salen de `resolveListener`, el mismo resolvedor del enrolamiento y de
 * `control enroll --check` (fabrica-verificable §D1). Sin bloque, el webhook es opcional y no falla: el tick es el
 * camino principal.
 */
export async function checkControlWebhook(input: ControlWebhookInput): Promise<ControlWebhookCheck> {
  const profile = input.profile ?? 'hermes-control';
  const view = await resolveListener({
    cli: input.cli ?? null,
    home: input.home,
    profile,
    route: 'ai-hub-gitlab',
    probe: input.probe ?? ((port: number) => probeWebhook(port)),
    crossCheckList: false,
  });
  const block = view.block;
  if (block.kind === 'malformed') {
    return { id: 'control:webhook', ok: false, detail: `${view.paths.config} ${block.problem}` };
  }
  if (block.kind !== 'enabled') {
    return { id: 'control:webhook', ok: true, detail: 'no configurado (opcional: el tick es el camino principal de ingesta)' };
  }
  const health = view.health === 'not-probed' ? await (input.probe ?? ((port: number) => probeWebhook(port)))(block.port) : view.health;
  if (health === 'listening') {
    return { id: 'control:webhook', ok: true, detail: `habilitado y escuchando en 127.0.0.1:${block.port} (perfil ${view.owner})` };
  }
  if (health === 'foreign') {
    return { id: 'control:webhook', ok: false, detail: `el puerto ${block.port} está ocupado por otro proceso (perfil ${view.owner}); libéralo o cambia platforms.webhook.extra.port` };
  }
  return { id: 'control:webhook', ok: false, detail: `declarado en ${view.paths.config} pero no escucha en 127.0.0.1:${block.port}; reinicia con ${view.restartText}` };
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
    return { id: 'control', ok: false, detail: `manifest.control necesita manifest.tracker (GitLab) · con las claves en .ai-hub/.env: ${DECLARE_TRACKER_ACTION}` };
  }
  const summary = `ttl ${settings.ttlHours} h · expire ${settings.expire} · sondeo cada ${settings.pollMinutes} min`;
  if (settings.approvers.length === 0) {
    return { id: 'control', ok: true, detail: `aviso: approvers vacío, las aprobaciones están desactivadas · ${summary}` };
  }
  return { id: 'control', ok: true, detail: `${settings.approvers.length} aprobador(es) en Discord · ${summary}` };
}
