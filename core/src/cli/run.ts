import { AiHubDirNotFoundError, resolveAiHubDir } from '../paths.js';
import { checkLock, runSync, SyncSourceCheckoutError, SyncSourceError, type LockCheckResult } from '../sync/sync.js';
import { SyncConfigError } from '../sync/config.js';
import { diagnose, printReport } from './doctor.js';
import { parseArgs } from './args.js';
import { cmdContext } from './context.js';
import { cmdDrift } from './drift.js';
import { cmdJudge, cmdVerify } from './legacy.js';
import { cmdMemory } from './memory.js';
import {
  cmdAdd,
  cmdBackups,
  cmdList,
  cmdPurge,
  cmdRestore,
  cmdUninstall,
  cmdUpgrade,
} from './maintenance.js';
import { cmdInit, cmdInstall, cmdRepair } from './onboarding.js';
import { cmdTrunk } from './trunk.js';
import { cmdWorktrees } from './worktrees.js';
import { cliVersion } from './onboarding.js';
import { sourceCheckout } from './source.js';
import type { CliContext, CliIO, CommandHandler, ParsedArgs } from './types.js';
import { processIO } from './types.js';

interface CommandSpec {
  summary: string;
  handler: CommandHandler;
}

function printLockCheck(result: LockCheckResult, ctx: CliContext): void {
  const header = `destinos esperados ${result.expectedCount} / actuales ${result.actualCount} · sources ${result.expectedSourceCount}/${result.actualSourceCount}`;
  const extraCategories =
    result.breakdown.other > 0 ? `, other ${result.breakdown.other}` : '';
  const breakdown = `desglose: skills ${result.breakdown.skills}, agents ${result.breakdown.agents}, rules ${result.breakdown.rules}, preflight ${result.breakdown.preflight}, mcp ${result.breakdown.mcp}${extraCategories}`;
  if (result.ok) {
    ctx.io.out(`[OK]    lock: ${header}`);
    ctx.io.out(breakdown);
    return;
  }
  ctx.io.err(`[FAIL]  lock: ${header}`);
  ctx.io.out(breakdown);
  if (result.error !== null) {
    ctx.io.err(result.error);
  }
  for (const [label, list] of [
    ['faltan', result.missing],
    ['sobran', result.extra],
    ['difieren', result.different],
    ['sources inválidas', result.invalidSources],
  ] as const) {
    ctx.io.out(`${label}: ${list.length}`);
    for (const item of list) {
      ctx.io.out(`  ${item}`);
    }
  }
}

async function cmdSync(args: ParsedArgs, ctx: CliContext): Promise<number> {
  try {
    if (args.flags['check-lock']) {
      const source = await sourceCheckout(ctx.root);
      if (source.isSource) {
        ctx.io.out('[OK]    lock: no aplica en el checkout del motor');
        return 0;
      }
      const result = await checkLock(ctx.root);
      printLockCheck(result, ctx);
      return result.ok ? 0 : 1;
    }
    if (args.flags['dry-run']) {
      const preview = await runSync(ctx.root, { check: true });
      for (const problem of preview.problems) {
        ctx.io.out(`[DRY-RUN] ${problem}`);
      }
      ctx.io.out(
        preview.problems.length === 0
          ? '[DRY-RUN] sin cambios pendientes'
          : `[DRY-RUN] ${preview.problems.length} cambios pendientes; no se escribió nada`,
      );
      return preview.problems.length === 0 ? 0 : 1;
    }
    const result = await runSync(ctx.root, {
      check: Boolean(args.flags.check),
      force: Boolean(args.flags.force),
    });
    if (args.flags.check) {
      if (result.problems.length > 0) {
        for (const problem of result.problems) {
          ctx.io.err(`[FAIL]  ${problem}`);
        }
        ctx.io.err(`Ejecuta ai-hub sync tras editar la fuente en ${ctx.root}`);
        return 1;
      }
      ctx.io.out('[OK]    Destinos sincronizados');
      return 0;
    }
    ctx.io.out(`[OK]    Escritos: ${result.written.length} · Eliminados: ${result.removed.length}`);
    return 0;
  } catch (error) {
    if (
      error instanceof SyncConfigError ||
      error instanceof SyncSourceError ||
      error instanceof SyncSourceCheckoutError
    ) {
      ctx.io.err(error.message);
      return 1;
    }
    ctx.io.err(`Error en sync: ${(error as Error).message}`);
    return 1;
  }
}

async function cmdDoctor(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  const report = await diagnose(ctx);
  printReport(report, ctx);
  return report.ok ? 0 : 1;
}

async function cmdCheck(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  return cmdDoctor(_args, ctx);
}

export const COMMANDS: Record<string, CommandSpec> = {
  init: { summary: 'Detecta el stack, elige preset y aplica un plan reproducible', handler: cmdInit },
  install: { summary: 'Materializa el catálogo o el preset según la selección y sincroniza', handler: cmdInstall },
  add: { summary: 'Añade una skill o cualquier agente del catálogo', handler: cmdAdd },
  sync: { summary: 'Proyecta las fuentes a los destinos; --check informa deriva', handler: cmdSync },
  drift: { summary: 'Informa deriva de hash sin escribir', handler: cmdDrift },
  list: { summary: 'Lista preset, targets, comandos, skills y agentes', handler: cmdList },
  doctor: { summary: 'Diagnostica motor, preset, manifiesto, drift y hooks', handler: cmdDoctor },
  check: { summary: 'Alias de doctor', handler: cmdCheck },
  backups: { summary: 'Lista los snapshots disponibles', handler: cmdBackups },
  restore: { summary: 'Restaura un snapshot', handler: cmdRestore },
  uninstall: { summary: 'Elimina una skill, agente o regla añadida', handler: cmdUninstall },
  purge: { summary: 'Elimina el arnés tras crear un snapshot', handler: cmdPurge },
  upgrade: { summary: 'Actualiza el paquete y re-sincroniza', handler: cmdUpgrade },
  repair: { summary: 'Reaplica solo lo que falta o está roto', handler: cmdRepair },
  worktrees: { summary: 'Lista o reapea worktrees con reglas conservadoras', handler: cmdWorktrees },
  trunk: { summary: 'Muestra, cierra o abre la rama trunk', handler: cmdTrunk },
  memory: { summary: 'Escribe, lista y reanuda el ledger de .planning', handler: cmdMemory },
  context: { summary: 'Regenera .planning/context-next.md', handler: cmdContext },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

const LEGACY_COMMANDS: Record<string, CommandHandler> = {
  verify: (_args, ctx) => cmdVerify(ctx),
  judge: (_args, ctx) => cmdJudge(ctx),
};

export function printHelp(io: CliIO): void {
  io.out('Uso: ai-hub <comando> [opciones]');
  io.out('');
  io.out(`Comandos (${COMMAND_NAMES.length}):`);
  for (const name of COMMAND_NAMES) {
    io.out(`  ${name.padEnd(10)} ${COMMANDS[name].summary}`);
  }
  io.out('');
  io.out('add agent acepta cualquier agente del catálogo, no solo los del preset.');
  io.out('Publicación: prepublishOnly ejecuta build, manifest:build y npm test (unit + integración).');
  io.out('Compatibilidad: verify, judge (fuera del catálogo).');
}

export async function createContext(cwd: string, io: CliIO): Promise<CliContext> {
  try {
    const location = resolveAiHubDir(cwd);
    return { cwd, root: location.dir, source: location.source, io };
  } catch (error) {
    if (error instanceof AiHubDirNotFoundError) {
      return { cwd, root: cwd, source: null, io };
    }
    throw error;
  }
}

export interface RunCliOptions {
  cwd?: string;
  io?: CliIO;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? processIO;
  const cwd = options.cwd ?? process.cwd();
  const [command, ...rest] = argv;
  const ctx = await createContext(cwd, io);

  if (!command) {
    printHelp(io);
    return 2;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(io);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    io.out(await cliVersion());
    return 0;
  }

  const spec = COMMANDS[command];
  if (spec) {
    try {
      return await spec.handler(parseArgs(rest), ctx);
    } catch (error) {
      io.err(`Error inesperado en "${command}": ${(error as Error).message}`);
      return 1;
    }
  }

  const legacy = LEGACY_COMMANDS[command];
  if (legacy) {
    return legacy(parseArgs(rest), ctx);
  }

  io.err(`Comando desconocido: ${command}`);
  printHelp(io);
  return 2;
}
