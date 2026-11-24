import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createExclusive } from './proposals.js';

/**
 * Credenciales solo detrás de un ignorado verificado (R-117, R-123, D-65).
 *
 * `.ai-hub/.gitignore` es un archivo nuevo del motor, creado en exclusiva, con `.env` y `runs/`: git da
 * precedencia al `.gitignore` más profundo y sus patrones son relativos a su carpeta, así que protege
 * `.ai-hub/.env` sin tocar el `.gitignore` raíz del usuario. Antes de escribir una credencial o un
 * generado sensible, `git check-ignore -q` debe confirmarlo; si no, el paso no escribe nada.
 */

export const HARNESS_GITIGNORE = '.ai-hub/.gitignore';
export const HARNESS_GITIGNORE_RULES = ['.env', 'runs/'] as const;
export const HARNESS_GITIGNORE_CONTENT = [
  '# GENERADO por ai-hub: credenciales y telemetría nunca se versionan (D-65).',
  ...HARNESS_GITIGNORE_RULES,
  '',
].join('\n');

export type IgnoreStatus = 'ignored' | 'not_ignored' | 'not_a_git_repository';

export type HarnessIgnoreState = 'created' | 'present' | 'foreign';

/** Crea `.ai-hub/.gitignore` si no existe; uno ajeno o incompleto no se toca (se informa). */
export async function ensureHarnessGitignore(root: string): Promise<HarnessIgnoreState> {
  const file = path.join(root, ...HARNESS_GITIGNORE.split('/'));
  if (await createExclusive(file, HARNESS_GITIGNORE_CONTENT)) {
    return 'created';
  }
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  return HARNESS_GITIGNORE_RULES.every((rule) => lines.has(rule)) ? 'present' : 'foreign';
}

function git(root: string, args: string[]): { status: number | null } {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

/** ¿Ignora git `relative`? Sale 0 si se ignora, 1 si no; fuera de un repositorio se dice. */
export function ignoreStatus(root: string, relative: string): IgnoreStatus {
  if (git(root, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
    return 'not_a_git_repository';
  }
  return git(root, ['check-ignore', '-q', '--', relative]).status === 0 ? 'ignored' : 'not_ignored';
}

export type CredentialGate =
  | { ok: true; status: 'ignored' | 'not_a_git_repository' }
  | { ok: false; reason: 'credential_ignore_unverified'; detail: string };

/** Puerta antes de escribir una credencial: sin ignorado verificado, no se escribe nada. */
export async function credentialGate(root: string, relative: string): Promise<CredentialGate> {
  const state = await ensureHarnessGitignore(root);
  const status = ignoreStatus(root, relative);
  if (status === 'ignored' || status === 'not_a_git_repository') {
    return { ok: true, status };
  }
  return {
    ok: false,
    reason: 'credential_ignore_unverified',
    detail:
      state === 'foreign'
        ? `${HARNESS_GITIGNORE} existe sin las reglas ${HARNESS_GITIGNORE_RULES.join(' y ')}; añádelas (git check-ignore ${relative} debe confirmarlo)`
        : `git check-ignore ${relative} no lo confirma como ignorado; revisa las reglas de .gitignore`,
  };
}
