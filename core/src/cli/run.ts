import { AiHubDirNotFoundError, resolveAiHubDir } from '../paths.js';
import { runSync } from '../sync/sync.js';
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
import type { CliContext, CliIO, CommandHandler, ParsedArgs } from './types.js';
import { processIO } from './types.js';

interface CommandSpec {
  summary: string;
  handler: CommandHandler;
}

async function cmdSync(args: ParsedArgs, ctx: CliContext): Promise<number> {
  try {
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
    const result = await runSync(ctx.root, { check: Boolean(args.flags.check) });
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
    if (error instanceof SyncConfigError) {
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
  install: { summary: 'Materializa el preset y sincroniza los destinos', handler: cmdInstall },
  add: { summary: 'Añade una skill o un agente del preset', handler: cmdAdd },
  sync: { summary: 'Proyecta las fuentes a los destinos; --check informa deriva', handler: cmdSync },
  drift: { summary: 'Informa deriva de hash sin escribir', handler: cmdDrift },
  list: { summary: 'Lista preset, targets, comandos, skills y agentes', handler: cmdList },
  doctor: { summary: 'Diagnostica motor, preset, manifiesto, drift y hooks', handler: cmdDoctor },
  check: { summary: 'Alias de doctor + drift', handler: cmdCheck },
  backups: { summary: 'Lista los snapshots disponibles', handler: cmdBackups },
  restore: { summary: 'Restaura un snapshot', handler: cmdRestore },
  uninstall: { summary: 'Elimina una skill o agente añadido', handler: cmdUninstall },
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
