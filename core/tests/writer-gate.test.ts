import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanWriters } from '../src/writes/writer-gate.js';

/**
 * Gate de escritores (3.10, R-042). Límites (también en `writer-gate.ts`): por línea; no sigue rutas
 * construidas lejos de la llamada ni escrituras de procesos hijos; cubre solo destinos declarados y telemetría.
 */
const SRC = path.join(__dirname, '..', 'src');

async function sources(): Promise<Array<{ module: string; text: string }>> {
  const out: Array<{ module: string; text: string }> = [];
  for (const entry of await fs.readdir(SRC, { recursive: true })) {
    const rel = String(entry).split(path.sep).join('/');
    if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) {
      out.push({ module: rel, text: await fs.readFile(path.join(SRC, rel), 'utf8') });
    }
  }
  return out;
}

describe('gate de escritores (3.10)', () => {
  it('el motor actual solo escribe destinos declarados desde su escritor declarado', async () => {
    expect(scanWriters(await sources())).toEqual([]);
  });

  it('una escritura directa nueva a sync.lock.json falla nombrando módulo y línea', () => {
    const violations = scanWriters([{ module: 'cli/nuevo.ts', text: "import fs from 'node:fs/promises';\n\nawait fs.writeFile(path.join(root, 'sync.lock.json'), '{}');\n" }]);
    expect(violations).toEqual([{ module: 'cli/nuevo.ts', line: 3, target: 'sync-lock' }]);
  });
});
