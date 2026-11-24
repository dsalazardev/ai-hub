import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transactWrite } from '../writes/transaction.js';
import { externalTarget } from '../writes/targets.js';

/**
 * Scripts gestionados del perfil de Hermes (R-013, tarea 4.26). Cada plantilla lleva `# ai-hub-managed: <nombre> v=<n>`.
 * Un script con la marca (o idéntico a una plantilla publicada antes de la marca) que difiere de la versión actual
 * está desactualizado y `enroll --yes` lo sustituye con copia previa; uno sin la marca es de la persona y no se toca.
 */

export const MANAGED_MARK = /^(?:# ai-hub-managed: ([A-Za-z0-9._-]+) v=(\d+)|<!-- ai-hub-managed: ([A-Za-z0-9._-]+) v=(\d+) -->)$/m;
export const REPO_PLACEHOLDER = '__AI_HUB_REPO__';

/** sha256 de las plantillas publicadas antes de la marca (sin sustituir el repositorio), por nombre de script. */
const LEGACY_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  'control-poll.sh': ['2861dc4767f2116bf64ee1bca289642095640754e67076b4d0b085ce035836c2'],
  'gitlab-route.sh': ['a6a3903a5e4534c6eebbf9b1917dedd162b3b872cc7c863685b59cf3d7308d75'],
  'SKILL.md': ['dcee732fdb6578aa2f54fb36d98161ef344adf113f5d0891d1cea94c54644642'],
};

export type ScriptState = 'absent' | 'current' | 'outdated' | 'unmanaged';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function scriptState(file: string, rendered: string, repo: string): Promise<{ state: ScriptState; text: string | null }> {
  const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (text === null) {
    return { state: 'absent', text };
  }
  if (text === rendered) {
    return { state: 'current', text };
  }
  if (MANAGED_MARK.test(text)) {
    return { state: 'outdated', text };
  }
  const unrendered = text.split(repo.replace(/\\/g, '/')).join(REPO_PLACEHOLDER);
  const legacy = LEGACY_TEMPLATES[path.basename(file)] ?? [];
  return { state: legacy.includes(sha256(unrendered)) ? 'outdated' : 'unmanaged', text };
}

/** Sustituye un script desactualizado por la transacción X2 con una copia previa; si cambió desde la lectura, no. */
export async function replaceManagedScript(file: string, rendered: string, expected: string, targetId = 'hermes-profile-scripts'): Promise<void> {
  const result = await transactWrite({
    root: path.dirname(file),
    file,
    module: 'control/scripts.ts',
    target: externalTarget(targetId),
    capture: false,
    transform: (current) => {
      if (current !== expected) {
        throw new Error(`${file} cambió mientras se preparaba la actualización; no se sustituye`);
      }
      return rendered;
    },
  });
  if (result.status === 'stopped') {
    throw new Error(`${file}: actualización detenida (${result.reason}): ${result.detail}`);
  }
}
