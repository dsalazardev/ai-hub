import fs from 'node:fs/promises';
import { DECLARE_TRACKER_ACTION } from '../cli/integrations.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProjectManifest } from '../manifest/manifest.js';
import { HARNESS_ENV_FILE, readHarnessEnv } from './dotenv.js';

export interface EnvCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** `fetch` inyectable: los tests espían las llamadas y nunca tocan la red. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface EnvDoctorOptions {
  online?: boolean;
  fetch?: FetchLike;
}

const ROTATION = 'rota el token: ya pudo salir en el historial';

function git(root: string, args: string[]): { status: number; text: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return { status: result.error ? -1 : result.status ?? 1, text: (result.stdout ?? '').trim() };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/**
 * `env:ignored`: el archivo de credenciales, si existe, debe estar ignorado y jamás versionado.
 * Fuera de un repositorio git no hay riesgo de versionado y el check no aplica.
 */
export async function checkEnvIgnored(root: string): Promise<EnvCheck> {
  if (!(await exists(path.join(root, HARNESS_ENV_FILE)))) {
    return { id: 'env:ignored', ok: true, detail: `${HARNESS_ENV_FILE} no existe (créalo desde .ai-hub/.env.example cuando lo necesites)` };
  }
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.text !== 'true') {
    return { id: 'env:ignored', ok: true, detail: 'no aplica (sin repositorio git)' };
  }
  const tracked = git(root, ['ls-files', '--', HARNESS_ENV_FILE]);
  if (tracked.status === 0 && tracked.text !== '') {
    return {
      id: 'env:ignored',
      ok: false,
      detail: `${HARNESS_ENV_FILE} está VERSIONADO: git rm --cached ${HARNESS_ENV_FILE} y añádelo a .gitignore; ${ROTATION}`,
    };
  }
  const ignored = git(root, ['check-ignore', '-q', '--', HARNESS_ENV_FILE]);
  return ignored.status === 0
    ? { id: 'env:ignored', ok: true, detail: `${HARNESS_ENV_FILE} ignorado` }
    : { id: 'env:ignored', ok: false, detail: `${HARNESS_ENV_FILE} no está ignorado: añade "${HARNESS_ENV_FILE}" a .gitignore` };
}

/** `env:keys`: presencia de las claves del tracker declarado; jamás imprime un valor. */
export async function checkEnvKeys(root: string, manifest: ProjectManifest | null): Promise<EnvCheck> {
  const tracker = manifest?.tracker;
  if (!tracker) {
    // fabrica-verificable §D6: las claves están y el bloque no (instalaciones de 0.16.0); se nombra el hueco sin degradar.
    const values = await readHarnessEnv(root);
    if (values !== null && ['GITLAB_URL', 'GITLAB_TOKEN'].every((key) => values[key] && values[key] !== 'CHANGEME')) {
      return {
        id: 'env:keys',
        ok: true,
        detail: `tracker no declarado: ${HARNESS_ENV_FILE} ya tiene GITLAB_URL y GITLAB_TOKEN y falta manifest.tracker · ${DECLARE_TRACKER_ACTION}`,
      };
    }
    return { id: 'env:keys', ok: true, detail: 'tracker no configurado (manifest.tracker opcional)' };
  }
  const values = (await readHarnessEnv(root)) ?? {};
  const keys = [tracker.urlEnv, tracker.tokenEnv];
  const missing = keys.filter((key) => !values[key] || values[key] === 'CHANGEME');
  return missing.length === 0
    ? { id: 'env:keys', ok: true, detail: `claves presentes: ${keys.join(', ')}` }
    : { id: 'env:keys', ok: false, detail: `faltan en ${HARNESS_ENV_FILE}: ${missing.join(', ')}` };
}

function redactIdentity(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    return '***';
  }
  return `${value[0]}***`;
}

/** `tracker:token`: solo con `--online`; una lectura de identidad, salida redactada. */
export async function checkTrackerToken(
  root: string,
  manifest: ProjectManifest | null,
  options: EnvDoctorOptions,
): Promise<EnvCheck> {
  const tracker = manifest?.tracker;
  if (!options.online) {
    return { id: 'tracker:token', ok: true, detail: 'omitido (sin --online, doctor no usa la red)' };
  }
  if (!tracker) {
    return { id: 'tracker:token', ok: true, detail: 'tracker no configurado' };
  }
  const values = (await readHarnessEnv(root)) ?? {};
  const url = values[tracker.urlEnv];
  const token = values[tracker.tokenEnv];
  if (!url || !token) {
    return { id: 'tracker:token', ok: false, detail: `faltan ${tracker.urlEnv} o ${tracker.tokenEnv} en ${HARNESS_ENV_FILE}` };
  }
  const doFetch: FetchLike = options.fetch ?? ((target, init) => fetch(target, init));
  try {
    const response = await doFetch(`${url.replace(/\/+$/, '')}/api/v4/user`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      return { id: 'tracker:token', ok: false, detail: `el tracker respondió HTTP ${response.status}` };
    }
    const body = (await response.json().catch(() => null)) as { username?: unknown } | null;
    return { id: 'tracker:token', ok: true, detail: `autenticado como ${redactIdentity(body?.username)}` };
  } catch (error) {
    const code = (error as { name?: string }).name ?? 'error';
    return { id: 'tracker:token', ok: false, detail: `sin respuesta del tracker (${code})` };
  }
}

/** Roles de GitLab por `access_level` (permisos de proyecto). */
const ACCESS_LEVELS: Record<number, string> = { 10: 'Guest', 15: 'Planner', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' };
const EXPIRY_WARNING_DAYS = 14;

export interface TrackerScopeOptions extends EnvDoctorOptions {
  now?: Date;
}

/**
 * `tracker:scope` (hermes-control 5.3): solo con `--online`. Introspecciona el token (solo GET) y avisa si puede
 * hacer push (`write_repository` o rol Developer o superior) o si caduca en menos de 14 días. Sin endpoint de
 * introspección, lo dice y no inventa nada. Nunca imprime el token.
 */
export async function checkTrackerScope(root: string, manifest: ProjectManifest | null, options: TrackerScopeOptions): Promise<EnvCheck> {
  const id = 'tracker:scope';
  if (!options.online) {
    return { id, ok: true, detail: 'omitido (sin --online, doctor no usa la red)' };
  }
  const tracker = manifest?.tracker;
  if (!tracker) {
    return { id, ok: true, detail: 'tracker no configurado' };
  }
  const values = (await readHarnessEnv(root)) ?? {};
  const url = values[tracker.urlEnv];
  const token = values[tracker.tokenEnv];
  if (!url || !token) {
    return { id, ok: false, detail: `faltan ${tracker.urlEnv} o ${tracker.tokenEnv} en ${HARNESS_ENV_FILE}` };
  }
  const doFetch: FetchLike = options.fetch ?? ((target, init) => fetch(target, init));
  const base = `${url.replace(/\/+$/, '')}/api/v4`;
  const get = (pathname: string) => doFetch(`${base}${pathname}`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(10_000) });
  try {
    const self = await get('/personal_access_tokens/self');
    if (self.status !== 200) {
      return { id, ok: true, detail: `introspección no disponible (HTTP ${self.status}): solo se comprueba la identidad (tracker:token)` };
    }
    const body = ((await self.json().catch(() => null)) ?? {}) as { scopes?: unknown; expires_at?: unknown; user_id?: unknown };
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
    const expires = typeof body.expires_at === 'string' ? body.expires_at : null;
    const warnings: string[] = [];
    if (scopes.includes('write_repository')) {
      warnings.push('el scope write_repository permite hacer push');
    }
    let role: string | null = null;
    const project = values.GITLAB_PROJECT_PATH;
    if (project && typeof body.user_id === 'number') {
      const segment = project.includes('/') ? encodeURIComponent(project) : project;
      const member = await get(`/projects/${segment}/members/all/${body.user_id}`);
      if (member.status === 200) {
        const level = Number(((await member.json().catch(() => null)) as { access_level?: unknown } | null)?.access_level);
        role = ACCESS_LEVELS[level] ?? `nivel ${level}`;
        if (level >= 30) {
          warnings.push(`rol ${role}: puede hacer push (el plano de control solo necesita Reporter)`);
        }
      }
    }
    const now = options.now ?? new Date();
    if (expires !== null && Date.parse(`${expires}T00:00:00Z`) - now.getTime() < EXPIRY_WARNING_DAYS * 86_400_000) {
      warnings.push(`caduca el ${expires} (menos de ${EXPIRY_WARNING_DAYS} días): rótalo`);
    }
    const summary = `scopes ${scopes.join(',') || '-'}${role ? ` · rol ${role}` : ''} · caduca ${expires ?? 'sin fecha declarada'}`;
    return { id, ok: true, detail: warnings.length > 0 ? `aviso: ${warnings.join('; ')} · ${summary}` : summary };
  } catch (error) {
    const code = (error as { name?: string }).name ?? 'error';
    return { id, ok: false, detail: `sin respuesta del tracker (${code})` };
  }
}
