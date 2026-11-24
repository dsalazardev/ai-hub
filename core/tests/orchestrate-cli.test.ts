import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setOrchestrateDeps } from '../src/cli/orchestrate.js';
import { setRequestStatus, submitRequest } from '../src/control/requests.js';
import type { DiscoveryDeps } from '../src/runner/discovery.js';
import type { Launcher } from '../src/runner/orchestrate.js';
import { APPROVER, harness, type Harness } from './control-harness.js';

/** `ai-hub orchestrate` (#11-C1, 5.7) con descubrimiento y lanzador dobles: ningún harness real. */

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  setOrchestrateDeps({});
  await h.dispose();
});

/** Salidas como las medidas en 2.6. */
function measured(state: Partial<Record<'claude' | 'codex', boolean>>): DiscoveryDeps {
  return {
    resolveBinary: async (binary) => `/fake/${binary}`,
    emptyDir: async () => path.join(os.tmpdir(), 'ai-hub-probe-vacio'),
    run: async (command, args) => {
      const id = path.basename(command);
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: id === 'claude' ? '2.1.330 (Claude Code)' : id === 'codex' ? 'codex-cli 0.172.0' : 'opencode v2.3.2', started: true };
      }
      const ok = state[id as 'claude' | 'codex'] === true;
      return id === 'claude' ? { exitCode: ok ? 0 : 1, stdout: `{"loggedIn": ${ok}}`, started: true } : { exitCode: ok ? 0 : 1, stdout: '', started: true };
    },
  };
}

async function grant(seal: string | null = null): Promise<string> {
  const now = new Date();
  const request = await submitRequest(
    h.root,
    { project: 'grp/demo', iid: 9, summary: `cli ${Math.random()}`, worktree: '.', effects: ['edit:src/**'], base: 'a'.repeat(40), seal, limits: { maxMinutes: 5 }, expiresAt: new Date(now.getTime() + 600_000).toISOString() },
    now,
  );
  await setRequestStatus(h.root, request.id, 'approved', APPROVER, now);
  return request.id;
}

describe('ai-hub orchestrate (#11-C1, 5.7)', () => {
  it('discover informa por harness sin credenciales y sale 1 sin elegibles', async () => {
    await h.consumer();
    setOrchestrateDeps({ discovery: measured({ claude: false, codex: true }) });
    const found = await h.cli(['orchestrate', 'discover']);
    expect(found.code).toBe(0);
    expect(found.out).toContain('[OK]   codex 0.172.0');
    expect(found.out).toMatch(/claude: no operativo/);
    expect(found.out).toMatch(/opencode: no verificable/);
    expect(found.out).toContain('seleccionado: codex');
    setOrchestrateDeps({ discovery: measured({}) });
    expect((await h.cli(['orchestrate', 'discover'])).code).toBe(1);
  });

  it('el orden se configura en manifest.runner.order; un valor fuera del catálogo lo rechaza el esquema', async () => {
    await h.consumer();
    const manifest = path.join(h.root, 'manifest.yaml');
    await fs.appendFile(manifest, 'runner:\n  order: [codex, claude]\n');
    setOrchestrateDeps({ discovery: measured({ claude: true, codex: true }) });
    const json = JSON.parse((await h.cli(['orchestrate', 'discover', '--json'])).out) as { order: string[]; eligible: Array<{ id: string }> };
    expect(json.order).toEqual(['codex', 'claude']);
    expect(json.eligible[0].id).toBe('codex');
    await fs.writeFile(manifest, (await fs.readFile(manifest, 'utf8')).replace('order: [codex, claude]', 'order: [aider]'));
    const bad = await h.cli(['orchestrate', 'discover']);
    expect(bad.code).not.toBe(0);
    expect(`${bad.out}${bad.err}`).toContain('runner');
  });

  it('run ejecuta una concesión aprobada con el harness seleccionado y vincula el cierre', async () => {
    await h.consumer();
    const calls: string[] = [];
    const launch: Launcher = async ({ harness: id, run, task }) => {
      calls.push(id);
      expect(task).toContain(`run=${run}`);
      return { phase: 'completed', ok: true, output: `hecho\nAI-HUB-STATUS: DONE | artifact=- | run=${run} | reason=cli` };
    };
    setOrchestrateDeps({ discovery: measured({ claude: true, codex: true }), launch, lockFresh: async () => true });
    const taskFile = path.join(h.root, 'tarea.md');
    await fs.writeFile(taskFile, 'Implementa la tarea.\n');
    const id = await grant();
    const result = await h.cli(['orchestrate', 'run', '--grant', id, '--task-file', taskFile]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/^run \d{8}-\d{6}Z-[0-9a-f]{6}: claude terminó; cierre aceptado \(DONE\)/);
    expect(calls).toEqual(['claude']);
    // La misma concesión no se reproduce.
    const again = await h.cli(['orchestrate', 'run', '--grant', id, '--task-file', taskFile]);
    expect(again.code).toBe(1);
    expect(calls).toEqual(['claude']);
  });

  it('sin concesión conocida o sin argumentos no se ejecuta nada; una ligada a sello exige --feature', async () => {
    await h.consumer();
    const launch: Launcher = async () => {
      throw new Error('no debe lanzarse');
    };
    setOrchestrateDeps({ discovery: measured({ claude: true }), launch, lockFresh: async () => true });
    expect((await h.cli(['orchestrate', 'run'])).code).toBe(2);
    const taskFile = path.join(h.root, 'tarea.md');
    await fs.writeFile(taskFile, 'x\n');
    const unknown = await h.cli(['orchestrate', 'run', '--grant', 'f'.repeat(64), '--task-file', taskFile]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('no está en el registro');
    const sealed = await grant('e'.repeat(64));
    expect((await h.cli(['orchestrate', 'run', '--grant', sealed, '--task-file', taskFile])).code).toBe(2);
  });
});
