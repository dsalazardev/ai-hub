import fs from 'node:fs/promises';
import os from 'node:os';
import type { AssistantPrompts } from '../cli/assistant.js';
import type { CliContext } from '../cli/types.js';
import {
  APPROVER_ID,
  checkBotToken,
  connectControlPlane,
  defaultDiscordFetch,
  resolveChannel,
  MIN_ID,
  type ConnectAnswers,
  type DiscordFetch,
} from './onboard.js';
import { HermesNotFoundError, HermesVersionError, resolveHermes, type ResolverHost } from './hermes.js';
import { DEFAULT_TTL_HOURS } from './ledger.js';

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
    }
  );
}

export const LATER_LINE = 'control: Hermes no detectado; cuando lo instales, conecta el plano de control con ai-hub control enroll';
const SKIPPED = 'control: paso saltado; no se escribió nada';
const CANCELLED = 'control: cancelado; no se escribió nada';

export function entryQuestion(version: string): string {
  return `Hermes v${version} detectado. ¿Conectar el plano de control ahora? Crea el perfil hermes-control con TU bot, guarda su token en el .env del perfil y reinicia el gateway de Hermes. (escribe "s" para conectar; vacío = saltar)`;
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
  if (!prompts.password) {
    return 0;
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
      return 0;
    }
    throw error;
  }
  const entry = await prompts.text(entryQuestion(version));
  if (entry === null || !/^(s|si|sí|y|yes)$/i.test(entry.trim())) {
    ctx.io.out(SKIPPED);
    return 0;
  }
  const doFetch: DiscordFetch = ctx.discordFetch ?? defaultDiscordFetch;
  prompts.note(TOKEN_HELP);
  // a) Token: obligatorio, enmascarado, validado; un token rechazado nunca se guarda.
  let token = '';
  for (;;) {
    const reply = await ask(prompts, 'Token del bot de Discord (obligatorio; no se mostrará)', true);
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return 0;
    }
    if (reply === '') {
      prompts.note('El token es obligatorio para conectar el plano de control (Ctrl+C cancela sin escribir nada).');
      continue;
    }
    const check = await checkBotToken(doFetch, reply);
    if (check.kind === 'valid') {
      prompts.note(`Token aceptado por Discord: bot "${check.botName}".`);
      token = reply;
      break;
    }
    if (check.kind === 'rejected') {
      prompts.note(`Discord rechazó el token (HTTP ${check.status}); no se guarda. Copia uno nuevo con Reset Token.`);
      continue;
    }
    const save = await prompts.confirm('No se pudo contactar con Discord para validar el token. ¿Guardarlo sin validar?');
    if (save === null) {
      ctx.io.out(CANCELLED);
      return 0;
    }
    if (save) {
      token = reply;
      break;
    }
  }
  // b) Canal: id numérico o nombre; el bot tiene que verlo.
  let channelId = '';
  let channelName: string | null = null;
  for (;;) {
    const reply = await ask(prompts, 'Canal de Discord de control: id numérico o nombre (#control)');
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return 0;
    }
    if (reply === '') {
      prompts.note('El canal es obligatorio.');
      continue;
    }
    const channel = await resolveChannel(doFetch, token, reply);
    if (channel.kind === 'found') {
      channelId = channel.id;
      channelName = channel.name;
      prompts.note(`Canal: ${channel.id}${channel.name ? ` (#${channel.name})` : ''}.`);
      break;
    }
    if (channel.kind === 'unreachable' && MIN_ID.test(reply)) {
      prompts.note('Discord no responde: se usa el id tal cual, sin validar.');
      channelId = reply;
      break;
    }
    prompts.note(
      channel.kind === 'ambiguous'
        ? `Hay ${channel.count} canales con ese nombre; escribe el id numérico.`
        : 'El bot no ve ese canal: invítalo al servidor (README › Provisión de Discord, paso 4) o escribe el id numérico.',
    );
  }
  // c) Aprobador: id numérico de usuario de Discord (no es secreto).
  let approver = '';
  for (;;) {
    const reply = await ask(prompts, 'Tu id de usuario de Discord como aprobador (numérico)');
    if (reply === null) {
      ctx.io.out(CANCELLED);
      return 0;
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
      return 0;
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
      return 0;
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
    reconfigure: async () =>
      (await prompts.confirm('El perfil hermes-control ya tiene otro bot. ¿Sustituirlo por este? (no = dejarlo como está)')) === true,
  });
  for (const line of outcome.lines) {
    (outcome.code === 0 ? ctx.io.out : ctx.io.err)(line);
  }
  return outcome.code;
}

async function readStdin(): Promise<string> {
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

/**
 * `init --connect-hermes` (D7): sin preguntas. Canal, aprobador, TTL y expiración por flags; el token solo por stdin.
 * Mismas validaciones que el paso interactivo; sin red, guarda solo con `--allow-unvalidated`.
 */
export async function connectFromFlags(flags: Record<string, string | boolean>, ctx: CliContext): Promise<number> {
  const text = (name: string): string | null => (typeof flags[name] === 'string' ? (flags[name] as string).trim() : null);
  const channelInput = text('discord-channel');
  const approver = text('approver');
  const ttlRaw = text('ttl-hours');
  const expireRaw = text('expire') ?? 'block';
  const usage =
    'Uso: ai-hub init --yes --connect-hermes --discord-channel <id|nombre> --approver <id-de-usuario> --discord-token-stdin [--ttl-hours N] [--expire block|notify] [--allow-unvalidated] [--reconfigure-hermes]';
  if (!flags['discord-token-stdin']) {
    ctx.io.err(`--connect-hermes necesita --discord-token-stdin (el token nunca va en un flag)\n${usage}`);
    return 2;
  }
  const ttlHours = ttlRaw === null ? DEFAULT_TTL_HOURS : Number(ttlRaw);
  if (channelInput === null || approver === null || !APPROVER_ID.test(approver) || !(ttlHours > 0 && ttlHours <= 720) || (expireRaw !== 'block' && expireRaw !== 'notify')) {
    ctx.io.err(usage);
    return 2;
  }
  const token = (await (ctx.stdin ?? readStdin)()).trim();
  if (token === '') {
    ctx.io.err('--discord-token-stdin: la entrada estándar está vacía; no se escribió nada');
    return 2;
  }
  const allowUnvalidated = Boolean(flags['allow-unvalidated']);
  const doFetch: DiscordFetch = ctx.discordFetch ?? defaultDiscordFetch;
  const check = await checkBotToken(doFetch, token);
  if (check.kind === 'rejected') {
    ctx.io.err(`control: Discord rechazó el token (HTTP ${check.status}); no se guardó nada`);
    return 1;
  }
  if (check.kind === 'unreachable' && !allowUnvalidated) {
    ctx.io.err('control: no se pudo contactar con Discord para validar el token; repite con --allow-unvalidated para guardarlo sin validar (no se escribió nada)');
    return 1;
  }
  let channelId: string;
  let channelName: string | null = null;
  const channel = await resolveChannel(doFetch, token, channelInput);
  if (channel.kind === 'found') {
    channelId = channel.id;
    channelName = channel.name;
  } else if (channel.kind === 'unreachable' && allowUnvalidated && MIN_ID.test(channelInput)) {
    channelId = channelInput;
  } else {
    ctx.io.err(
      channel.kind === 'ambiguous'
        ? `control: hay ${channel.count} canales con ese nombre; usa el id numérico (no se escribió nada)`
        : 'control: el bot no ve ese canal; invítalo o usa el id numérico (no se escribió nada)',
    );
    return 1;
  }
  try {
    const outcome = await connectControlPlane(
      ctx.root,
      { token, channelId, channelName, approver, ttlHours, expire: expireRaw },
      { host: contextHost(ctx), idea: null, reconfigure: async () => Boolean(flags['reconfigure-hermes']) },
    );
    for (const line of outcome.lines) {
      (outcome.code === 0 ? ctx.io.out : ctx.io.err)(line);
    }
    return outcome.code;
  } catch (error) {
    if (error instanceof HermesNotFoundError) {
      ctx.io.err(error.message);
      return 2;
    }
    if (error instanceof HermesVersionError) {
      ctx.io.err(error.message);
      return 1;
    }
    throw error;
  }
}
