import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatewayTopology } from './listener.js';
import type { AssistantPrompts } from '../cli/assistant.js';
import type { CliContext } from '../cli/types.js';
import {
  APPROVER_ID,
  channelMessage,
  checkBotToken,
  connectControlPlane,
  defaultDiscordFetch,
  resolveChannel,
  tokenMessage,
  tokenOwner,
  MIN_ID,
  type ConnectAnswers,
  type DiscordFetch,
} from './onboard.js';
import { PROFILE } from './enroll.js';
import { canExecute, HermesNotFoundError, HermesVersionError, hermesHome, resolveHermes, type ResolverHost } from './hermes.js';
import { DEFAULT_TTL_HOURS } from './ledger.js';
import { RETAKE_ACTION, RETAKE_PROVIDE, type IntegrationReport } from '../cli/integrations.js';
import type { ConnectOutcome } from './onboard.js';

/** Resultado de un paso de control: su código (API del paso) y el informe de integración para `init`. */
export interface StepResult {
  code: number;
  report: IntegrationReport | null;
}

const NOT_REQUESTED: IntegrationReport = { name: 'control', state: 'no-solicitada', stage: null, action: null };

function retake(stage: string, cause?: string[]): IntegrationReport {
  return { name: 'control', state: 'fallida', stage, action: RETAKE_ACTION, provide: RETAKE_PROVIDE, ...(cause ? { cause } : {}) };
}

/** Informe de una conexión aplicada: completada, sin validar (no verificable) o fallida en su etapa (HC-12). */
export function connectReport(outcome: ConnectOutcome, unvalidated: boolean): IntegrationReport {
  if (outcome.code === 0) {
    return unvalidated
      ? { name: 'control', state: 'no-verificable', stage: 'discord', action: 'ai-hub control enroll --check' }
      : { name: 'control', state: 'completada', stage: null, action: null };
  }
  const saved = outcome.saved === true;
  return {
    name: 'control',
    state: outcome.pending === true ? 'pendiente' : 'fallida',
    stage: outcome.stage ?? 'control',
    action: outcome.action ?? (saved ? null : RETAKE_ACTION),
    ...(outcome.ready ? { ready: outcome.ready } : {}),
    ...(outcome.unverified && outcome.unverified.length > 0 ? { unverified: outcome.unverified } : {}),
    ...(outcome.missing && outcome.missing.length > 0 ? { missing: outcome.missing } : {}),
    ...(saved ? {} : { provide: RETAKE_PROVIDE }),
    ...(outcome.cause ? { cause: outcome.cause } : {}),
  };
}

/** Host real del resolver de Hermes; los tests inyectan `ctx.controlHost`. */
export function contextHost(ctx: CliContext): ResolverHost {
  return (
    ctx.controlHost ?? {
      platform: process.platform,
      env: process.env,
      home: os.homedir(),
      cwd: ctx.root,
      exec: ctx.exec,
      exists: (file) => fs.access(file).then(() => true, () => false),
      executable: (file) => canExecute(file),
    }
  );
}

export const LATER_LINE = 'control: Hermes no detectado; cuando lo instales, conecta el plano de control con ai-hub control enroll';
const SKIPPED = 'control: paso saltado; no se escribió nada';
const CANCELLED = 'control: cancelado; no se escribió nada';

export interface EntryContext {
  /** Dueño del listener cuando es otro perfil (multiplexor): la pregunta lo nombra y aceptarla es el consentimiento. */
  sharedOwner?: string | null;
  /** El `.env` del perfil tiene `WEBHOOK_ENABLED` o `WEBHOOK_PORT` heredados. */
  legacyKeys?: boolean;
}

/** Pregunta de aceptación (CO-01): nombra cada cambio que el paso puede hacer fuera del repositorio. */
export function entryQuestion(version: string, context: EntryContext = {}): string {
  const owner = context.sharedOwner
    ? ` (aquí, el perfil "${context.sharedOwner}": la activa para todos los perfiles que sirve su gateway, y reiniciarlo corta sus sesiones)`
    : '';
  const legacy = context.legacyKeys ? ' mueve WEBHOOK_ENABLED y WEBHOOK_PORT del .env a ese config.yaml tras una copia del .env,' : '';
  return `Hermes v${version} detectado. ¿Conectar el plano de control ahora? Crea el perfil hermes-control con TU bot, escribe su .env (token del bot, usuarios y canales permitidos), su skill, sus scripts y el bloque gestionado de SOUL.md, habilita la plataforma webhook con el bloque platforms.webhook en el config.yaml del perfil dueño del listener${owner},${legacy} crea la ruta del webhook y el cron, y reinicia el gateway de Hermes si está instalado. (escribe "s" para conectar; vacío = saltar)`;
}

export function ownerQuestion(owner: string): string {
  return `El listener del webhook pertenece al perfil "${owner}" de Hermes. Habilitar la plataforma en su config.yaml la activa para todos los perfiles que sirve su gateway, y reiniciarlo corta sus sesiones. ¿Hacerlo? (no = el webhook queda pendiente y el tick sigue operativo)`;
}

export const TOKEN_HELP =
  'Token: portal de desarrolladores de Discord → tu aplicación → Bot → Reset Token. Es el bot de TU servidor; no uses el de otro perfil.';

/** Una respuesta o `null` (cancelación). La validación decide si se repite. */
async function ask(prompts: AssistantPrompts, message: string, masked = false): Promise<string | null> {
  const reply = masked && prompts.password ? await prompts.password(message) : await prompts.text(message);
  return reply === null ? null : reply.trim();
}

/**
 * Paso opt-in del plano de control (la última pregunta del asistente). Solo con entrada enmascarada, terminal y
 * Hermes ≥ 0.23. Vacío o cancelación = cero escrituras. Todas las respuestas son obligatorias.
 */
export async function offerControlStep(prompts: AssistantPrompts, ctx: CliContext, idea: string | null): Promise<number> {
  return (await runControlStep(prompts, ctx, idea)).code;
}

/** El paso interactivo con su informe (init-fiabilidad, IO-02): `null` si no se ofreció (sin Hermes o sin terminal). */
export async function runControlStep(prompts: AssistantPrompts, ctx: CliContext, idea: string | null): Promise<StepResult> {
  if (!prompts.password) {
    return { code: 0, report: null };
  }
  const host = contextHost(ctx);
  let version: string;
  let hermesPath: string;
  try {
    const cli = await resolveHermes(host);
    version = cli.version;
    hermesPath = cli.path;
  } catch (error) {
    if (error instanceof HermesNotFoundError || error instanceof HermesVersionError) {
      ctx.io.out(error instanceof HermesVersionError ? `control: ${error.message}` : LATER_LINE);
      return { code: 0, report: null };
    }
    throw error;
  }
  // CO-01: si el perfil ya existe, la topología y las claves heredadas se conocen antes de preguntar (solo lectura).
  const profileDir = path.join(hermesHome(host), 'profiles', PROFILE);
  let sharedOwner: string | null = null;
  let legacyKeys = false;
  if (await host.exists(profileDir)) {
    const topology = await gatewayTopology({ path: hermesPath, version, run: (args) => host.exec(hermesPath, args, { cwd: host.cwd }) }, PROFILE);
    sharedOwner = topology.shared ? topology.owner : null;
    const envText = await fs.readFile(path.join(profileDir, '.env'), 'utf8').catch(() => '');
    legacyKeys = /^\s*(?:export\s+)?WEBHOOK_(?:ENABLED|PORT)\s*=/m.test(envText);
  }
  const entry = await prompts.text(entryQuestion(version, { sharedOwner, legacyKeys }));
  if (entry === null || !/^(s|si|sí|y|yes)$/i.test(entry.trim())) {
    ctx.io.out(SKIPPED);
    return { code: 0, report: NOT_REQUESTED };
  }
  let unvalidated = false;
  let botId: string | null = null;
  const doFetch: DiscordFetch = ctx.discordFetch ?? defaultDiscordFetch;
  const diagnostic = (line: string): void => ctx.io.err(line);
  prompts.note(TOKEN_HELP);
  // a) Token: obligatorio, enmascarado, validado; un token rechazado nunca se guarda.
  let token = '';
  for (;;) {
    const reply = await ask(prompts, 'Token del bot de Discord (obligatorio; no se mostrará)', true);
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return { code: 0, report: NOT_REQUESTED };
    }
    if (reply === '') {
      prompts.note('El token es obligatorio para conectar el plano de control (Ctrl+C cancela sin escribir nada).');
      continue;
    }
    const check = await checkBotToken(doFetch, reply, diagnostic);
    if (check.kind === 'rejected') {
      prompts.note(tokenMessage(check));
      continue;
    }
    let acceptedUnvalidated = false;
    if (check.kind === 'unreachable') {
      // Un 429 o un 5xx no piden cambiar una respuesta que puede ser correcta; solo la red caída se puede guardar.
      if (check.failure.status !== null) {
        prompts.note(tokenMessage(check));
        continue;
      }
      const save = await prompts.confirm('No se pudo contactar con Discord para validar el token. ¿Guardarlo sin validar?');
      if (save === null) {
        ctx.io.out(CANCELLED);
        return { code: 0, report: NOT_REQUESTED };
      }
      if (!save) {
        continue;
      }
      acceptedUnvalidated = true;
    } else {
      botId = check.botId;
      prompts.note(`Token aceptado por Discord: bot "${check.botName}".`);
    }
    // CO-02: la colisión se comprueba en memoria antes de preguntar por el canal.
    const owner = await tokenOwner(hermesHome(host), reply);
    if (owner !== null) {
      prompts.note(`Ese token es el bot del perfil "${owner}"; ${PROFILE} necesita su propio bot (no se escribió nada).`);
      continue;
    }
    token = reply;
    unvalidated = acceptedUnvalidated;
    break;
  }
  // b) Canal: id numérico o nombre; el bot tiene que verlo.
  let channelId = '';
  let channelName: string | null = null;
  for (;;) {
    const reply = await ask(prompts, 'Canal de Discord de control: id numérico o nombre (#control)');
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return { code: 0, report: NOT_REQUESTED };
    }
    if (reply === '') {
      prompts.note('El canal es obligatorio.');
      continue;
    }
    const channel = await resolveChannel(doFetch, token, reply, { botId, diagnostic });
    if (channel.kind === 'found') {
      channelId = channel.id;
      channelName = channel.name;
      prompts.note(`Canal: ${channel.id}${channel.name ? ` (#${channel.name})` : ''}.`);
      break;
    }
    if (channel.kind === 'unreachable' && channel.failure.status === null && MIN_ID.test(reply)) {
      prompts.note('Discord no responde: se usa el id tal cual, sin validar.');
      channelId = reply;
      unvalidated = true;
      break;
    }
    prompts.note(channelMessage(channel) ?? 'El canal no se pudo validar.');
  }
  // c) Aprobador: id numérico de usuario de Discord (no es secreto).
  let approver = '';
  for (;;) {
    const reply = await ask(prompts, 'Tu id de usuario de Discord como aprobador (numérico)');
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return { code: 0, report: NOT_REQUESTED };
    }
    if (APPROVER_ID.test(reply)) {
      approver = reply;
      break;
    }
    prompts.note('Hace falta el id numérico de usuario (Modo desarrollador → clic derecho → Copiar ID de usuario).');
  }
  // d) TTL y expiración, con valores por defecto.
  let ttlHours = DEFAULT_TTL_HOURS;
  for (;;) {
    const reply = await ask(prompts, `Horas hasta que caduca una decisión sin respuesta (vacío = ${DEFAULT_TTL_HOURS})`);
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return { code: 0, report: NOT_REQUESTED };
    }
    const hours = reply === '' ? DEFAULT_TTL_HOURS : Number(reply);
    if (Number.isFinite(hours) && hours > 0 && hours <= 720) {
      ttlHours = hours;
      break;
    }
    prompts.note('Un número de horas entre 1 y 720.');
  }
  let expire: 'block' | 'notify' = 'block';
  for (;;) {
    const reply = await ask(prompts, 'Al caducar: block (pasa a ai::blocked) o notify (solo aviso) (vacío = block)');
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return { code: 0, report: NOT_REQUESTED };
    }
    if (reply === '' || reply === 'block' || reply === 'notify') {
      expire = reply === 'notify' ? 'notify' : 'block';
      break;
    }
    prompts.note('Responde block o notify.');
  }
  const answers: ConnectAnswers = { token, channelId, channelName, approver, ttlHours, expire };
  const outcome = await connectControlPlane(ctx.root, answers, {
    host,
    hermes: hermesPath,
    idea,
    adoptSoul: async (file) =>
      (await prompts.confirm(
        `El perfil hermes-control ya tiene ${file} sin marcas de AI-Hub. ¿Adoptarlo? Se guardará una copia SOUL.md.pre-ai-hub antes de escribir el bloque gestionado.`,
      )) === true,
    ...(ctx.onConnectStage ? { onStage: ctx.onConnectStage } : {}),
    reconfigure: async () =>
      (await prompts.confirm('El perfil hermes-control ya tiene otro bot. ¿Sustituirlo por este? (no = dejarlo como está)')) === true,
    // design §D9: aceptar la pregunta que ya nombró al dueño es el consentimiento; si no se conocía, se pregunta ahora.
    confirmOwner: async (owner) => owner === sharedOwner || (await prompts.confirm(ownerQuestion(owner))) === true,
    notify: (line) => ctx.io.err(line),
  });
  for (const line of outcome.lines) {
    (outcome.code === 0 ? ctx.io.out : ctx.io.err)(line);
  }
  return { code: outcome.code, report: connectReport(outcome, unvalidated) };
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** El token nunca se acepta como valor de un flag: queda en el historial del shell y en la lista de procesos (D7). */
export const TOKEN_FLAG_REFUSED =
  '--discord-token no se admite: el token del bot se lee solo de la entrada estándar con --discord-token-stdin';

export const CONNECT_USAGE =
  'Uso: ai-hub init --yes --connect-hermes --discord-channel <id|nombre> --approver <id-de-usuario> --discord-token-stdin [--ttl-hours N] [--expire block|notify] [--allow-unvalidated] [--reconfigure-hermes] [--webhook-owner <perfil>]';

/** Nombre de perfil de Hermes aceptable como valor de `--webhook-owner`. */
export const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * init-fiabilidad (CO-07): los argumentos de `--connect-hermes` se validan antes del apply. Devuelve el mensaje de
 * error (salida 2, nada escrito) o `null` si son válidos.
 */
export function validateConnectFlags(flags: Record<string, string | boolean>): string | null {
  if (flags['discord-token'] !== undefined) {
    return TOKEN_FLAG_REFUSED;
  }
  if (!flags['discord-token-stdin']) {
    return `--connect-hermes necesita --discord-token-stdin (el token nunca va en un flag)\n${CONNECT_USAGE}`;
  }
  const text = (name: string): string | null => (typeof flags[name] === 'string' ? (flags[name] as string).trim() : null);
  const channelInput = text('discord-channel');
  const approver = text('approver');
  const ttlRaw = text('ttl-hours');
  const expireRaw = text('expire') ?? 'block';
  const ttlHours = ttlRaw === null ? DEFAULT_TTL_HOURS : Number(ttlRaw);
  if (
    channelInput === null ||
    channelInput === '' ||
    approver === null ||
    !APPROVER_ID.test(approver) ||
    !(ttlHours > 0 && ttlHours <= 720) ||
    (expireRaw !== 'block' && expireRaw !== 'notify')
  ) {
    return CONNECT_USAGE;
  }
  const owner = flags['webhook-owner'];
  if (owner !== undefined && (typeof owner !== 'string' || !OWNER_NAME.test(owner.trim()))) {
    return `--webhook-owner necesita el nombre del perfil dueño del listener\n${CONNECT_USAGE}`;
  }
  return null;
}

/**
 * `init --connect-hermes` (D7): sin preguntas. Canal, aprobador, TTL y expiración por flags; el token solo por stdin.
 * Mismas validaciones que el paso interactivo; sin red, guarda solo con `--allow-unvalidated`.
 */
export async function connectFromFlags(
  flags: Record<string, string | boolean>,
  ctx: CliContext,
  idea: string | null = null,
  token?: string,
): Promise<number> {
  return (await connectFromFlagsReport(flags, ctx, idea, token)).code;
}

/** Igual que `connectFromFlags`, con el informe de integración (init-fiabilidad, DEV-08). */
export async function connectFromFlagsReport(
  flags: Record<string, string | boolean>,
  ctx: CliContext,
  idea: string | null = null,
  preread?: string,
): Promise<StepResult> {
  const invalid = validateConnectFlags(flags);
  if (invalid !== null) {
    ctx.io.err(invalid);
    return { code: 2, report: null };
  }
  const text = (name: string): string => (flags[name] as string).trim();
  const channelInput = text('discord-channel');
  const approver = text('approver');
  const ttlHours = typeof flags['ttl-hours'] === 'string' ? Number(text('ttl-hours')) : DEFAULT_TTL_HOURS;
  const expireRaw: 'block' | 'notify' = typeof flags.expire === 'string' && text('expire') === 'notify' ? 'notify' : 'block';
  const token = (preread ?? (await (ctx.stdin ?? readStdin)())).trim();
  if (token === '') {
    ctx.io.err('--discord-token-stdin: la entrada estándar está vacía; no se escribió nada');
    return { code: 2, report: null };
  }
  const allowUnvalidated = Boolean(flags['allow-unvalidated']);
  let unvalidated = false;
  const doFetch: DiscordFetch = ctx.discordFetch ?? defaultDiscordFetch;
  const diagnostic = (line: string): void => ctx.io.err(line);
  let botId: string | null = null;
  const check = await checkBotToken(doFetch, token, diagnostic);
  if (check.kind === 'rejected') {
    ctx.io.err(`control: ${tokenMessage(check)} (no se escribió nada)`);
    return { code: 1, report: retake('discord') };
  }
  if (check.kind === 'unreachable') {
    if (check.failure.status !== null || !allowUnvalidated) {
      const suffix = check.failure.status === null && !allowUnvalidated
        ? '; repite con --allow-unvalidated para guardarlo sin validar (no se escribió nada)'
        : ' (no se escribió nada)';
      ctx.io.err(`control: ${tokenMessage(check)}${suffix}`);
      return { code: 1, report: retake('discord') };
    }
    unvalidated = true;
  } else {
    botId = check.botId;
  }
  let channelId: string;
  let channelName: string | null = null;
  const channel = await resolveChannel(doFetch, token, channelInput, { botId, diagnostic });
  if (channel.kind === 'found') {
    channelId = channel.id;
    channelName = channel.name;
  } else if (channel.kind === 'unreachable' && channel.failure.status === null && allowUnvalidated && MIN_ID.test(channelInput)) {
    channelId = channelInput;
    unvalidated = true;
  } else {
    ctx.io.err(`control: ${channelMessage(channel) ?? 'el canal no se pudo validar'} (no se escribió nada)`);
    return { code: 1, report: retake('discord') };
  }
  try {
    const outcome = await connectControlPlane(
      ctx.root,
      { token, channelId, channelName, approver, ttlHours, expire: expireRaw },
      {
        host: contextHost(ctx),
        idea,
        reconfigure: async () => Boolean(flags['reconfigure-hermes']),
        ...(typeof flags['webhook-owner'] === 'string' ? { webhookOwner: flags['webhook-owner'].trim() } : {}),
        notify: (line) => ctx.io.err(line),
        ...(ctx.onConnectStage ? { onStage: ctx.onConnectStage } : {}),
      },
    );
    for (const line of outcome.lines) {
      (outcome.code === 0 ? ctx.io.out : ctx.io.err)(line);
    }
    return { code: outcome.code, report: connectReport(outcome, unvalidated) };
  } catch (error) {
    if (error instanceof HermesNotFoundError) {
      ctx.io.err(error.message);
      return { code: 2, report: retake('resolver', [error.message.split('\n')[0]]) };
    }
    if (error instanceof HermesVersionError) {
      ctx.io.err(error.message);
      return { code: 1, report: retake('resolver', [error.message]) };
    }
    throw error;
  }
}
