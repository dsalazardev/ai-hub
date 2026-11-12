import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { parseDotenv } from '../env/dotenv.js';
import { loadManifestContext, readManifestFile, writeInventory } from '../manifest/manifest.js';
import { PROFILE, runEnroll } from './enroll.js';
import { hermesHome, resolveHermes, type HermesCli, type ResolverHost } from './hermes.js';
import { redactedCause } from './redact.js';
import { writeProfileEnv } from './profile-env.js';
import { ensureSoulIdentity, setAsideSoulAction, soulNeedsSetAside } from './identity.js';
import { ENROLL_ACTION, RETAKE_ACTION } from '../cli/integrations.js';
import type { RunResult } from '../speckit/runner.js';
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

export type DiscordFailureClass =
  | 'token-rejected'
  | 'access-refused'
  | 'not-visible'
  | 'rate-limited'
  | 'temporary'
  | 'unreachable'
  | 'http-error';

export interface DiscordFailure {
  operation: 'token' | 'channel' | 'guilds' | 'guild-channels';
  stage: 'discord';
  status: number | null;
  classification: DiscordFailureClass;
  code: number | null;
}

export type DiscordDiagnostic = (line: string) => void;

/** Línea por campos: nunca se construye desde el cuerpo, las cabeceras ni el token (CO-06). */
export function discordDiagnostic(failure: DiscordFailure): string {
  return `discord: operation=${failure.operation} stage=${failure.stage} status=${failure.status ?? 'network'} class=${failure.classification} code=${failure.code ?? '-'}`;
}

function failureClass(operation: DiscordFailure['operation'], status: number): DiscordFailureClass {
  if (status === 401 || status === 403) {
    return operation === 'token' ? 'token-rejected' : 'access-refused';
  }
  if (status === 404) {
    return 'not-visible';
  }
  if (status === 429) {
    return 'rate-limited';
  }
  if (status >= 500) {
    return 'temporary';
  }
  return 'http-error';
}

function failure(
  operation: DiscordFailure['operation'],
  status: number | null,
  code: number | null = null,
): DiscordFailure {
  return {
    operation,
    stage: 'discord',
    status,
    classification: status === null ? 'unreachable' : failureClass(operation, status),
    code,
  };
}

async function errorCode(response: { json(): Promise<unknown> }): Promise<number | null> {
  const body = record(await response.json().catch(() => null));
  return typeof body.code === 'number' ? body.code : null;
}

function report(diagnostic: DiscordDiagnostic | undefined, item: DiscordFailure): void {
  diagnostic?.(discordDiagnostic(item));
}

export type TokenCheck =
  | { kind: 'valid'; botName: string; botId: string | null }
  | { kind: 'rejected'; status: number; code: number | null; failure: DiscordFailure }
  | { kind: 'unreachable'; failure: DiscordFailure };

export interface ServerSearchFailure {
  server: string;
  status: number;
}

export type ChannelEvidence = 'no-server' | 'server' | 'bot' | 'none';

export type ChannelCheck =
  | { kind: 'found'; id: string; name: string | null; searchedFailures: ServerSearchFailure[] }
  | { kind: 'not-visible'; failure: DiscordFailure; evidence: ChannelEvidence; serverListStatus: number | null }
  | { kind: 'no-servers' }
  | { kind: 'no-match'; searchedFailures: ServerSearchFailure[] }
  | { kind: 'ambiguous'; count: number; matches: Array<{ server: string; id: string; name: string }> }
  | { kind: 'incompatible'; id: string; name: string; type: number }
  | { kind: 'unreachable'; failure: DiscordFailure }
  | { kind: 'guilds-failed'; failure: DiscordFailure };

export interface ResolveChannelOptions {
  botId?: string | null;
  diagnostic?: DiscordDiagnostic;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}` };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** D3: `GET /users/@me` con el token del bot. 401/403 → rechazado (nunca se guarda); el resto conserva su clase. */
export async function checkBotToken(
  doFetch: DiscordFetch,
  token: string,
  diagnostic?: DiscordDiagnostic,
): Promise<TokenCheck> {
  try {
    const response = await doFetch(`${DISCORD_API}/users/@me`, { headers: auth(token), signal: AbortSignal.timeout(10_000) });
    if (response.status === 200) {
      const body = record(await response.json().catch(() => null));
      return {
        kind: 'valid',
        botName: typeof body.username === 'string' ? body.username : 'bot',
        botId: typeof body.id === 'string' ? body.id : null,
      };
    }
    const code = await errorCode(response);
    const item = failure('token', response.status, code);
    report(diagnostic, item);
    if (response.status === 401 || response.status === 403) {
      return { kind: 'rejected', status: response.status, code, failure: item };
    }
    return { kind: 'unreachable', failure: item };
  } catch {
    const item = failure('token', null);
    report(diagnostic, item);
    return { kind: 'unreachable', failure: item };
  }
}

async function guildList(
  get: (pathname: string) => Promise<{ status: number; json(): Promise<unknown> }>,
  diagnostic: DiscordDiagnostic | undefined,
): Promise<{ ok: true; guilds: Array<{ id: string; name: string }> } | { ok: false; status: number | null }> {
  try {
    const response = await get('/users/@me/guilds');
    if (response.status !== 200) {
      const code = await errorCode(response);
      report(diagnostic, failure('guilds', response.status, code));
      return { ok: false, status: response.status };
    }
    const guilds: Array<{ id: string; name: string }> = [];
    for (const value of (await response.json().catch(() => [])) as unknown[]) {
      const data = record(value);
      if (typeof data.id === 'string') {
        guilds.push({ id: data.id, name: typeof data.name === 'string' ? data.name : data.id });
      }
    }
    return { ok: true, guilds };
  } catch {
    report(diagnostic, failure('guilds', null));
    return { ok: false, status: null };
  }
}

/**
 * D4: id numérico → `GET /channels/{id}`. Ante 403/404 se consulta una sola vez la lista de servidores y solo una
 * respuesta 200 permite afirmar una causa. Nombre → canales de texto de los servidores del bot, comparados sin
 * distinguir mayúsculas; la ambigüedad se lista y nunca se resuelve sola.
 */
export async function resolveChannel(
  doFetch: DiscordFetch,
  token: string,
  input: string,
  options: ResolveChannelOptions = {},
): Promise<ChannelCheck> {
  const value = input.trim().replace(/^#/, '');
  const get = async (pathname: string) =>
    doFetch(`${DISCORD_API}${pathname}`, { headers: auth(token), signal: AbortSignal.timeout(10_000) });
  try {
    if (MIN_ID.test(value)) {
      const response = await get(`/channels/${value}`);
      if (response.status === 200) {
        const body = record(await response.json().catch(() => null));
        return { kind: 'found', id: value, name: typeof body.name === 'string' ? body.name : null, searchedFailures: [] };
      }
      const code = await errorCode(response);
      const item = failure('channel', response.status, code);
      report(options.diagnostic, item);
      let evidence: ChannelEvidence = 'none';
      let serverListStatus: number | null = null;
      if (response.status === 403 || response.status === 404) {
        const listed = await guildList(get, options.diagnostic);
        if (listed.ok) {
          if (options.botId && options.botId === value) {
            evidence = 'bot';
          } else if (listed.guilds.length === 0) {
            evidence = 'no-server';
          } else if (listed.guilds.some((guild) => guild.id === value)) {
            evidence = 'server';
          }
        } else {
          serverListStatus = listed.status;
        }
      }
      return { kind: 'not-visible', failure: item, evidence, serverListStatus };
    }
    const listed = await guildList(get, options.diagnostic);
    if (!listed.ok) {
      return { kind: 'guilds-failed', failure: failure('guilds', listed.status) };
    }
    if (listed.guilds.length === 0) {
      return { kind: 'no-servers' };
    }
    const wanted = value.toLowerCase();
    const matches: Array<{ server: string; id: string; name: string }> = [];
    const incompatible: Array<{ server: string; id: string; name: string; type: number }> = [];
    const searchedFailures: ServerSearchFailure[] = [];
    for (const guild of listed.guilds) {
      let response: { status: number; json(): Promise<unknown> };
      try {
        response = await get(`/guilds/${guild.id}/channels`);
      } catch {
        report(options.diagnostic, failure('guild-channels', null));
        searchedFailures.push({ server: guild.name, status: 0 });
        continue;
      }
      if (response.status !== 200) {
        const code = await errorCode(response);
        report(options.diagnostic, failure('guild-channels', response.status, code));
        searchedFailures.push({ server: guild.name, status: response.status });
        continue;
      }
      for (const value of (await response.json().catch(() => [])) as unknown[]) {
        const data = record(value);
        if (typeof data.id !== 'string' || typeof data.name !== 'string' || data.name.trim().toLowerCase() !== wanted) {
          continue;
        }
        if (data.type === 0) {
          matches.push({ server: guild.name, id: data.id, name: data.name.trim() });
        } else if (typeof data.type === 'number') {
          incompatible.push({ server: guild.name, id: data.id, name: data.name.trim(), type: data.type });
        }
      }
    }
    if (matches.length === 1) {
      return { kind: 'found', id: matches[0].id, name: matches[0].name, searchedFailures };
    }
    if (matches.length > 1) {
      return { kind: 'ambiguous', count: matches.length, matches };
    }
    if (incompatible.length > 0) {
      return { kind: 'incompatible', id: incompatible[0].id, name: incompatible[0].name, type: incompatible[0].type };
    }
    return { kind: 'no-match', searchedFailures };
  } catch {
    const item = failure('channel', null);
    report(options.diagnostic, item);
    return { kind: 'unreachable', failure: item };
  }
}

/** Mensaje de nivel de estado para un token rechazado o no verificable. */
export function tokenMessage(check: Exclude<TokenCheck, { kind: 'valid' }>): string {
  if (check.kind === 'rejected') {
    return `Discord rechazó el token (HTTP ${check.status}); no se guarda. Copia uno nuevo con Reset Token.`;
  }
  const { status, classification } = check.failure;
  if (classification === 'rate-limited') {
    return 'Discord limitó la validación del token (HTTP 429); no se guarda. El token puede ser correcto: reintenta más tarde.';
  }
  if (classification === 'temporary') {
    return `Discord falló temporalmente al validar el token (HTTP ${status}); no se guarda. Reintenta más tarde.`;
  }
  if (status !== null) {
    return `Discord no pudo validar el token (HTTP ${status}); no se guarda. Revisa el token.`;
  }
  return 'No se pudo contactar con Discord para validar el token.';
}

function typeName(type: number): string {
  return type === 2 ? 'voz' : type === 4 ? 'categoría' : type === 5 ? 'anuncios' : `tipo ${type}`;
}

function serverListProblem(status: number | null): string {
  return status === null ? 'La lista de servidores no se pudo leer.' : `La lista de servidores no se pudo leer (HTTP ${status}).`;
}

/** Mensaje de nivel de estado o de evidencia independiente; `null` cuando el canal se resolvió. */
export function channelMessage(check: ChannelCheck): string | null {
  if (check.kind === 'found') {
    return null;
  }
  if (check.kind === 'not-visible') {
    let message: string;
    if (check.evidence === 'no-server') {
      message = 'El bot no está en ningún servidor: la lista de servidores respondió 200 y está vacía. Invítalo al servidor (README › Provisión de Discord, paso 4).';
    } else if (check.evidence === 'server') {
      message = 'Ese id pertenece a un servidor del bot, no está verificado como canal. Copia el id del canal con Modo desarrollador → clic derecho en el canal → Copiar ID.';
    } else if (check.evidence === 'bot') {
      message = 'Ese id es el propio id de usuario del bot, no un canal. Copia el id del canal con Modo desarrollador.';
    } else if (check.failure.classification === 'access-refused') {
      message = 'Discord deniega al bot el acceso a ese id (HTTP 403); esta respuesta no determina la causa exacta. Revisa la invitación y los permisos del bot antes de reintentar; corrige el id si procede.';
    } else if (check.failure.classification === 'not-visible') {
      message = 'Ningún canal con ese id es visible para el bot (HTTP 404); no se puede determinar si existe ni su tipo. Comprueba el id.';
    } else if (check.failure.classification === 'rate-limited') {
      message = 'Discord limitó la consulta (HTTP 429); el canal puede ser correcto. No cambies la respuesta: reintenta más tarde.';
    } else if (check.failure.classification === 'temporary') {
      message = `Discord falló temporalmente (HTTP ${check.failure.status}); el canal puede ser correcto. Reintenta más tarde; no lo cambies por este error.`;
    } else {
      message = `Discord no pudo comprobar el canal (HTTP ${check.failure.status ?? 'sin respuesta'}); no se puede determinar la causa.`;
    }
    return check.serverListStatus === null ? message : `${message} ${serverListProblem(check.serverListStatus)}`;
  }
  if (check.kind === 'no-servers') {
    return 'El bot no está en ningún servidor: la lista de servidores respondió 200 y está vacía. Invítalo al servidor (README › Provisión de Discord, paso 4).';
  }
  if (check.kind === 'no-match') {
    const failed = check.searchedFailures.length > 0
      ? ` No se pudo buscar en: ${check.searchedFailures.map((item) => `${item.server} (HTTP ${item.status || 'red'})`).join(', ')}.`
      : '';
    return `No se encontró un canal de texto con ese nombre.${failed} Revisa el nombre o escribe el id numérico.`;
  }
  if (check.kind === 'ambiguous') {
    const rows = check.matches.map((item) => `${item.server} / #${item.name} (${item.id})`).join('\n');
    return `Hay ${check.count} canales con ese nombre:\n${rows}\nEscribe el id numérico del canal correcto.`;
  }
  if (check.kind === 'incompatible') {
    return `El canal #${check.name} (${check.id}) es de tipo ${typeName(check.type)} (incompatible); elige un canal de texto.`;
  }
  if (check.kind === 'guilds-failed') {
    return `${serverListProblem(check.failure.status)} No se puede deducir una causa; comprueba el token y los permisos.`;
  }
  if (check.failure.classification === 'rate-limited') {
    return 'Discord limitó la consulta (HTTP 429); el canal puede ser correcto. No cambies la respuesta: reintenta más tarde.';
  }
  if (check.failure.classification === 'temporary') {
    return `Discord falló temporalmente (HTTP ${check.failure.status}); el canal puede ser correcto. Reintenta más tarde.`;
  }
  return 'Discord no responde; no se puede comprobar el canal. Reintenta cuando recuperes la conexión.';
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
  /** Sin uso desde init-fiabilidad: `IDEA.md` lo escribe la instalación base (SEED-01), no este paso. */
  idea: string | null;
  /** D6: ¿se puede sustituir el bot que ya tiene el perfil? (pregunta interactiva o `--reconfigure-hermes`). */
  reconfigure: () => Promise<boolean>;
  /** CO-09: solo el paso interactivo pregunta; `enroll` y `--connect-hermes` no adoptan un archivo sin marcas. */
  adoptSoul?: (file: string) => Promise<boolean>;
  now?: Date;
  /** Punto de enganche de pruebas (init-fiabilidad 1.3): se llama al completar cada etapa; lanzar = interrupción. */
  onStage?: (stage: ConnectStage) => void | Promise<void>;
}

export interface ConnectOutcome {
  code: number;
  lines: string[];
  /** init-fiabilidad: etapa que falló, lo listo, lo que falta, causa redactada, punto de guardado y acción (HC-12). */
  stage?: string;
  ready?: string[];
  missing?: string[];
  cause?: string[];
  saved?: boolean;
  action?: string;
  /** Identidad sin adoptar: el estado de integración es `pendiente`, no `fallida`. */
  pending?: boolean;
}

/** Etapas propias de AI-Hub tras las que una prueba puede simular una interrupción (design.md §12.4). */
export type ConnectStage =
  | 'profile'
  | 'identity-before-backup'
  | 'identity-backup'
  | 'identity-block'
  | 'env'
  | 'manifest';

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

export { writeProfileEnv };

/** `manifest.control` sobre el YAML crudo: el resto del manifiesto queda como estaba. */
async function writeManifestControl(root: string, answers: ConnectAnswers): Promise<void> {
  const raw = record(await readManifestFile(root));
  const previous = record(raw.control);
  raw.control = {
    ...previous,
    approvers: [answers.approver],
    channelId: answers.channelId,
    ttlHours: answers.ttlHours,
    expire: answers.expire,
    pollMinutes: typeof previous.pollMinutes === 'number' ? previous.pollMinutes : DEFAULT_POLL_MINUTES,
  };
  await fs.writeFile(path.join(root, 'manifest.yaml'), stringify(raw), 'utf8');
  await loadManifestContext(root);
  await writeInventory(root);
}

async function run(cli: HermesCli, args: string[]): Promise<{ ok: boolean; status: number | null; result: RunResult }> {
  const result = await cli.run(args);
  return { ok: result.status === 0, status: result.status, result };
}

/**
 * init-fiabilidad (HC-12): la conexión está guardada cuando el `.env` del perfil tiene `DISCORD_BOT_TOKEN` y existe
 * `manifest.control` (escrito después de ese `.env`). Decide la acción: antes, retomar la conexión; después, enroll.
 */
export async function connectionSaved(root: string, host: ResolverHost): Promise<boolean> {
  const envFile = path.join(hermesHome(host), 'profiles', PROFILE, '.env');
  if (!(await envValues(envFile)).DISCORD_BOT_TOKEN) {
    return false;
  }
  const manifest = await loadManifestContext(root).then((context) => context.manifest, () => null);
  return Boolean(manifest?.control);
}

/**
 * Aplica la conexión con respuestas ya validadas. Orden fail-closed: nada se escribe hasta que el perfil existe;
 * un fallo de un comando de Hermes para el paso nombrándolo y deja intacto el init ya aplicado.
 */
export async function connectControlPlane(root: string, answers: ConnectAnswers, options: ConnectOptions): Promise<ConnectOutcome> {
  const cli = await resolveHermes(options.host, options.hermes);
  const home = hermesHome(options.host);
  const profileDir = path.join(home, 'profiles', PROFILE);
  const envFile = path.join(profileDir, '.env');
  const owner = await tokenOwner(home, answers.token);
  const notSaved = { saved: false, action: RETAKE_ACTION };
  if (owner !== null) {
    return { code: 1, lines: [`control: ese token es el bot del perfil "${owner}"; ${PROFILE} necesita su propio bot (no se escribió nada)`], stage: 'discord', ...notSaved };
  }
  const current = (await envValues(envFile)).DISCORD_BOT_TOKEN;
  if (current !== undefined && current !== answers.token && !(await options.reconfigure())) {
    return { code: 1, lines: [`control: ${PROFILE} ya tiene otro bot; no se cambia (no se escribió nada)`], stage: 'env', ...notSaved };
  }
  let createdThisRun = false;
  if (!(await exists(profileDir))) {
    const created = await run(cli, ['profile', 'create', PROFILE, '--no-skills']);
    if (!created.ok) {
      const cause = redactedCause(created.result, [answers.token]);
      return {
        code: 1,
        lines: [`control: falló "hermes profile create ${PROFILE} --no-skills" (${cause[0]}); no se escribió el token; el init sigue aplicado`, ...cause.slice(1).map((line) => `  ${line}`)],
        stage: 'profile',
        missing: ['perfil', '.env', 'skill', 'scripts', 'ruta', 'cron'],
        cause,
        ...notSaved,
      };
    }
    createdThisRun = true;
  }
  const soulFile = path.join(profileDir, 'SOUL.md');
  const wasSaved = await connectionSaved(root, options.host);
  let soul: Awaited<ReturnType<typeof ensureSoulIdentity>>;
  try {
    await options.onStage?.('profile');
    soul = await ensureSoulIdentity(
      profileDir,
      {
        createdThisRun,
        saved: wasSaved,
        ...(options.adoptSoul ? { adopt: () => options.adoptSoul!(soulFile) } : {}),
        ...(options.onStage ? { onStage: (stage) => options.onStage!(stage) } : {}),
      },
    );
  } catch (error) {
    // Una interrupción o un fallo de la identidad conserva lo persistido y anuncia el paso humano que falte.
    const action = (await soulNeedsSetAside(profileDir))
      ? setAsideSoulAction(soulFile, wasSaved, RETAKE_ACTION)
      : wasSaved
        ? ENROLL_ACTION
        : RETAKE_ACTION;
    const cause = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return {
      code: 1,
      lines: [`control: la identidad se interrumpió en ${soulFile}; ${cause}`, `Siguiente: ${action}`],
      stage: 'identity',
      ready: ['perfil'],
      missing: ['identidad', '.env', 'manifest.control', 'skill', 'scripts', 'ruta', 'cron'],
      cause: [cause],
      saved: wasSaved,
      action,
      pending: true,
    };
  }
  if (soul.state === 'pending') {
    return {
      code: 1,
      lines: [`control: la identidad quedó pendiente en ${soulFile}; no se escribió la conexión`, `Siguiente: ${soul.action}`],
      stage: 'identity',
      ready: ['perfil'],
      missing: ['identidad', '.env', 'manifest.control', 'skill', 'scripts', 'ruta', 'cron'],
      cause: [soul.action ?? 'identidad sin adoptar'],
      saved: wasSaved,
      action: soul.action ?? RETAKE_ACTION,
      pending: true,
    };
  }
  // design.md §12.4: el `.env` del perfil y después `manifest.control`; con los dos, la conexión queda guardada.
  await writeProfileEnv(envFile, {
    DISCORD_BOT_TOKEN: answers.token,
    DISCORD_ALLOWED_USERS: answers.approver,
    DISCORD_ALLOWED_CHANNELS: answers.channelId,
    DISCORD_HOME_CHANNEL: answers.channelId,
  });
  await options.onStage?.('env');
  await writeManifestControl(root, answers);
  await options.onStage?.('manifest');
  const enrolled = await runEnroll(root, { mode: 'yes', host: options.host, hermes: cli.path, secrets: [answers.token] });
  if (enrolled.code !== 0) {
    return {
      code: enrolled.code,
      lines: [...enrolled.lines, 'control: el enrolamiento no terminó; el init sigue aplicado'],
      stage: enrolled.stage,
      ready: enrolled.ready,
      missing: enrolled.missing,
      cause: enrolled.cause,
      saved: enrolled.saved ?? true,
      action: enrolled.action ?? ENROLL_ACTION,
    };
  }
  let gatewayHint = '';
  const status = await run(cli, ['gateway', 'status']);
  if (status.ok) {
    const restarted = await run(cli, ['gateway', 'restart']);
    if (!restarted.ok) {
      const cause = redactedCause(restarted.result, [answers.token]);
      return {
        code: 1,
        lines: [`control: falló "hermes gateway restart" (${cause[0]}); el perfil quedó configurado`, ...cause.slice(1).map((line) => `  ${line}`)],
        stage: 'gateway',
        ready: ['perfil', '.env', 'skill', 'scripts', 'ruta', 'cron'],
        missing: ['gateway'],
        cause,
        saved: true,
        action: 'hermes gateway restart',
      };
    }
  } else if (`${status.result.stdout}\n${status.result.stderr}`.toLowerCase().includes('not installed')) {
    gatewayHint = ' · inicia el gateway con hermes gateway install';
  }
  // CO-08: el resumen de éxito solo se imprime si el check en proceso pasa.
  const checked = await runEnroll(root, { mode: 'check', host: options.host, hermes: cli.path, secrets: [answers.token] });
  if (checked.code !== 0) {
    return {
      code: 1,
      lines: [...checked.lines, 'control: el perfil todavía no está completo; el init sigue aplicado'],
      stage: checked.stage,
      ready: checked.ready,
      missing: checked.missing,
      cause: checked.lines.filter((line) => line.startsWith('[FAIL]')).slice(0, 3),
      saved: true,
      action: checked.action ?? ENROLL_ACTION,
      pending: true,
    };
  }
  const lines = [
    `control: perfil ${PROFILE} (${profileDir})`,
    `control: canal ${answers.channelId}${answers.channelName ? ` (#${answers.channelName})` : ''}`,
    `control: aprobador ${answers.approver}`,
    `control: ttl ${answers.ttlHours} h · expire ${answers.expire}`,
    `control: comprueba con ai-hub control enroll --check${gatewayHint}`,
  ];
  return { code: 0, lines };
}
