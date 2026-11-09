import { flagString } from '../cli/args.js';
import type { CliContext, ParsedArgs } from '../cli/types.js';
import { ControlConfigError, runDecide } from './decide.js';
import { runIngest } from './ingest.js';
import { applyPreapproved, applyReply, expireDecisions, type ApplyOutcome } from './apply.js';
import { renderDiscord, renderJson } from './render.js';
import { cmdTick, TICK_USAGE } from './tick.js';
import { TrackerError, type TrackerFetch } from './tracker.js';
import { runEnroll, type EnrollMode } from './enroll.js';
import { HermesNotFoundError, HermesVersionError, type ResolverHost } from './hermes.js';
import fs from 'node:fs/promises';
import os from 'node:os';

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
  '     ai-hub control enroll [--dry-run | --yes | --check] [--hermes <ruta>]',
];

/** Inyección para tests: cliente del tracker y reloj. */
export interface ControlDeps {
  trackerFetch?: TrackerFetch;
  now?: () => Date;
  stdin?: () => Promise<string>;
  /** Host para resolver y ejecutar el CLI de Hermes (enroll). */
  hermesHost?: ResolverHost;
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
    const { fresh, settings } = await runDecide(ctx.root, {
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
  try {
    const outcome = await runEnroll(ctx.root, {
      mode,
      host: deps.hermesHost ?? processHost(ctx),
      ...(flagString(args, 'hermes') !== null ? { hermes: flagString(args, 'hermes') ?? undefined } : {}),
    });
    return emit(outcome, ctx);
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
