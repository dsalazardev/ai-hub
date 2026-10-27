import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Git en los tests. Distingue "git no disponible" (el binario no arranca: EPERM, EACCES, ENOENT…)
 * de "git falló" (arranca y sale con un código distinto de 0). Lo primero omite el test; nunca se
 * convierte en un exit 1, porque eso haría fallar la suite por el entorno y no por el código.
 */
export interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

export class GitUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'GitUnavailableError';
  }
}

/** Primer `git` que resuelve el PATH, para nombrarlo en el motivo de la omisión. */
export function gitBinary(): string {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git'] : ['git'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir !== '' && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return 'git (no está en el PATH)';
}

function unavailableReason(error: NodeJS.ErrnoException | undefined, status: number | null): string | null {
  if (error === undefined && status !== null) {
    return null;
  }
  const code = error?.code ?? 'sin código de salida';
  return `git no disponible: ${gitBinary()} no se puede ejecutar (${code})`;
}

/** Motivo para omitir los tests de git, o `null` si git ejecuta y responde a `--version`. */
export function gitUnavailable(): string | null {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false });
  const reason = unavailableReason(result.error as NodeJS.ErrnoException | undefined, result.status);
  if (reason !== null) {
    return reason;
  }
  return result.status === 0 ? null : `git no disponible: ${gitBinary()} --version salió con ${result.status}`;
}

/** Ejecuta git; lanza `GitUnavailableError` si el binario no arranca en lugar de inventar un código. */
export function runGit(args: string[], cwd: string): GitRun {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  const reason = unavailableReason(result.error as NodeJS.ErrnoException | undefined, result.status);
  if (reason !== null || result.status === null) {
    throw new GitUnavailableError(reason ?? 'git no disponible');
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
