import type { ProjectManifest } from '../manifest/manifest.js';
import path from 'node:path';
import { controlSettings } from './ledger.js';
import { probeWebhook, readWebhookBlock, type ProbeResult } from './webhook-config.js';

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
}

/**
 * Check `control:webhook` de `doctor` (webhook-operativo 4.3): distingue «declarado» de «escuchando». Solo lee los
 * `config.yaml` del perfil de control y del perfil por defecto (el dueño del listener bajo el multiplexor) y sondea el
 * puerto local. Sin bloque, el webhook es opcional y no falla: el tick es el camino principal.
 */
export async function checkControlWebhook(input: ControlWebhookInput): Promise<ControlWebhookCheck> {
  const profile = input.profile ?? 'hermes-control';
  const candidates: Array<[string, string]> = [
    [profile, path.join(input.home, 'profiles', profile, 'config.yaml')],
    ['default', path.join(input.home, 'config.yaml')],
  ];
  for (const [owner, file] of candidates) {
    const block = await readWebhookBlock(file);
    if (block.kind === 'malformed') {
      return { id: 'control:webhook', ok: false, detail: `${file} ${block.problem}` };
    }
    if (block.kind !== 'enabled') {
      continue;
    }
    const restart = owner === 'default' ? 'hermes gateway restart' : `hermes -p ${owner} gateway restart`;
    const result = await (input.probe ?? ((port: number) => probeWebhook(port)))(block.port);
    if (result === 'listening') {
      return { id: 'control:webhook', ok: true, detail: `habilitado y escuchando en 127.0.0.1:${block.port} (perfil ${owner})` };
    }
    if (result === 'foreign') {
      return { id: 'control:webhook', ok: false, detail: `el puerto ${block.port} está ocupado por otro proceso (perfil ${owner}); libéralo o cambia platforms.webhook.extra.port` };
    }
    return { id: 'control:webhook', ok: false, detail: `declarado en ${file} pero no escucha en 127.0.0.1:${block.port}; reinicia con ${restart}` };
  }
  return { id: 'control:webhook', ok: true, detail: 'no configurado (opcional: el tick es el camino principal de ingesta)' };
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
