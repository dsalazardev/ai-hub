import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CliContext, ParsedArgs } from '../cli/types.js';
import { readHarnessEnv } from './dotenv.js';

const USAGE = 'Uso: ai-hub env exec -- <comando> [argumentos…]';

/**
 * Resuelve un ejecutable en Windows recorriendo PATH y PATHEXT, porque `spawn` sin shell no
 * aplica PATHEXT (`npx` es `npx.cmd`). En el resto de plataformas devuelve el comando tal cual.
 */
export function resolveExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32' || command.includes('/') || command.includes('\\') || path.extname(command) !== '') {
    return command;
  }
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '');
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext.toLowerCase()}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export interface EnvExecResult {
  code: number;
  /** Mensaje de error de la propia CLI (nunca contiene valores del entorno). */
  error?: string;
}

/**
 * Ejecuta `command args` con `.ai-hub/.env` cargado en el entorno del hijo cuando existe.
 * La salida del hijo se hereda; la CLI no imprime jamás un valor cargado.
 */
export async function execWithHarnessEnv(root: string, command: string, args: string[]): Promise<EnvExecResult> {
  const fileEnv = (await readHarnessEnv(root)) ?? {};
  const env = { ...process.env, ...fileEnv };
  const resolved = resolveExecutable(command, process.platform, env);
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  return new Promise((resolve) => {
    const child = viaCmd
      ? spawn(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteForCmd).join(' ')}"`],
          { cwd: root, env, stdio: 'inherit', windowsVerbatimArguments: true },
        )
      : spawn(resolved, args, { cwd: root, env, stdio: 'inherit', shell: false });
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve({
        code: error.code === 'ENOENT' ? 127 : 1,
        error:
          error.code === 'ENOENT' ? `comando no encontrado: ${command}` : `no se pudo ejecutar ${command}: ${error.code ?? 'error'}`,
      });
    });
    child.on('close', (status, signal) => {
      resolve({ code: status ?? (signal ? 1 : 0) });
    });
  });
}

export async function cmdEnv(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  if (sub !== 'exec') {
    ctx.io.err(USAGE);
    return 2;
  }
  const passthrough = args.passthrough ?? [];
  if (passthrough.length === 0) {
    ctx.io.err(USAGE);
    return 2;
  }
  const [command, ...rest] = passthrough;
  const result = await execWithHarnessEnv(ctx.root, command, rest);
  if (result.error) {
    ctx.io.err(result.error);
  }
  return result.code;
}
