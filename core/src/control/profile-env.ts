import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Escribe solo las claves indicadas en el `.env` del perfil, conservando las demás; atómico y 0600 donde se pueda.
 * Vive fuera de `onboard.ts` para que `enroll.ts` pueda usarlo sin crear un ciclo de importación.
 */
export async function writeProfileEnv(file: string, values: Record<string, string>): Promise<void> {
  const original = await fs.readFile(file, 'utf8').catch(() => '');
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.ai-hub-${process.pid}.tmp`;
  await fs.writeFile(temp, `${updated.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}
