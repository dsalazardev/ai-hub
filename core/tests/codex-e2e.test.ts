import { describe, expect, it } from 'vitest';
import { HARNESS_DECLARATIONS, selectHarness } from '../src/runner/discovery.js';
import { hostDiscoveryDeps } from '../src/runner/host.js';

/**
 * 5.18 (R-089, R-091): E2E opt-in con Codex real. Solo corre con `AI_HUB_CODEX_E2E=1` y Codex instalado; por defecto
 * la suite lo omite y la omisión se cuenta como omisión, nunca como aprobación. Con la variable, el descubrimiento real
 * debe encontrar Codex presente, compatible y operativo con su comando de estado declarado y verificado: hasta que el
 * experimento 2.6 declare ese comando, la prueba falla con el motivo, que es el resultado correcto.
 */

const enabled = process.env.AI_HUB_CODEX_E2E === '1';

describe.skipIf(!enabled)('E2E con Codex real (AI_HUB_CODEX_E2E=1)', () => {
  it('Codex se descubre operable y es elegible con su evidencia declarada', async () => {
    const selection = await selectHarness(HARNESS_DECLARATIONS, hostDiscoveryDeps(), ['codex']);
    expect(selection.skipped, JSON.stringify(selection.skipped)).toEqual([]);
    expect(selection.selected?.id).toBe('codex');
  }, 60_000);
});
