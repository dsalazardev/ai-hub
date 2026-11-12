import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ProcessRunner, RunResult } from '../speckit/runner.js';

/**
 * Resolución del CLI de Hermes en cualquier plataforma y ubicación (hermes-control, 4.6). Orden:
 * `--hermes <ruta>`, `HERMES_BIN`, el PATH (en Windows también `.exe`, `.cmd`, `.bat`) y las ubicaciones de
 * instalación documentadas (instalador nativo, pipx, pip, npm). Exige la versión mínima verificada.
 */
export const MIN_HERMES_VERSION = '0.23.0';

export interface ResolverHost {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists(file: string): Promise<boolean>;
  /** En POSIX distingue «presente» de «ejecutable»; en Windows el permiso no se expresa igual. */
  executable?(file: string): Promise<boolean>;
  exec: ProcessRunner;
  cwd: string;
}

export interface HermesCli {
  path: string;
  version: string;
  /** Ejecuta el CLI con argumentos (los `.cmd`/`.bat` pasan por `cmd.exe`, sin shell para el resto). */
  run(args: string[]): Promise<RunResult>;
}

export interface HermesRejection {
  path: string;
  reason: string;
}

export class HermesNotFoundError extends Error {
  constructor(
    readonly tried: string[],
    readonly rejections: HermesRejection[] = tried.map((path) => ({ path, reason: 'no existe' })),
  ) {
    super(
      `Hermes no está instalado o no se encuentra; rutas probadas:\n${rejections
        .map((item) => `  - ${item.path}: ${item.reason}`)
        .join('\n')}`,
    );
    this.name = 'HermesNotFoundError';
  }
}

export class HermesVersionError extends Error {
  constructor(
    readonly found: string,
    readonly minimum: string,
    readonly cliPath: string,
  ) {
    super(`Hermes ${found} en ${cliPath} es anterior a la mínima ${minimum}; actualízalo (hermes update)`);
    this.name = 'HermesVersionError';
  }
}

function joiner(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? path.win32.join : path.posix.join;
}

/** Candidatos en orden; la lista completa se nombra si ninguno resuelve. */
export function hermesCandidates(host: ResolverHost, explicit?: string): string[] {
  const join = joiner(host.platform);
  const win = host.platform === 'win32';
  const names = win ? ['hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes'] : ['hermes'];
  // Una ruta explícita es exclusiva: si no sirve, se dice, sin buscar otra a escondidas.
  if (explicit) {
    return [explicit];
  }
  const list: string[] = [];
  if (host.env.HERMES_BIN) {
    list.push(host.env.HERMES_BIN);
  }
  const pathVar = host.env.PATH ?? host.env.Path ?? '';
  for (const dir of pathVar.split(win ? ';' : ':').filter(Boolean)) {
    for (const name of names) {
      list.push(join(dir, name));
    }
  }
  if (win) {
    const local = host.env.LOCALAPPDATA ?? join(host.home, 'AppData', 'Local');
    const roaming = host.env.APPDATA ?? join(host.home, 'AppData', 'Roaming');
    const profile = host.env.USERPROFILE ?? host.home;
    list.push(
      join(local, 'hermes', 'bin', 'hermes.exe'), // instalador nativo (verificado en esta máquina)
      join(local, 'hermes', 'bin', 'hermes.cmd'),
      join(local, 'hermes', 'hermes-agent', '.hermes', 'bin', 'hermes.exe'), // instalador nativo, agente
      join(profile, '.local', 'bin', 'hermes.exe'), // pipx
      join(roaming, 'Python', 'Scripts', 'hermes.exe'), // pip --user
      join(roaming, 'npm', 'hermes.cmd'), // npm -g
    );
  } else {
    list.push(
      join(host.home, '.hermes', 'bin', 'hermes'), // instalador nativo
      join(host.home, '.local', 'bin', 'hermes'), // pipx y pip --user
      join(host.home, '.npm-global', 'bin', 'hermes'), // npm -g con prefijo de usuario
      '/usr/local/bin/hermes',
      '/usr/bin/hermes',
    );
  }
  return [...new Set(list)];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((pa[index] ?? 0) !== (pb[index] ?? 0)) {
      return (pa[index] ?? 0) - (pb[index] ?? 0);
    }
  }
  return 0;
}

function runner(host: ResolverHost, cliPath: string): (args: string[]) => Promise<RunResult> {
  const shim = host.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
  return (args) =>
    shim
      ? host.exec(host.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cliPath, ...args], { cwd: host.cwd })
      : host.exec(cliPath, args, { cwd: host.cwd });
}

/** Comprueba permiso de ejecución real; en Windows se delega en la ejecución del candidato. */
export async function canExecute(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'win32') {
    return true;
  }
  return fs.access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** Primer candidato que existe, puede ejecutarse y responde a `--version` con una versión ≥ la mínima. */
export async function resolveHermes(host: ResolverHost, explicit?: string, minimum: string = MIN_HERMES_VERSION): Promise<HermesCli> {
  const tried: string[] = [];
  const rejections: HermesRejection[] = [];
  for (const candidate of hermesCandidates(host, explicit)) {
    tried.push(candidate);
    if (!(await host.exists(candidate))) {
      rejections.push({ path: candidate, reason: 'no existe' });
      continue;
    }
    if (host.executable && !(await host.executable(candidate).catch(() => false))) {
      rejections.push({ path: candidate, reason: 'presente pero no ejecutable' });
      continue;
    }
    const run = runner(host, candidate);
    const result = await run(['--version']);
    const version = /v?(\d+\.\d+\.\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    if (result.status !== 0 || !version) {
      rejections.push({ path: candidate, reason: `--version falló (exit ${result.status ?? 'sin código'})` });
      continue;
    }
    if (compareVersions(version, minimum) < 0) {
      throw new HermesVersionError(version, minimum, candidate);
    }
    return { path: candidate, version, run };
  }
  throw new HermesNotFoundError(tried, rejections);
}

/** Hogar de Hermes (verificado en su fuente): Windows `%LOCALAPPDATA%\hermes`, resto `~/.hermes`. */
export function hermesHome(host: Pick<ResolverHost, 'platform' | 'env' | 'home'>): string {
  const join = joiner(host.platform);
  if (host.platform === 'win32') {
    return join(host.env.LOCALAPPDATA ?? join(host.home, 'AppData', 'Local'), 'hermes');
  }
  return join(host.home, '.hermes');
}
