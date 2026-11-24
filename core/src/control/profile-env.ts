import fs from 'node:fs/promises';
import { externalTarget } from '../writes/targets.js';
import { transactWrite } from '../writes/transaction.js';
import path from 'node:path';

/**
 * Escribe solo las claves indicadas en el `.env` del perfil, conservando las demás; atómico y 0600 donde se pueda.
 * Vive fuera de `onboard.ts` para que `enroll.ts` pueda usarlo sin crear un ciclo de importación.
 */
export async function writeProfileEnv(file: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 3.11: transacción X2 (lock compartido de usuario, temporal 0600, última comprobación, rename) sin copia previa:
  // `.env` sensible del perfil propio. La mezcla se recalcula sobre el contenido vigente en cada intento.
  const result = await transactWrite({
    root: path.dirname(file),
    file,
    module: 'control/profile-env.ts',
    target: externalTarget('hermes-profile-env'),
    capture: false,
    retention: 0,
    transform: (current) => mergeEnv(current ?? '', values),
  });
  if (result.status === 'stopped') {
    throw new Error(`${file}: escritura detenida (${result.reason}): ${result.detail}`);
  }
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** Texto del `.env` con las claves indicadas actualizadas o añadidas; el resto queda igual. */
export function mergeEnv(original: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = original === '' ? [] : original.replace(/\r?\n$/, '').split(/\r?\n/);
  const updated = lines.map((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key !== undefined && pending.has(key)) {
      const value = pending.get(key) as string;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) {
    updated.push(`${key}=${value}`);
  }
  return `${updated.join('\n')}\n`;
}
