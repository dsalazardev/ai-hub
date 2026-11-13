import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AssistantPrompts } from '../src/cli/assistant.js';
import type { CliContext, CliIO } from '../src/cli/types.js';
import { hermesHome, type ResolverHost } from '../src/control/hermes.js';
import type { DiscordFetch } from '../src/control/onboard.js';
import type { ProcessRunner, RunResult } from '../src/speckit/runner.js';
import { fakeRunner } from './speckit-fake.js';
import type { Harness } from './control-harness.js';

/**
 * control-onboarding: Hermes falso en un hogar temporal, API de Discord falsa, prompts guionizados y un token
 * centinela que solo puede acabar en el `.env` del perfil.
 */
export const BOT_TOKEN = 'AIHUB_ONBOARD_BOT_SENTINEL_d41f';
export const OTHER_TOKEN = 'AIHUB_ONBOARD_OTHER_SENTINEL_77aa';
export const CHANNEL = '987654321098765432';
export const APPROVER = '123456789012345678';

/** Secreto HMAC que imprime `webhook subscribe` (como Hermes 0.23, `webhook.py:267`): jamás debe mostrarse. */
export const WEBHOOK_SECRET_SENTINEL = 'AIHUB_WEBHOOK_SECRET_SENTINEL_onb';
/** `SOUL.md` que siembra `profile create` (Hermes 0.23, `profiles_initialization.py`): identidad genérica sin marcas. */
export const DEFAULT_SOUL = 'You are Hermes Agent, a helpful assistant.\n';
/** `.env` que siembra `profile create`: un placeholder sin credenciales. */
export const DEFAULT_PROFILE_ENV = '# Hermes profile credentials\n';
/** Ayuda que imprime Hermes 0.23 en stdout cuando la plataforma webhook no está habilitada (`webhook.py:138-160`). */
export const WEBHOOK_SETUP_HINT = 'Webhook platform is not enabled. To set it up:\n  platforms:\n    webhook:\n      enabled: true';
/** Salida de `gateway status` de un perfil servido por el gateway del perfil de lanzamiento (medida en Hermes 0.23). */
export const MULTIPLEX_STATUS = 'Gateway is running via the default-profile multiplexer';

/** El proceso «muere» tras completar el comando indicado (`crashAfter`): el árbol queda tal cual. */
export class SimulatedCrash extends Error {
  constructor(command: string) {
    super(`simulated crash after ${command}`);
    this.name = 'SimulatedCrash';
  }
}

export interface InjectedFailure {
  status?: number;
  stdout?: string;
  stderr?: string;
}

export interface FakeHermes {
  host: ResolverHost;
  home: string;
  calls: string[][];
  /** Compatibilidad: fallo genérico (exit 3, «boom») por clave de comando. */
  fail: Set<string>;
  /** Fallo inyectado por subcomando (`webhook subscribe`, `cron create`, `profile create`…); se quita con `delete`. */
  failOn: Map<string, InjectedFailure>;
  /**
   * `dedicated`: el perfil de control tiene su gateway; `multiplex`: lo sirve el gateway del perfil `default`, que es
   * el dueño del listener (`gateway/run_adapters.py:1314-1321`).
   */
  topology: 'dedicated' | 'multiplex';
  /** Estado del listener tal como lo cargó el último arranque del gateway (no el archivo actual). */
  listener: { loaded: boolean; port: number | null; secretFromEnv: boolean };
  /** Otro proceso ocupa el puerto: la sonda responde con un documento ajeno. */
  portOccupied: boolean;
  /** Rutas escritas a mano sin secreto: el runtime las descarta al recargar (`webhook.py:417-427`). */
  routesWithoutSecret: Set<string>;
  /** Store donde se escribió cada ruta y perfil al que quedó ligada (`--route-profile`). */
  routeBinding: Map<string, { store: string; profile: string }>;
  /** Entrega simulada a una ruta: 404 si no existe, no está en el store del listener o no tiene secreto utilizable. */
  deliver(route: string): number;
  gatewayInstalled: boolean;
  gatewayRunning: boolean;
  /** Tras completar este comando, el falso lanza `SimulatedCrash` (interrupción del proceso). */
  crashAfter: string | null;
  routes: Set<string>;
  crons: Set<string>;
}

/** Clave de un comando: `profile create`, `gateway status`, `webhook subscribe` (sin `-p <perfil>`). */
export function commandKey(args: string[]): string {
  const rest = args[0] === '-p' ? args.slice(2) : args;
  return rest[0] === '--version' ? '--version' : rest.slice(0, 2).join(' ');
}

/** Directorio de un perfil: `default` es el hogar; el resto vive en `profiles/<nombre>`. */
export function profileHome(home: string, profile: string): string {
  return profile === 'default' ? home : path.join(home, 'profiles', profile);
}

/** Como `hermes_cli/webhook.py:109-120`: solo `platforms.webhook` de `config.yaml`; el `.env` no se consulta. */
async function webhookBlock(dir: string): Promise<{ enabled: boolean; port: number | null }> {
  const text = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8').catch(() => null);
  if (text === null) {
    return { enabled: false, port: null };
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return { enabled: false, port: null };
  }
  const map = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const webhook = map(map(map(data).platforms).webhook);
  const port = map(webhook.extra).port;
  return { enabled: Boolean(webhook.enabled), port: typeof port === 'number' ? port : null };
}

async function envOf(dir: string): Promise<Record<string, string>> {
  const text = await fs.readFile(path.join(dir, '.env'), 'utf8').catch(() => '');
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      values[match[1]] = match[2].trim();
    }
  }
  return values;
}

/** Hermes falso: binario en disco (el resolver lo encuentra), comandos grabados, perfiles reales en el hogar. */
export async function fakeHermes(root: string, version = '0.23.0'): Promise<FakeHermes> {
  const sandbox = path.join(root, '.sandbox');
  const windows = process.platform === 'win32';
  const env: Record<string, string> = windows ? { PATH: '', LOCALAPPDATA: sandbox } : { PATH: '' };
  const home = windows ? path.join(sandbox, 'home') : sandbox;
  const bin = path.join(sandbox, 'bin', windows ? 'hermes.exe' : 'hermes');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, 'fake');
  const state: FakeHermes = {
    host: undefined as unknown as ResolverHost,
    home: '',
    calls: [],
    fail: new Set(),
    failOn: new Map(),
    topology: 'dedicated',
    listener: { loaded: false, port: null, secretFromEnv: false },
    portOccupied: false,
    routesWithoutSecret: new Set(),
    routeBinding: new Map(),
    deliver: () => 404,
    gatewayInstalled: true,
    gatewayRunning: true,
    crashAfter: null,
    routes: new Set(),
    crons: new Set(),
  };
  const { routes, crons } = state;
  /** Store (perfil) sobre el que actúa un comando: `-p <perfil>` o `default`. */
  const storeOf = (args: string[]): string => (args[0] === '-p' ? args[1] : 'default');
  const ownerProfile = (): string => (state.topology === 'multiplex' ? 'default' : 'hermes-control');
  /** El gateway lee su configuración al arrancar: bloque de `config.yaml` y overrides del `.env` (`config_env.py:132-141`). */
  const reloadListener = async (): Promise<void> => {
    const dir = profileHome(state.home, ownerProfile());
    const block = await webhookBlock(dir);
    const env = await envOf(dir);
    const loaded = block.enabled || /^(1|true|yes|on)$/i.test(env.WEBHOOK_ENABLED ?? '');
    const envPort = Number(env.WEBHOOK_PORT);
    state.listener = {
      loaded,
      port: loaded ? (Number.isInteger(envPort) && envPort > 0 ? envPort : (block.port ?? 8644)) : null,
      secretFromEnv: loaded && Boolean(env.WEBHOOK_SECRET),
    };
  };
  const visible = (route: string, store: string): boolean => {
    const binding = state.routeBinding.get(route);
    return binding === undefined || binding.store === store;
  };
  state.deliver = (route) =>
    state.gatewayRunning && state.listener.loaded && routes.has(route) && visible(route, ownerProfile()) && !state.routesWithoutSecret.has(route)
      ? 200
      : 404;
  const respond = async (args: string[]): Promise<RunResult> => {
    const key = args.filter((arg) => !arg.startsWith('-') || arg === '--version').slice(0, 2).join(' ');
    const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
    if (state.fail.has(key)) {
      return { status: 3, stdout: '', stderr: 'boom' };
    }
    const injected = state.failOn.get(commandKey(args));
    if (injected) {
      return { status: injected.status ?? 1, stdout: injected.stdout ?? '', stderr: injected.stderr ?? '' };
    }
    if (args[0] === '--version') {
      return ok(`Hermes Agent v${version} (2026.9.24) · stable`);
    }
    if (args[0] === 'profile' && args[1] === 'create') {
      const dir = path.join(state.home, 'profiles', args[2]);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '.env'), DEFAULT_PROFILE_ENV, { flag: 'wx' }).catch(() => undefined);
      await fs.writeFile(path.join(dir, 'SOUL.md'), DEFAULT_SOUL, { flag: 'wx' }).catch(() => undefined);
      return ok();
    }
    const sub = args[0] === '-p' ? args.slice(2) : args;
    const store = storeOf(args);
    if (sub[0] === 'gateway' && sub[1] === 'status') {
      if (!state.gatewayInstalled) {
        return { status: 1, stdout: '', stderr: 'not installed' };
      }
      if (!state.gatewayRunning) {
        return { status: 1, stdout: '', stderr: 'gateway is not running' };
      }
      return ok(state.topology === 'multiplex' && store !== 'default' ? MULTIPLEX_STATUS : 'running');
    }
    if (sub[0] === 'gateway' && sub[1] === 'restart') {
      state.gatewayRunning = true;
      await reloadListener();
      return ok();
    }
    // Puerta del CLI (`webhook.py:163-176`): sin `platforms.webhook.enabled` en el `config.yaml` del store, sale 1.
    if (sub[0] === 'webhook' && !(await webhookBlock(profileHome(state.home, store))).enabled) {
      return { status: 1, stdout: WEBHOOK_SETUP_HINT, stderr: '' };
    }
    if (sub[0] === 'webhook' && sub[1] === 'list') {
      return ok([...routes].filter((route) => visible(route, store)).map((route) => `  ◆ ${route}`).join('\n'));
    }
    if (sub[0] === 'webhook' && sub[1] === 'subscribe') {
      const bound = sub.indexOf('--route-profile');
      routes.add(sub[2]);
      state.routeBinding.set(sub[2], { store, profile: bound >= 0 ? sub[bound + 1] : store });
      return ok(`  Created ${sub[2]}\n  Secret: ${WEBHOOK_SECRET_SENTINEL}`);
    }
    if (sub[0] === 'webhook' && (sub[1] === 'remove' || sub[1] === 'rm')) {
      routes.delete(sub[2]);
      state.routeBinding.delete(sub[2]);
      return ok();
    }
    if (sub[0] === 'cron' && sub[1] === 'list') {
      return ok([...crons].join('\n'));
    }
    if (sub[0] === 'cron' && sub[1] === 'create') {
      crons.add(sub[sub.indexOf('--name') + 1]);
      return ok();
    }
    return { status: 2, stdout: '', stderr: 'unknown' };
  };
  const exec: ProcessRunner = async (_command, args): Promise<RunResult> => {
    state.calls.push(args);
    const result = await respond(args);
    if (state.crashAfter !== null && commandKey(args) === state.crashAfter) {
      state.crashAfter = null;
      throw new SimulatedCrash(commandKey(args));
    }
    return result;
  };
  state.host = {
    platform: process.platform,
    env: { ...env, HERMES_BIN: bin },
    home: windows ? path.join(sandbox, 'userhome') : sandbox,
    cwd: root,
    exec,
    exists: (file) => fs.access(file).then(() => true, () => false),
    probeWebhook: async (port) =>
      state.portOccupied ? 'foreign' : state.gatewayRunning && state.listener.loaded && state.listener.port === port ? 'listening' : 'refused',
    webhookWaitMs: 0,
  };
  state.home = hermesHome(state.host);
  return state;
}

/** Host sin Hermes: ningún candidato existe. */
export function noHermesHost(root: string): ResolverHost {
  return { platform: process.platform, env: { PATH: '' }, home: root, cwd: root, exec: fakeRunner().run, exists: async () => false };
}

export interface FakeDiscord {
  fetch: DiscordFetch;
  urls: string[];
  tokenStatus: number | 'network';
  channels: Record<string, string>;
  guildChannels: Array<{ id: string; name: string; type: number }>;
}

/** API v10 de Discord falsa: `/users/@me`, `/channels/{id}`, `/users/@me/guilds`, `/guilds/{id}/channels`. */
export function fakeDiscord(): FakeDiscord {
  const state: FakeDiscord = {
    fetch: undefined as unknown as DiscordFetch,
    urls: [],
    tokenStatus: 200,
    channels: { [CHANNEL]: 'control' },
    guildChannels: [{ id: CHANNEL, name: 'control', type: 0 }],
  };
  state.fetch = async (url, init) => {
    state.urls.push(url);
    expect(url).not.toContain(BOT_TOKEN);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (state.tokenStatus === 'network') {
      throw new Error('ECONNREFUSED');
    }
    if (init.headers.Authorization !== `Bot ${BOT_TOKEN}` && init.headers.Authorization !== `Bot ${OTHER_TOKEN}`) {
      return json(401, {});
    }
    const pathname = url.replace('https://discord.com/api/v10', '');
    if (pathname === '/users/@me') {
      return state.tokenStatus === 200 ? json(200, { id: '1', username: 'ai-hub-control-bot' }) : json(state.tokenStatus, {});
    }
    const channel = /^\/channels\/(\d+)$/.exec(pathname);
    if (channel) {
      return state.channels[channel[1]] ? json(200, { id: channel[1], name: state.channels[channel[1]], type: 0 }) : json(404, {});
    }
    if (pathname === '/users/@me/guilds') {
      return json(200, [{ id: '555' }]);
    }
    if (pathname === '/guilds/555/channels') {
      return json(200, state.guildChannels);
    }
    return json(404, {});
  };
  return state;
}

export interface Scripted {
  prompts: AssistantPrompts;
  asked: string[];
  notes: string[];
}

/** Respuestas en orden; `null` = cancelación. `password` graba que se pidió enmascarado. */
export function scripted(replies: Array<string | boolean | null>): Scripted {
  const asked: string[] = [];
  const notes: string[] = [];
  let index = 0;
  const next = (): string | boolean | null => (index < replies.length ? replies[index++] : null);
  const prompts: AssistantPrompts = {
    intro: () => undefined,
    note: (message) => {
      notes.push(message);
    },
    multiselect: async () => null,
    select: async () => null,
    text: async (message) => {
      asked.push(`text:${message}`);
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
    confirm: async (message) => {
      asked.push(`confirm:${message}`);
      const reply = next();
      return typeof reply === 'boolean' ? reply : null;
    },
    password: async (message) => {
      asked.push(`password:${message}`);
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
  };
  return { prompts, asked, notes };
}

export async function treeHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  for (const file of entries) {
    hash.update(path.relative(dir, file));
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex');
}

/**
 * Busca el centinela en todos los archivos de un árbol; devuelve las rutas relativas que lo contienen. `.sandbox/`
 * (el hogar del Hermes falso, que en Windows cae dentro del temporal del repo) se excluye: se revisa aparte.
 */
export async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, file).split(path.sep).join('/');
    if (relative.startsWith('.sandbox/') && !path.resolve(dir).includes(`${path.sep}.sandbox`)) {
      continue;
    }
    if ((await fs.readFile(file, 'utf8').catch(() => '')).includes(needle)) {
      found.push(path.relative(dir, file).replace(/\\/g, '/'));
    }
  }
  return found.sort();
}

export function stepContext(h: Harness, sink: { out: string[]; err: string[] }, extra: Partial<CliContext> = {}): CliContext {
  const io: CliIO = { out: (line) => sink.out.push(line), err: (line) => sink.err.push(line) };
  return { cwd: h.root, root: h.root, source: null, io, exec: fakeRunner().run, ...extra };
}

/** Comandos de Hermes que crean o cambian estado (sin --version, status ni list). */
export const creating = (calls: string[][]): string[][] =>
  calls.filter((args) => {
    const rest = args[0] === '-p' ? args.slice(2) : args;
    return rest[0] !== '--version' && !(rest[0] === 'gateway' && rest[1] === 'status') && !rest.includes('list');
  });
