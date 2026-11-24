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

describe.skipIf(!enabled)('E2E: ejecución concedida con Codex real (AI_HUB_CODEX_E2E=1)', () => {
  it('concesión → Codex por el lanzador real → cierre vinculado al run id asignado', async () => {
    const { harness } = await import('./control-harness.js');
    const { setRequestStatus, submitRequest } = await import('../src/control/requests.js');
    const { loadManifest } = await import('../src/manifest/manifest.js');
    const { executeGrantedRun, processLauncher } = await import('../src/runner/orchestrate.js');
    const { readRunEvents } = await import('../src/harness/runs.js');
    const h = await harness();
    try {
      await h.consumer();
      const now = new Date();
      const approver = '123456789012345678';
      const request = await submitRequest(h.root, { project: 'grp/demo', iid: 1, summary: 'e2e codex', worktree: '.', effects: ['read:**'], base: 'a'.repeat(40), seal: null, limits: { maxMinutes: 5 }, expiresAt: new Date(now.getTime() + 600_000).toISOString() }, now);
      await setRequestStatus(h.root, request.id, 'approved', approver, now);
      const deps = hostDiscoveryDeps();
      const task = 'No ejecutes comandos ni edites archivos. Responde en una frase y termina tu respuesta con una última línea exactamente así, sustituyendo <valor> por el run id asignado que se indica al final: AI-HUB-STATUS: DONE | artifact=- | run=<valor> | reason=e2e';
      const outcome = await executeGrantedRun(
        { root: h.root, claim: { iid: 1, grantId: request.id, project: 'grp/demo', worktree: '.', effects: ['read:**'], seal: null, approvers: [approver], now }, contextProject: (await loadManifest(h.root)).project.id, worktreePath: h.root, target: 'claude', task, order: ['codex'], now },
        { declarations: HARNESS_DECLARATIONS, discovery: deps, launch: processLauncher(HARNESS_DECLARATIONS, deps.resolveBinary, 240_000), context: { lockFresh: async () => true } },
      );
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'completed', harness: 'codex', accepted: true, closing: 'DONE' });
      const events = await readRunEvents(h.root, (outcome as { run: string }).run);
      expect(events[0]).toMatchObject({ harness: 'codex', harness_version: '0.172.0', origin: 'runner' });
    } finally {
      await h.dispose();
    }
  }, 300_000);
});
