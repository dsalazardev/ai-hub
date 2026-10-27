import { spawnSync } from 'node:child_process';

export interface RunResult {
  /** Código de salida; `null` si el proceso no llegó a ejecutarse o fue interrumpido. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Error de arranque (por ejemplo `ENOENT` cuando el ejecutable no existe). */
  error?: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
}

/**
 * Ejecuta un proceso externo. Los argumentos viajan como array, nunca a través de un shell,
 * para que las rutas con espacios no se interpreten. La entrada estándar se cierra.
 */
export type ProcessRunner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 300_000;

export const defaultRunner: ProcessRunner = async (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    shell: false,
    encoding: 'utf8',
    input: '',
    windowsHide: true,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
};

export function succeeded(result: RunResult): boolean {
  return result.error === undefined && result.status === 0;
}
