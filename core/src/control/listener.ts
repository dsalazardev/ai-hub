import fs from 'node:fs/promises';
import path from 'node:path';
import type { HermesCli } from './hermes.js';
import { DEFAULT_WEBHOOK_PORT, readWebhookBlock, type ProbeResult, type WebhookBlock } from './webhook-config.js';

/**
 * fabrica-verificable (design §D1): un único resolvedor, de solo lectura, del listener del webhook. Lo consumen el
 * enrolamiento (camino de escritura), `control enroll --check` y `doctor`, para que los tres decidan igual quién es el
 * dueño del listener, si la plataforma está habilitada, si el puerto responde y si la ruta existe.
 *
 * La ruta se lee del store del dueño (`webhook_subscriptions.json`), que es el archivo que carga el propio listener;
 * `hermes webhook list` queda como contraste: su fallo es un aviso, nunca un componente fallido. El secreto de una
 * ruta no sale jamás de este módulo: del store solo se extraen nombres, el perfil ligado y la presencia del secreto.
 */
export interface Topology {
  state: 'not-installed' | 'stopped' | 'running';
  /** Perfil dueño del listener: `default` bajo el multiplexor, el propio perfil con gateway dedicado. */
  owner: string;
  /** El dueño es otro perfil: su configuración y su reinicio afectan a todos los perfiles que sirve. */
  shared: boolean;
}

/**
 * Topología según `hermes -p <perfil> gateway status` (solo lectura). «via the default-profile multiplexer» significa
 * que el listener es del perfil de lanzamiento (`gateway/run_adapters.py:1314-1321`).
 */
export async function gatewayTopology(cli: HermesCli, profile: string): Promise<Topology> {
  const result = await cli.run(['-p', profile, 'gateway', 'status']);
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.status === 0) {
    const shared = detail.includes('multiplexer');
    return { state: 'running', owner: shared ? 'default' : profile, shared };
  }
  return { state: detail.includes('not installed') ? 'not-installed' : 'stopped', owner: profile, shared: false };
}

export interface StoredRoute {
  /** Perfil al que quedó ligada la ruta (`--route-profile`), o `null` si el store no lo dice. */
  profile: string | null;
  hasSecret: boolean;
}

export type RouteStore = { kind: 'ok'; routes: Map<string, StoredRoute>; secrets: string[] } | { kind: 'absent' } | { kind: 'malformed' };

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Lector tolerante del store de rutas: un objeto `{ <ruta>: { profile?, secret?, … } }`, opcionalmente bajo una clave
 * `subscriptions` o `routes`. Cualquier otra forma es `malformed` y quien llama recurre a `webhook list`. `secrets`
 * existe solo para redactar; no se devuelve fuera del módulo.
 */
export async function readRouteStore(file: string): Promise<RouteStore> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'malformed' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { kind: 'malformed' };
  }
  const root = plain(data);
  if (root === null) {
    return { kind: 'malformed' };
  }
  const table = plain(root.subscriptions) ?? plain(root.routes) ?? root;
  const routes = new Map<string, StoredRoute>();
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(table)) {
    const entry = plain(value);
    if (entry === null) {
      return { kind: 'malformed' };
    }
    const secret = typeof entry.secret === 'string' ? entry.secret.trim() : '';
    if (secret !== '') {
      secrets.push(secret);
    }
    routes.set(name, { profile: typeof entry.profile === 'string' && entry.profile.trim() !== '' ? entry.profile.trim() : null, hasSecret: secret !== '' });
  }
  return { kind: 'ok', routes, secrets };
}

/** ¿Aparece el nombre en la salida de un `list` de Hermes? Palabra completa, no subcadena. */
export function listed(output: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, 'm').test(output);
}

export interface ListenerInput {
  /** `null`: `doctor` sin un Hermes resoluble; solo cuentan los archivos y el puerto. */
  cli: HermesCli | null;
  /** Hogar de Hermes (`hermesHome`). */
  home: string;
  profile: string;
  route: string;
  probe: (port: number) => Promise<ProbeResult>;
  /** Ejecuta `webhook list` como segunda opinión (por defecto, sí cuando hay CLI). */
  crossCheckList?: boolean;
}

export interface ListenerView {
  gateway: 'running' | 'stopped' | 'not-installed' | 'unknown';
  owner: string;
  shared: boolean;
  /** `status`: lo dijo `gateway status`; `evidence`: bloque + ruta ligada + puerto; `default`: sin nada mejor. */
  ownerSource: 'status' | 'evidence' | 'default';
  paths: { dir: string; config: string; env: string; subscriptions: string };
  command(args: string[]): string[];
  restartText: string;
  urlPath(route: string): string;
  block: WebhookBlock;
  port: number;
  health: ProbeResult | 'not-probed';
  route: 'present' | 'absent' | 'not-verifiable';
  routeSource: 'store' | 'list' | 'none';
  routeProfile: string | null;
  /** `webhook list` respondió 0 (la puerta del CLI de rutas da la plataforma por habilitada); `null` si no se ejecutó. */
  listOk: boolean | null;
  /** Avisos ya redactados. */
  notices: string[];
  topology: Topology;
}

interface Candidate {
  owner: string;
  shared: boolean;
  dir: string;
  block: WebhookBlock;
  store: RouteStore;
}

function sourceText(source: ListenerView['ownerSource']): string {
  return source === 'status' ? 'gateway status' : source === 'evidence' ? 'la evidencia: bloque, ruta ligada y puerto' : 'el perfil de control';
}

/** Línea que nombra al dueño del listener y de dónde sale esa conclusión. */
export function ownerLine(view: Pick<ListenerView, 'owner' | 'ownerSource'>): string {
  return `listener: dueño "${view.owner}" (según ${sourceText(view.ownerSource)})`;
}

function redact(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    out = out.split(secret).join('[REDACTADO]');
  }
  return out.replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTADO]');
}

/** ¿Liga el store la ruta al perfil de control? En el store propio del perfil, una ruta sin `profile` también cuenta. */
function bound(candidate: Candidate, route: string, profile: string): StoredRoute | null {
  if (candidate.store.kind !== 'ok') {
    return null;
  }
  const entry = candidate.store.routes.get(route);
  if (entry === undefined) {
    return null;
  }
  return entry.profile === profile || (entry.profile === null && !candidate.shared) ? entry : null;
}

export async function resolveListener(input: ListenerInput): Promise<ListenerView> {
  const { cli, home, profile, route, probe } = input;
  const notices: string[] = [];
  const candidate = async (owner: string): Promise<Candidate> => {
    const shared = owner !== profile;
    const dir = shared ? home : path.join(home, 'profiles', profile);
    return { owner, shared, dir, block: await readWebhookBlock(path.join(dir, 'config.yaml')), store: await readRouteStore(path.join(dir, 'webhook_subscriptions.json')) };
  };
  const probed = new Map<number, ProbeResult>();
  const probeOnce = async (port: number): Promise<ProbeResult> => {
    if (!probed.has(port)) {
      probed.set(port, await probe(port));
    }
    return probed.get(port)!;
  };
  const answers = async (item: Candidate): Promise<boolean> => item.block.kind === 'enabled' && (await probeOnce(item.block.port)) === 'listening';

  let topology: Topology = { state: 'stopped', owner: profile, shared: false };
  let gateway: ListenerView['gateway'] = 'unknown';
  let ownerSource: ListenerView['ownerSource'] = 'default';
  let chosen: Candidate;
  if (cli !== null) {
    topology = await gatewayTopology(cli, profile);
    gateway = topology.state;
  }
  if (cli !== null && topology.state === 'running') {
    chosen = await candidate(topology.owner);
    ownerSource = 'status';
  } else if (cli !== null && topology.state === 'not-installed') {
    chosen = await candidate(profile);
  } else {
    // El estado no respondió (o no hay CLI): decide la evidencia que usa el propio listener.
    const both = [await candidate(profile), await candidate('default')];
    const evident: Candidate[] = [];
    for (const item of both) {
      if (bound(item, route, profile) !== null && (await answers(item))) {
        evident.push(item);
      }
    }
    if (evident.length === 1) {
      chosen = evident[0];
      ownerSource = 'evidence';
      if (cli !== null) {
        gateway = 'running';
        topology = { state: 'running', owner: chosen.owner, shared: chosen.shared };
        notices.push(`aviso: hermes -p ${profile} gateway status no respondió 0; el dueño del listener se decidió por la evidencia (bloque habilitado, ruta ligada y puerto que responde)`);
      }
    } else if (cli === null) {
      // `doctor` sin CLI: el bloque cuyo puerto responde; si ninguno, el primero habilitado o malformado.
      let pick: Candidate | undefined;
      for (const item of both) {
        if (pick === undefined && (await answers(item))) {
          pick = item;
        }
      }
      chosen = pick ?? both.find((item) => item.block.kind === 'enabled' || item.block.kind === 'malformed') ?? both[0];
    } else {
      chosen = both[0];
    }
  }

  const shared = chosen.shared;
  const command = (args: string[]): string[] => (shared ? args : ['-p', profile, ...args]);
  const block = chosen.block;
  const port = block.kind === 'enabled' ? block.port : block.kind === 'absent' ? (block.port ?? DEFAULT_WEBHOOK_PORT) : DEFAULT_WEBHOOK_PORT;
  const health: ListenerView['health'] = block.kind === 'enabled' && gateway !== 'not-installed' ? await probeOnce(port) : 'not-probed';

  const stored = bound(chosen, route, profile);
  const secrets = chosen.store.kind === 'ok' ? chosen.store.secrets : [];
  let listOk: boolean | null = null;
  let inList = false;
  if (cli !== null && input.crossCheckList !== false && (await fs.access(path.join(home, 'profiles', profile)).then(() => true, () => false))) {
    const result = await cli.run(command(['webhook', 'list']));
    listOk = result.status === 0;
    inList = listOk && listed(result.stdout, route);
    if (!listOk && block.kind === 'enabled' && health === 'listening') {
      const first = redact(`${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? 'sin salida', secrets);
      notices.push(`aviso: hermes ${command(['webhook', 'list']).join(' ')} respondió exit ${result.status ?? 'sin código'} («${first}») aunque el listener responde; se usa el store del dueño`);
    } else if (listOk && chosen.store.kind === 'ok' && inList !== (stored !== null)) {
      notices.push(`aviso: el store del dueño y hermes ${command(['webhook', 'list']).join(' ')} no coinciden sobre la ruta ${route}`);
    }
  }
  let routeState: ListenerView['route'];
  let routeSource: ListenerView['routeSource'];
  if (stored !== null) {
    routeState = 'present';
    routeSource = 'store';
  } else if (inList) {
    routeState = 'present';
    routeSource = 'list';
  } else if (chosen.store.kind === 'ok' && gateway !== 'not-installed') {
    routeState = 'absent';
    routeSource = 'store';
  } else if (listOk === true) {
    routeState = 'absent';
    routeSource = 'list';
  } else {
    routeState = 'not-verifiable';
    routeSource = 'none';
  }

  return {
    gateway,
    owner: chosen.owner,
    shared,
    ownerSource,
    paths: {
      dir: chosen.dir,
      config: path.join(chosen.dir, 'config.yaml'),
      env: path.join(chosen.dir, '.env'),
      subscriptions: path.join(chosen.dir, 'webhook_subscriptions.json'),
    },
    command,
    restartText: `hermes ${command(['gateway', 'restart']).join(' ')}`,
    urlPath: (name) => `${shared ? `/p/${profile}` : ''}/webhooks/${name}`,
    block,
    port,
    health,
    route: routeState,
    routeSource,
    routeProfile: stored?.profile ?? (stored !== null ? profile : null),
    listOk,
    notices,
    topology,
  };
}
