import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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

export interface FakeHermes {
  host: ResolverHost;
  home: string;
  calls: string[][];
  fail: Set<string>;
  gatewayInstalled: boolean;
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
  const state: FakeHermes = { host: undefined as unknown as ResolverHost, home: '', calls: [], fail: new Set(), gatewayInstalled: true };
  const routes = new Set<string>();
  const crons = new Set<string>();
  const exec: ProcessRunner = async (_command, args): Promise<RunResult> => {
    state.calls.push(args);
    const key = args.filter((arg) => !arg.startsWith('-') || arg === '--version').slice(0, 2).join(' ');
    const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
    if (state.fail.has(key)) {
      return { status: 3, stdout: '', stderr: 'boom' };
    }
    if (args[0] === '--version') {
      return ok(`Hermes Agent v${version} (2026.9.24) · stable`);
    }
    if (args[0] === 'profile' && args[1] === 'create') {
      await fs.mkdir(path.join(state.home, 'profiles', args[2]), { recursive: true });
      return ok();
    }
    if (args[0] === 'gateway' && args[1] === 'status') {
      return state.gatewayInstalled ? ok('running') : { status: 1, stdout: '', stderr: 'not installed' };
    }
    if (args[0] === 'gateway' && args[1] === 'restart') {
      return ok();
    }
    const sub = args.slice(2);
    if (sub[0] === 'webhook' && sub[1] === 'list') {
      return ok([...routes].map((route) => `  ◆ ${route}`).join('\n'));
    }
    if (sub[0] === 'webhook' && sub[1] === 'subscribe') {
      routes.add(sub[2]);
      return ok('  Secret: AIHUB_WEBHOOK_SECRET_SENTINEL_onb');
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
  state.host = {
    platform: process.platform,
    env: { ...env, HERMES_BIN: bin },
    home: windows ? path.join(sandbox, 'userhome') : sandbox,
    cwd: root,
    exec,
    exists: (file) => fs.access(file).then(() => true, () => false),
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
  calls.filter((args) => args[0] !== '--version' && !(args[0] === 'gateway' && args[1] === 'status') && !args.includes('list'));
