import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_RUNS_DIR } from './local.js';

/**
 * Lock X1 (harden-harness-orchestration, R-038): un archivo creado en exclusiva con su dueño
 * `{pid, host, startedAt, purpose}`. Solo excluye a los procesos del motor que lo toman; nunca
 * se presenta como exclusión de escritores remotos ni de editores externos.
 *
 * Recuperación conservadora: un lock se recupera solo si su dueño está en este host y su
 * proceso ya no existe. Un lock de otro host, ilegible o cuyo recuperador murió a medias se
 * informa y solo se libera con un comando explícito. La antigüedad no prueba el abandono.
 */

export const LOCK_VERSION = 1;
/** Locks del proyecto (worktree, destinos dentro del proyecto). */
export const PROJECT_LOCKS_DIR = `${HARNESS_RUNS_DIR}/control/locks`;
export const LOCK_RELEASE_COMMAND = 'ai-hub locks release';

export interface LockOwner {
  v: number;
  pid: number;
  host: string;
  startedAt: string;
  purpose: string;
}

export type LockState =
  | { kind: 'free' }
  | { kind: 'live'; owner: LockOwner }
  | { kind: 'stale'; owner: LockOwner }
  | { kind: 'foreign-host'; owner: LockOwner }
  | { kind: 'unreadable' };

export class LockHeldError extends Error {
  constructor(
    readonly file: string,
    readonly state: Exclude<LockState, { kind: 'free' }>,
  ) {
    super(describeHeld(file, state));
    this.name = 'LockHeldError';
  }
}

export interface LockOptions {
  /** Espera máxima por un dueño vivo; 0 = fallar en el acto. */
  waitMs?: number;
  pollMs?: number;
  host?: string;
  pid?: number;
  now?: () => Date;
  /** Inyectable en pruebas: ¿sigue vivo el proceso `pid` de este host? */
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface LockHandle {
  readonly file: string;
  readonly owner: LockOwner;
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: existe pero es de otro usuario.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describeOwner(owner: LockOwner): string {
  return `pid ${owner.pid} en ${owner.host} desde ${owner.startedAt} (${owner.purpose})`;
}

function describeHeld(file: string, state: Exclude<LockState, { kind: 'free' }>): string {
  switch (state.kind) {
    case 'live':
      return `lock ocupado: ${file} lo tiene ${describeOwner(state.owner)}`;
    case 'stale':
      return `lock abandonado: ${file} (${describeOwner(state.owner)}); no se pudo recuperar`;
    case 'foreign-host':
      return `lock de otro host: ${file} lo tiene ${describeOwner(state.owner)}; no se recupera solo: ${LOCK_RELEASE_COMMAND} ${file} --yes`;
    case 'unreadable':
      return `lock ilegible: ${file}; no se recupera solo: ${LOCK_RELEASE_COMMAND} ${file} --yes`;
  }
}

function parseOwner(text: string): LockOwner | null {
  try {
    const data = JSON.parse(text) as Partial<LockOwner>;
    if (
      typeof data.pid === 'number' &&
      Number.isInteger(data.pid) &&
      typeof data.host === 'string' &&
      typeof data.startedAt === 'string' &&
      typeof data.purpose === 'string'
    ) {
      return { v: typeof data.v === 'number' ? data.v : LOCK_VERSION, pid: data.pid, host: data.host, startedAt: data.startedAt, purpose: data.purpose };
    }
  } catch {
    // ilegible
  }
  return null;
}

export async function inspectLock(file: string, options: Pick<LockOptions, 'host' | 'isAlive'> = {}): Promise<LockState> {
  const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (text === null) {
    return { kind: 'free' };
  }
  const owner = parseOwner(text);
  if (owner === null) {
    return { kind: 'unreadable' };
  }
  const host = options.host ?? os.hostname();
  if (owner.host !== host) {
    return { kind: 'foreign-host', owner };
  }
  return (options.isAlive ?? processAlive)(owner.pid) ? { kind: 'live', owner } : { kind: 'stale', owner };
}

async function createExclusive(file: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/**
 * Recupera un lock abandonado bajo un lock de recuperación propio (`<file>.recover`), de modo que
 * entre releer y borrar nadie más pueda crear un lock nuevo que se borre por error.
 */
async function recoverStale(file: string, options: LockOptions, owner: LockOwner): Promise<boolean> {
  const recover = `${file}.recover`;
  const self = ownerRecord('recover', options);
  if (!(await createExclusive(recover, `${JSON.stringify(self)}\n`))) {
    return false;
  }
  try {
    const again = await inspectLock(file, options);
    if (again.kind === 'stale' && again.owner.pid === owner.pid && again.owner.startedAt === owner.startedAt) {
      await fs.rm(file, { force: true });
      return true;
    }
    return again.kind === 'free';
  } finally {
    await fs.rm(recover, { force: true });
  }
}

function ownerRecord(purpose: string, options: LockOptions): LockOwner {
  return {
    v: LOCK_VERSION,
    pid: options.pid ?? process.pid,
    host: options.host ?? os.hostname(),
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    purpose,
  };
}

export async function acquireLock(file: string, purpose: string, options: LockOptions = {}): Promise<LockHandle> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 50;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  for (;;) {
    const owner = ownerRecord(purpose, options);
    if (await createExclusive(file, `${JSON.stringify(owner)}\n`)) {
      return {
        file,
        owner,
        release: async () => {
          const current = await inspectLock(file, options);
          if (current.kind !== 'free' && current.kind !== 'unreadable' && current.owner.pid === owner.pid && current.owner.startedAt === owner.startedAt) {
            await fs.rm(file, { force: true });
          }
        },
      };
    }
    const state = await inspectLock(file, options);
    if (state.kind === 'free') {
      continue;
    }
    if (state.kind === 'stale') {
      const recoverState = await inspectLock(`${file}.recover`, options);
      if (recoverState.kind === 'stale' || recoverState.kind === 'foreign-host' || recoverState.kind === 'unreadable') {
        // Un recuperador murió a medias: no se adivina, se pide liberación explícita.
        throw new LockHeldError(`${file}.recover`, recoverState);
      }
      if (await recoverStale(file, options, state.owner)) {
        continue;
      }
    } else if (state.kind !== 'live') {
      throw new LockHeldError(file, state);
    }
    if (Date.now() - started >= waitMs) {
      throw new LockHeldError(file, state);
    }
    await sleep(pollMs);
  }
}

export async function withLock<T>(file: string, purpose: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const handle = await acquireLock(file, purpose, options);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/** Lock del proyecto: `<root>/.ai-hub/runs/control/locks/<name>.lock`. */
export function projectLockPath(root: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) {
    throw new Error(`nombre de lock inválido: ${name}`);
  }
  return path.join(root, ...PROJECT_LOCKS_DIR.split('/'), `${name}.lock`);
}

/**
 * Directorio de locks del usuario, compartido por worktrees y proyectos del host:
 * `$XDG_STATE_HOME/ai-hub/locks` (o `~/.local/state/ai-hub/locks`) en POSIX y
 * `%LOCALAPPDATA%\ai-hub\locks` en Windows. `AI_HUB_LOCK_DIR` lo sustituye (pruebas).
 */
export function userLockDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (env.AI_HUB_LOCK_DIR) {
    return env.AI_HUB_LOCK_DIR;
  }
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ai-hub', 'locks');
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'ai-hub', 'locks');
}

/** Lock compartido por clave canónica (ruta canónica de un destino, o `tracker|proyecto|iid`). */
export function sharedLockPath(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(userLockDir(env), `${digest}.lock`);
}

/** Clave canónica de un archivo fuera del proyecto (resuelve enlaces si existe). */
export async function canonicalTargetKey(file: string): Promise<string> {
  const resolved = await fs.realpath(file).catch(() => path.resolve(file));
  const normal = path.normalize(resolved);
  return process.platform === 'win32' ? `file:${normal.toLowerCase()}` : `file:${normal}`;
}

/** Liberación explícita: solo lo que una persona pide; informa al dueño que había. */
export async function releaseLockExplicit(file: string, options: Pick<LockOptions, 'host' | 'isAlive'> = {}): Promise<LockState> {
  const state = await inspectLock(file, options);
  if (state.kind === 'live') {
    throw new LockHeldError(file, state);
  }
  if (state.kind !== 'free') {
    await fs.rm(file, { force: true });
  }
  return state;
}
