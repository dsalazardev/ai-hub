import { flagString } from '../cli/args.js';
import type { CliContext, ParsedArgs } from '../cli/types.js';
import { ControlConfigError, runDecide } from './decide.js';
import { runIngest } from './ingest.js';
import { applyPreapproved, applyReply, expireDecisions, type ApplyOutcome } from './apply.js';
import { renderDiscord, renderJson } from './render.js';
import { cmdTick, TICK_USAGE } from './tick.js';
import { defaultTrackerFetch, trackerFromHarness, TrackerError, type TrackerFetch } from './tracker.js';
import { openChangeRequest } from '../delivery/change-request.js';
import { runEnroll, type EnrollMode } from './enroll.js';
import { canExecute, hermesHome, HermesNotFoundError, HermesVersionError, resolveHermes, supportsCronPause, type ResolverHost } from './hermes.js';
import { resetHealth } from './health.js';
import { runPoll, type PollHost } from './poll.js';
import { PROFILE } from './enroll.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `ai-hub control <sub>`: lado del arnés de hermes-control. `tick` solo propone (0.11.0); el resto
 * exige `manifest.control` y sale 2 nombrando lo que falta. Ningún subcomando imprime credenciales.
 */
export const CONTROL_USAGE = [
  TICK_USAGE,
  '     ai-hub control decide (--online | --labels-from <archivo>) [--issue <iid>] [--format discord|json] [--limit N] [--ref <rama>]',
  '     ai-hub control ingest [--format discord|json]   (payload de GitLab por stdin)',
  '     ai-hub control apply (--reply "<texto>" | -- aprobar|rechazar|detalle <iid> …) --approver <id-discord> [--ref <rama>]',
  '     ai-hub control apply --preapproved',
  '     ai-hub control expire',
  '     ai-hub control poll [--probe | --reset-health]',
  '     ai-hub control deliver <iid> --target <rama> --summary "<texto>" --evidence "<texto>" --url <issue>',
  '     ai-hub control enroll [--dry-run | --yes | --check [--wait[=segundos]]] [--hermes <ruta>] [--webhook-owner <perfil>]',
];

/** Inyección para tests: cliente del tracker y reloj. */
export interface ControlDeps {
  trackerFetch?: TrackerFetch;
  now?: () => Date;
  stdin?: () => Promise<string>;
  /** Host para resolver y ejecutar el CLI de Hermes (enroll). */
  hermesHost?: ResolverHost;
  /** Host de Hermes para el poll (cron y estado del gateway); `null` = sin Hermes. */
  pollHost?: PollHost | null;
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

let deps: ControlDeps = {};

export function setControlDeps(next: ControlDeps): void {
  deps = next;
}

function intFlag(args: ParsedArgs, name: string): number | undefined | null {
  const raw = flagString(args, name);
  if (raw === null) {
    return undefined;
  }
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** Errores conocidos → mensaje sin secretos y exit (2 configuración, 1 tracker). */
export function reportError(error: unknown, ctx: CliContext): number {
  if (error instanceof ControlConfigError || error instanceof HermesNotFoundError) {
    ctx.io.err(error.message);
    return 2;
  }
  if (error instanceof HermesVersionError) {
    ctx.io.err(error.message);
    return 1;
  }
  if (error instanceof TrackerError) {
    ctx.io.err(error.message);
    return error.status === null && /faltan|necesita/.test(error.message) ? 2 : 1;
  }
  ctx.io.err((error as Error).message);
  return 2;
}

async function cmdDecide(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const format = flagString(args, 'format') ?? 'discord';
  const issue = intFlag(args, 'issue');
  const limit = intFlag(args, 'limit');
  const labelsFrom = flagString(args, 'labels-from');
  if ((format !== 'discord' && format !== 'json') || issue === null || limit === null || (!args.flags.online && labelsFrom === null)) {
    ctx.io.err(CONTROL_USAGE[1].trim());
    return 2;
  }
  try {
    const { fresh, settings, barrier, stopped } = await runDecide(ctx.root, {
      online: Boolean(args.flags.online),
      ...(labelsFrom !== null ? { labelsFrom } : {}),
      ...(issue !== undefined ? { issue } : {}),
      // Discord: una decisión por mensaje (cada ejecución del cron o del webhook es un mensaje).
      limit: limit ?? (format === 'discord' ? 1 : Number.POSITIVE_INFINITY),
      ...(flagString(args, 'ref') !== null ? { ref: flagString(args, 'ref') ?? undefined } : {}),
      ...(deps.trackerFetch ? { trackerFetch: deps.trackerFetch } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    });
    if (format === 'json') {
      ctx.io.out(JSON.stringify(fresh.map(renderJson), null, 2));
    } else if (fresh.length > 0) {
      ctx.io.out(renderDiscord(fresh[0], settings.expire));
    }
    for (const line of stopped) {
      ctx.io.err(`[ai-hub] ${line}`);
    }
    if (barrier !== null) {
      ctx.io.err(`[ai-hub] registro de decisiones detenido: ${barrier}`);
      return 1;
    }
    return 0;
  } catch (error) {
    return reportError(error, ctx);
  }
}

async function cmdIngest(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const format = flagString(args, 'format') ?? 'discord';
  if (format !== 'discord' && format !== 'json') {
    ctx.io.err(CONTROL_USAGE[2].trim());
    return 2;
  }
  try {
    const result = await runIngest(ctx.root, await (deps.stdin ?? readStdin)(), {
      limit: format === 'discord' ? 1 : Number.POSITIVE_INFINITY,
      ...(deps.trackerFetch ? { trackerFetch: deps.trackerFetch } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    });
    if (format === 'json') {
      ctx.io.out(
        JSON.stringify(
          { outcome: result.outcome, reason: result.reason ?? null, superseded: result.superseded, decisions: result.fresh.map(renderJson) },
          null,
          2,
        ),
      );
    } else if (result.fresh.length > 0) {
      ctx.io.out(renderDiscord(result.fresh[0], result.expire));
    }
    return 0;
  } catch (error) {
    return reportError(error, ctx);
  }
}

function emit(outcome: ApplyOutcome, ctx: CliContext): number {
  for (const line of outcome.lines) {
    (outcome.code === 0 ? ctx.io.out : ctx.io.err)(line);
  }
  return outcome.code;
}

/**
 * La skill de Hermes pasa la respuesta como argumentos tras `--` (sin comillas que un texto malicioso pueda
 * cerrar); `--reply` admite el texto literal para uso manual.
 */
async function cmdApply(args: ParsedArgs, ctx: CliContext): Promise<number> {
  if (args.flags['verify-message'] !== undefined) {
    // 5.4: releer el mensaje en Discord exige el token del bot y un endpoint que este change no ha verificado.
    ctx.io.err(
      '--verify-message no está disponible: el endpoint de Discord para releer el mensaje no está verificado (PENDIENTE). La aprobación se valida con la gramática, el hash de la decisión y manifest.control.approvers.',
    );
    return 2;
  }
  const ref = flagString(args, 'ref');
  const options = {
    ...(deps.trackerFetch ? { trackerFetch: deps.trackerFetch } : {}),
    ...(deps.now ? { now: deps.now() } : {}),
    ...(ref !== null ? { ref } : {}),
  };
  try {
    if (args.flags.preapproved) {
      return emit(await applyPreapproved(ctx.root, options), ctx);
    }
    const reply = flagString(args, 'reply') ?? (args.passthrough && args.passthrough.length > 0 ? args.passthrough.join(' ') : null);
    if (reply === null) {
      for (const line of CONTROL_USAGE.slice(3, 5)) {
        ctx.io.err(line.trim());
      }
      return 2;
    }
    return emit(await applyReply(ctx.root, reply, flagString(args, 'approver') ?? undefined, options), ctx);
  } catch (error) {
    return reportError(error, ctx);
  }
}

async function cmdExpire(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  try {
    return emit(
      await expireDecisions(ctx.root, { ...(deps.trackerFetch ? { trackerFetch: deps.trackerFetch } : {}), ...(deps.now ? { now: deps.now() } : {}) }),
      ctx,
    );
  } catch (error) {
    return reportError(error, ctx);
  }
}

function processHost(ctx: CliContext): ResolverHost {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    cwd: ctx.root,
    exec: ctx.exec,
    exists: (file) => fs.access(file).then(() => true, () => false),
    executable: (file) => canExecute(file),
  };
}

/** `enroll`: siempre opt-in; sin `--yes` ni `--check` es un `--dry-run`. */
async function cmdEnroll(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const modes = (['dry-run', 'yes', 'check'] as const).filter((mode) => Boolean(args.flags[mode]));
  if (modes.length > 1) {
    ctx.io.err(CONTROL_USAGE[6].trim());
    return 2;
  }
  const mode: EnrollMode = modes[0] ?? 'dry-run';
  // webhook-operativo §D9: el consentimiento nombra al dueño del listener; se valida antes de escribir nada.
  const owner = args.flags['webhook-owner'];
  if (owner !== undefined && (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner.trim()))) {
    ctx.io.err(`--webhook-owner necesita el nombre del perfil dueño del listener\n${CONTROL_USAGE[6].trim()}`);
    return 2;
  }
  // fabrica-verificable §D2: `--check --wait[=segundos]` espera, solo lectura, a un gateway que acaba de reiniciarse.
  const waitFlag = args.flags.wait;
  let wait: boolean | number | undefined;
  if (waitFlag !== undefined && waitFlag !== false) {
    const seconds = typeof waitFlag === 'string' ? waitFlag.trim() : null;
    if (mode !== 'check' || (seconds !== null && !(/^[0-9]+$/.test(seconds) && Number(seconds) <= 900))) {
      ctx.io.err(`--wait solo acompaña a --check y admite segundos entre 0 y 900 (${CONTROL_USAGE[6].trim()})`);
      return 2;
    }
    wait = seconds !== null ? Number(seconds) : true;
  }
  try {
    const outcome = await runEnroll(ctx.root, {
      mode,
      ...(wait !== undefined ? { wait } : {}),
      host: deps.hermesHost ?? processHost(ctx),
      ...(typeof owner === 'string' ? { webhookOwner: owner.trim() } : {}),
      notify: (line) => ctx.io.err(line),
      ...(flagString(args, 'hermes') !== null ? { hermes: flagString(args, 'hermes') ?? undefined } : {}),
    });
    return emit(outcome, ctx);
  } catch (error) {
    return reportError(error, ctx);
  }
}

/** Host real del poll: `hermes -p hermes-control cron …` y `gateway_state.json`; sin Hermes, `null`. */
async function processPollHost(ctx: CliContext): Promise<PollHost | null> {
  const host = deps.hermesHost ?? processHost(ctx);
  let cli;
  try {
    cli = await resolveHermes(host);
  } catch {
    return null;
  }
  const home = hermesHome(host);
  const cron = (args: string[]) => cli.run(['-p', PROFILE, 'cron', ...args]);
  return {
    cronJobs: async () => {
      const result = await cron(['list']);
      return result.status === 0 ? (result.stdout.match(/[a-z0-9][a-z0-9-]*/gi) ?? []).map((word) => word.toLowerCase()) : null;
    },
    // 4.25: pausar y reanudar solo desde la versión verificada; por debajo, el poll se queda en el aviso manual.
    pause: async (job) => supportsCronPause(cli.version) && (await cron(['pause', job])).status === 0,
    resume: async (job) => supportsCronPause(cli.version) && (await cron(['resume', job])).status === 0,
    // Evidencia documentada (1.7): `gateway_state.json` del home (multiplexor) o del perfil.
    gatewayStarting: async () => {
      for (const file of [path.join(home, 'gateway_state.json'), path.join(home, 'profiles', PROFILE, 'gateway_state.json')]) {
        const text = await fs.readFile(file, 'utf8').catch(() => null);
        if (text !== null) {
          try {
            return (JSON.parse(text) as { gateway_state?: unknown }).gateway_state === 'starting';
          } catch {
            return false;
          }
        }
      }
      return false;
    },
  };
}

/** `poll`: todo va a stdout, que el cron entrega a Discord; el código distingue el fallo. */
async function cmdPoll(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const now = deps.now ? deps.now() : new Date();
  try {
    if (args.flags['reset-health']) {
      const aside = await resetHealth(ctx.root, now);
      ctx.io.out(aside === null ? 'la salud del poll es legible; no hay nada que recuperar' : `salud del poll recuperada; el estado ilegible queda apartado en ${aside}`);
      return 0;
    }
    const outcome = await runPoll(ctx.root, {
      now,
      probe: Boolean(args.flags.probe),
      host: deps.pollHost !== undefined ? deps.pollHost : await processPollHost(ctx),
      ...(deps.trackerFetch ? { trackerFetch: deps.trackerFetch } : {}),
    });
    for (const line of outcome.lines) {
      ctx.io.out(line);
    }
    return outcome.code;
  } catch (error) {
    return reportError(error, ctx);
  }
}

/** `deliver`: el componente de entrega abre (o reencuentra) el MR en draft de la issue; nunca aprueba ni fusiona. */
async function cmdDeliver(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const iid = Number.parseInt(args.positionals[1] ?? '', 10);
  const target = flagString(args, 'target');
  const summary = flagString(args, 'summary');
  const evidence = flagString(args, 'evidence');
  const url = flagString(args, 'url');
  if (!Number.isInteger(iid) || target === null || summary === null || evidence === null || url === null) {
    ctx.io.err(CONTROL_USAGE.find((line) => line.includes('control deliver'))?.trim() ?? 'uso: ai-hub control deliver');
    return 2;
  }
  try {
    const { loadManifestContext } = await import('../manifest/manifest.js');
    const manifest = (await loadManifestContext(ctx.root)).manifest;
    const tracker = await trackerFromHarness(ctx.root, manifest, deps.trackerFetch ?? defaultTrackerFetch);
    const issue = await tracker.issue(iid);
    const result = await openChangeRequest(ctx.root, tracker, { iid, title: issue.title, target, summary, testEvidence: evidence, issueUrl: url });
    ctx.io.out(`#${iid}: ${tracker.changeRequestName.short} ${tracker.changeRequestName.ref}${result.iid} ${result.created ? 'abierto en draft' : 'ya existía'}; ${result.reason}`);
    return 0;
  } catch (error) {
    return reportError(error, ctx);
  }
}

const SUBCOMMANDS: Record<string, (args: ParsedArgs, ctx: CliContext) => Promise<number>> = {
  tick: cmdTick,
  decide: cmdDecide,
  ingest: cmdIngest,
  apply: cmdApply,
  expire: cmdExpire,
  enroll: cmdEnroll,
  poll: cmdPoll,
  deliver: cmdDeliver,
};

export async function cmdControl(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  const handler = sub ? SUBCOMMANDS[sub] : undefined;
  if (!handler) {
    ctx.io.err(CONTROL_USAGE.join('\n'));
    return 2;
  }
  return handler(args, ctx);
}
