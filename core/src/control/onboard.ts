import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { parseDotenv } from '../env/dotenv.js';
import { loadManifestContext, readManifestFile, writeInventory } from '../manifest/manifest.js';
import { PROFILE, runEnroll } from './enroll.js';
import { hermesHome, resolveHermes, type HermesCli, type ResolverHost } from './hermes.js';
import { DEFAULT_POLL_MINUTES } from './ledger.js';

/**
 * Onboarding del plano de control (control-onboarding): conecta un bot de Discord PROPIO al perfil independiente
 * `hermes-control`. El token lo teclea la persona; el arnés solo lo compara en memoria y lo escribe en el `.env`
 * del perfil. Nunca se imprime, nunca se pasa como argumento de un proceso y nunca va a `.ai-hub/.env` ni a git.
 */
export const DISCORD_API = 'https://discord.com/api/v10';
export const MIN_ID = /^[0-9]{17,20}$/;
export const APPROVER_ID = /^[0-9]{5,25}$/;

export type DiscordFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export const defaultDiscordFetch: DiscordFetch = (url, init) => fetch(url, init);

export type TokenCheck = { kind: 'valid'; botName: string } | { kind: 'rejected'; status: number } | { kind: 'unreachable' };
export type ChannelCheck =
  | { kind: 'found'; id: string; name: string | null }
  | { kind: 'not-visible' }
  | { kind: 'no-match' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'unreachable' };

function auth(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}` };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** D3: `GET /users/@me` con el token del bot. 401/403 → rechazado (nunca se guarda); red caída → desconocido. */
export async function checkBotToken(doFetch: DiscordFetch, token: string): Promise<TokenCheck> {
  try {
    const response = await doFetch(`${DISCORD_API}/users/@me`, { headers: auth(token), signal: AbortSignal.timeout(10_000) });
    if (response.status === 200) {
      const body = record(await response.json().catch(() => null));
      return { kind: 'valid', botName: typeof body.username === 'string' ? body.username : 'bot' };
    }
    return { kind: 'rejected', status: response.status };
  } catch {
    return { kind: 'unreachable' };
  }
}

/**
 * D4: id numérico → `GET /channels/{id}` (el bot debe verlo). Nombre → canales de texto de los servidores del bot
 * con ese nombre exacto; solo una coincidencia se acepta.
 */
export async function resolveChannel(doFetch: DiscordFetch, token: string, input: string): Promise<ChannelCheck> {
  const value = input.trim().replace(/^#/, '');
  const get = async (pathname: string) => doFetch(`${DISCORD_API}${pathname}`, { headers: auth(token), signal: AbortSignal.timeout(10_000) });
  try {
    if (MIN_ID.test(value)) {
      const response = await get(`/channels/${value}`);
      if (response.status !== 200) {
        return { kind: 'not-visible' };
      }
      const body = record(await response.json().catch(() => null));
      return { kind: 'found', id: value, name: typeof body.name === 'string' ? body.name : null };
    }
    const guilds = await get('/users/@me/guilds');
    if (guilds.status !== 200) {
      return { kind: 'not-visible' };
    }
    const matches: Array<{ id: string; name: string }> = [];
    for (const guild of (await guilds.json().catch(() => [])) as unknown[]) {
      const guildId = record(guild).id;
      if (typeof guildId !== 'string') {
        continue;
      }
      const channels = await get(`/guilds/${guildId}/channels`);
      if (channels.status !== 200) {
        continue;
      }
      for (const channel of (await channels.json().catch(() => [])) as unknown[]) {
        const data = record(channel);
        if (data.type === 0 && data.name === value && typeof data.id === 'string') {
          matches.push({ id: data.id, name: value });
        }
      }
    }
    if (matches.length === 1) {
      return { kind: 'found', id: matches[0].id, name: matches[0].name };
    }
    return matches.length === 0 ? { kind: 'no-match' } : { kind: 'ambiguous', count: matches.length };
  } catch {
    return { kind: 'unreachable' };
  }
}

export interface ConnectAnswers {
  token: string;
  channelId: string;
  channelName: string | null;
  approver: string;
  ttlHours: number;
  expire: 'block' | 'notify';
}

export interface ConnectOptions {
  host: ResolverHost;
  hermes?: string;
  idea: string | null;
  /** D6: ¿se puede sustituir el bot que ya tiene el perfil? (pregunta interactiva o `--reconfigure-hermes`). */
  reconfigure: () => Promise<boolean>;
  now?: Date;
}

export interface ConnectOutcome {
  code: number;
  lines: string[];
}

export const PROFILE_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS', 'DISCORD_HOME_CHANNEL'] as const;

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function envValues(file: string): Promise<Record<string, string>> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  return text === null ? {} : parseDotenv(text);
}

/** ¿Qué perfil (o el `.env` por defecto) usa ya este token? Comparación en memoria; solo sale el nombre. */
export async function tokenOwner(home: string, token: string): Promise<string | null> {
  const candidates: Array<[string, string]> = [['default', path.join(home, '.env')]];
  for (const entry of await fs.readdir(path.join(home, 'profiles'), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name !== PROFILE) {
      candidates.push([entry.name, path.join(home, 'profiles', entry.name, '.env')]);
    }
  }
  for (const [name, file] of candidates) {
    if ((await envValues(file)).DISCORD_BOT_TOKEN === token) {
      return name;
    }
  }
  return null;
}

/** Escribe solo las claves del paso en el `.env` del perfil, conservando las demás; atómico y 0600 donde se pueda. */
export async function writeProfileEnv(file: string, values: Record<string, string>): Promise<void> {
  const original = await fs.readFile(file, 'utf8').catch(() => '');
  const pending = new Map(Object.entries(values));
  const lines = original === '' ? [] : original.replace(/\r?\n$/, '').split(/\r?\n/);
  const updated = lines.map((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key !== undefined && pending.has(key)) {
      const value = pending.get(key) as string;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) {
    updated.push(`${key}=${value}`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.ai-hub-${process.pid}.tmp`;
  await fs.writeFile(temp, `${updated.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** `manifest.control` sobre el YAML crudo: el resto del manifiesto queda como estaba. */
async function writeManifestControl(root: string, answers: ConnectAnswers): Promise<void> {
  const raw = record(await readManifestFile(root));
  const previous = record(raw.control);
  raw.control = {
    ...previous,
    approvers: [answers.approver],
    ttlHours: answers.ttlHours,
    expire: answers.expire,
    pollMinutes: typeof previous.pollMinutes === 'number' ? previous.pollMinutes : DEFAULT_POLL_MINUTES,
  };
  await fs.writeFile(path.join(root, 'manifest.yaml'), stringify(raw), 'utf8');
  await loadManifestContext(root);
  await writeInventory(root);
}

function dateOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** D9: `IDEA.md` en la raíz, solo si hubo idea y no existe; `backlog/seed.md` sigue siendo la fuente. */
async function seedIdea(root: string, idea: string | null, now: Date): Promise<string | null> {
  if (idea === null || (await exists(path.join(root, 'IDEA.md')))) {
    return null;
  }
  await fs.writeFile(
    path.join(root, 'IDEA.md'),
    `# Idea del proyecto\n\n> Registrada por \`ai-hub init\` el ${dateOf(now)}. Fuente: [backlog/seed.md](backlog/seed.md).\n\n${idea}\n`,
    'utf8',
  );
  return 'IDEA.md';
}

async function run(cli: HermesCli, args: string[]): Promise<{ ok: boolean; status: number | null }> {
  const result = await cli.run(args);
  return { ok: result.status === 0, status: result.status };
}

/**
 * Aplica la conexión con respuestas ya validadas. Orden fail-closed: nada se escribe hasta que el perfil existe;
 * un fallo de un comando de Hermes para el paso nombrándolo y deja intacto el init ya aplicado.
 */
export async function connectControlPlane(root: string, answers: ConnectAnswers, options: ConnectOptions): Promise<ConnectOutcome> {
  const now = options.now ?? new Date();
  const cli = await resolveHermes(options.host, options.hermes);
  const home = hermesHome(options.host);
  const profileDir = path.join(home, 'profiles', PROFILE);
  const envFile = path.join(profileDir, '.env');
  const owner = await tokenOwner(home, answers.token);
  if (owner !== null) {
    return { code: 1, lines: [`control: ese token es el bot del perfil "${owner}"; ${PROFILE} necesita su propio bot (no se escribió nada)`] };
  }
  const current = (await envValues(envFile)).DISCORD_BOT_TOKEN;
  if (current !== undefined && current !== answers.token && !(await options.reconfigure())) {
    return { code: 1, lines: [`control: ${PROFILE} ya tiene otro bot; no se cambia (no se escribió nada)`] };
  }
  if (!(await exists(profileDir))) {
    const created = await run(cli, ['profile', 'create', PROFILE, '--no-skills']);
    if (!created.ok) {
      return { code: 1, lines: [`control: falló "hermes profile create ${PROFILE} --no-skills" (exit ${created.status ?? 'sin código'}); no se escribió el token; el init sigue aplicado`] };
    }
  }
  await writeProfileEnv(envFile, {
    DISCORD_BOT_TOKEN: answers.token,
    DISCORD_ALLOWED_USERS: answers.approver,
    DISCORD_ALLOWED_CHANNELS: answers.channelId,
    DISCORD_HOME_CHANNEL: answers.channelId,
  });
  await writeManifestControl(root, answers);
  const enrolled = await runEnroll(root, { mode: 'yes', host: options.host, hermes: cli.path });
  if (enrolled.code !== 0) {
    return { code: enrolled.code, lines: [...enrolled.lines, 'control: el enrolamiento no terminó; el init sigue aplicado'] };
  }
  const lines: string[] = [];
  let gatewayHint = '';
  const status = await run(cli, ['gateway', 'status']);
  if (status.ok) {
    const restarted = await run(cli, ['gateway', 'restart']);
    if (!restarted.ok) {
      return { code: 1, lines: [`control: falló "hermes gateway restart" (exit ${restarted.status ?? 'sin código'}); el perfil quedó configurado`] };
    }
    lines.push('control: gateway de Hermes reiniciado; el bot del perfil se conecta');
  } else {
    gatewayHint = ' · inicia el gateway con hermes gateway install';
  }
  const seeded = await seedIdea(root, options.idea, now);
  if (seeded !== null) {
    lines.push(`control: ${seeded} escrito (fuente: backlog/seed.md)`);
  }
  lines.push(
    `control: perfil ${PROFILE} (${profileDir})`,
    `control: canal ${answers.channelId}${answers.channelName ? ` (#${answers.channelName})` : ''}`,
    `control: aprobador ${answers.approver}`,
    `control: ttl ${answers.ttlHours} h · expire ${answers.expire}`,
    `control: comprueba con ai-hub control enroll --check${gatewayHint}`,
  );
  return { code: 0, lines };
}
