import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 3.21 (R-031, R-032, R-039, R-045, R-105, R-106, R-113, R-114, R-117, R-118): la documentación fija propiedad,
 * sensibilidad, custodia, transacción, límites frente a escritores externos, la matriz de versiones con la reversión no
 * soportada, la recuperación (purge borra el estado duradero) y las verificaciones que siguen pendientes.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFile(path.join(ROOT, relative), 'utf8');

describe('documentación de escrituras, custodia y recuperación (3.21)', () => {
  it('SECURITY.md tiene la sección con sus subsecciones y hechos', async () => {
    const text = await read('core/SECURITY.md');
    const start = text.indexOf('## Writes, custody and recovery');
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));
    for (const heading of ['### Limits against external writers', '### Versions and recovery', '### Pending verification']) {
      expect(section).toContain(heading);
    }
    for (const fact of [
      'core/src/writes/targets.ts',
      'external_write_detected',
      'external_guard_reduced',
      'capture_quota_full',
      'ai-hub captures release',
      'never reported as protected',
      '0.18.0',
      'is not supported',
      '`ai-hub purge` deletes the whole `.ai-hub/`',
      'durable control state',
      'ai-hub locks release',
      'does not demonstrate POSIX permissions',
    ]) {
      expect(section, fact).toContain(fact);
    }
  });

  it('AGENTS.md §9 resume la política y remite a SECURITY.md; el CHANGELOG lleva la matriz de versiones', async () => {
    const agents = await read('AGENTS.md');
    const nine = agents.slice(agents.indexOf('## 9.'), agents.indexOf('## 10.'));
    for (const fact of ['core/src/writes/targets.ts', 'D-65', 'external_write_detected', '0.18.0', '`ai-hub purge`', 'Writes, custody and recovery']) {
      expect(nine, fact).toContain(fact);
    }
    const changelog = await read('CHANGELOG.md');
    const unreleased = changelog.slice(0, changelog.indexOf('\n## 0.17.0'));
    expect(unreleased).toContain('Versión mínima compatible (VMC): 0.18.0');
    expect(unreleased).toContain('no está soportado');
  });
});
