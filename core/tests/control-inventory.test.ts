import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTick } from '../src/control/tick.js';
import { fakeGitlab, writes } from './control-fake.js';
import { harness, issue, type Harness } from './control-harness.js';

/**
 * Inventario de escrituras de `ai-hub control` (4.18, R-003). La integración sintética de
 * `control-hardening.test.ts` ya fija que ingest, decide, apply, --preapproved y expire solo escriben
 * etiquetas de la issue existente y notas. Aquí: tick y decide no escriben nada en el tracker.
 */
let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.dispose();
});

describe('inventario de escrituras de control (4.18)', () => {
  it('tick --dry-run y decide solo leen: ni issues, ni ramas, ni CR, ni etiquetas, ni notas', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    await h.status('001-alpha', 'CONVERGED');
    const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev', { mergeRequests: [21] })]);
    h.use(gitlab);
    // `tick` recibe el doble por parámetro (la CLI de tick no usa las dependencias inyectadas de control).
    await runTick(h.root, { online: true, trackerFetch: gitlab.fetch });
    await h.cli(['control', 'decide', '--online']);
    expect(writes(gitlab.requests)).toEqual([]);
    expect(gitlab.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
