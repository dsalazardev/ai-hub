import { spawn, spawnSync } from 'node:child_process';

/**
 * idea-input D9: arnés común de las sondas de terminal real. Toda sonda PTY pasa por `withPty`: timeout
 * explícito (45 s, por debajo del `{ timeout: 90_000 }` de cada `it` del proyecto `integration`), kill del
 * hijo en el `finally` y aserción de que no queda proceso vivo. Un pty que no responde nunca cuelga el gate
 * (`prepublishOnly` corre `npm test`).
 */
export const PTY_TIMEOUT_MS = 45_000;
/** Ventana de reintento tras `kill()`: el proceso tarda en morir. */
export const DEATH_WINDOW_MS = 2_000;

export interface PtyChild {
  pid: number;
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface PtySession {
  child: PtyChild;
  /** Todo lo que el hijo escribió hasta ahora. */
  output(): string;
  /** Espera hasta que la salida contenga `needle` (o expira con el timeout global). */
  waitFor(needle: string | RegExp): Promise<void>;
  /** Código de salida, cuando el hijo termina. */
  exited: Promise<number | null>;
}

/**
 * `true` si el PID sigue vivo. `process.kill(pid, 0)`: éxito = vivo; `EPERM` = vivo (en Windows también
 * para procesos propios vivos); solo `ESRCH` cuenta como muerto.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function pollDead(pid: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (!isAlive(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Garantiza la muerte del PID: sondeo con reintento hasta `DEATH_WINDOW_MS`; si sigue vivo, en Windows
 * `taskkill /F /T /PID` (árbol completo) y en POSIX `SIGKILL` al grupo y al proceso; después, otra ventana.
 * Devuelve `true` si quedó muerto.
 */
export async function ensureDead(pid: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (await pollDead(pid, DEATH_WINDOW_MS)) {
    return true;
  }
  if (platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  } else {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // ya no existe o no es líder de grupo
      }
    }
  }
  return pollDead(pid, DEATH_WINDOW_MS);
}

export class PtyTimeoutError extends Error {
  constructor(label: string, ms: number, tail: string) {
    super(`withPty: "${label}" superó ${ms} ms; últimos bytes del hijo: ${JSON.stringify(tail.slice(-200))}`);
  }
}

/**
 * Ejecuta `run` sobre un hijo en pseudoterminal con timeout, kill en el `finally` y comprobación de que no
 * queda ningún proceso vivo. Lanza `PtyTimeoutError` si `run` no termina a tiempo y un error explícito si
 * el hijo sobrevive al kill.
 */
export async function withPty<T>(
  label: string,
  start: () => PtyChild | Promise<PtyChild>,
  run: (session: PtySession) => Promise<T>,
  timeoutMs: number = PTY_TIMEOUT_MS,
): Promise<T> {
  const child = await start();
  let output = '';
  const waiters: Array<() => void> = [];
  child.onData((data) => {
    output += data;
    for (const wake of waiters.splice(0)) {
      wake();
    }
  });
  const exited = new Promise<number | null>((resolve) => child.onExit(resolve));
  const session: PtySession = {
    child,
    output: () => output,
    exited,
    waitFor: async (needle) => {
      const hit = (): boolean => (typeof needle === 'string' ? output.includes(needle) : needle.test(output));
      while (!hit()) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PtyTimeoutError(label, timeoutMs, output)), timeoutMs);
    });
    return await Promise.race([run(session), timeout]);
  } finally {
    clearTimeout(timer);
    for (const wake of waiters.splice(0)) {
      wake();
    }
    try {
      child.kill();
    } catch {
      // el hijo ya terminó
    }
    if (!(await ensureDead(child.pid))) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(`withPty: el proceso ${child.pid} de "${label}" sigue vivo tras kill y taskkill/SIGKILL`);
    }
  }
}

/** Hijo sin pseudoterminal (pipes): para probar el propio `withPty` con un proceso que nunca responde. */
export function pipeChild(command: string, args: string[]): PtyChild {
  const proc = spawn(command, args, { stdio: 'pipe', detached: process.platform !== 'win32', windowsHide: true });
  if (proc.pid === undefined) {
    throw new Error(`no se pudo lanzar ${command}`);
  }
  return {
    pid: proc.pid,
    write: (data) => {
      proc.stdin.write(data);
    },
    onData: (listener) => {
      proc.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
      proc.stderr.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    onExit: (listener) => {
      proc.on('exit', (code) => listener(code));
    },
    kill: () => {
      proc.kill();
    },
  };
}

interface NodePtyProcess {
  pid: number;
  write(data: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  kill(signal?: string): void;
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string | undefined> },
  ): NodePtyProcess;
}

/**
 * `node-pty` no se declara en `package.json` (D9): se habilita con `npm install --no-save node-pty`. Devuelve
 * el módulo o el motivo exacto por el que la sonda se salta.
 */
export async function loadNodePty(): Promise<{ pty: NodePtyModule } | { reason: string }> {
  const specifier = 'node-pty';
  try {
    const mod = (await import(specifier)) as { default?: NodePtyModule } & Partial<NodePtyModule>;
    const pty = (mod.spawn ? mod : mod.default) as NodePtyModule | undefined;
    if (!pty || typeof pty.spawn !== 'function') {
      return { reason: 'node-pty se cargó pero no expone spawn()' };
    }
    return { pty };
  } catch (error) {
    return {
      reason: `node-pty no disponible (${(error as Error).message.split('\n')[0]}); habilítalo con npm install --no-save node-pty`,
    };
  }
}

export function nodePtyChild(
  pty: NodePtyModule,
  file: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined>; cols?: number; rows?: number },
): PtyChild {
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    onData: (listener) => {
      proc.onData(listener);
    },
    onExit: (listener) => {
      proc.onExit((event) => listener(event.exitCode));
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // ya terminó
      }
    },
  };
}
