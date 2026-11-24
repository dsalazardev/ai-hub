import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRunEvents, runVersion, validateRunEvent } from '../src/harness/runs.js';
import { LockHeldError } from '../src/harness/lock.js';
import { assignRun, bindClosing, harnessEnvironment, recordContext, RUN_ID_ENV, verifyCanonicalContext } from '../src/runner/execution.js';
import { classifyFailure, ensureRunIssue, lockWorktree, postNoteOnce, runHarnessProcess, runWithFallback, runMarker } from '../src/runner/process.js';
import { loadManifest } from '../src/manifest/manifest.js';
import { harness, type Harness } from './control-harness.js';

/**
 * Runner con dobles locales (5.10–5.12, 5.14–5.17). Los procesos son `node` del propio entorno; ningún harness real,
 * ninguna sesión ni cuota. La cancelación del árbol se verifica aquí solo en la plataforma que ejecuta la suite.
 */

const NOW = new Date('2026-11-23T10:00:00.000Z');
const RUN_PATTERN = /^\d{8}-\d{6}Z-[0-9a-f]{6}$/;
let h: Harness;
let scratch: string;

beforeEach(async () => {
  h = await harness();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-runner-'));
});

afterEach(async () => {
  await h.dispose();
  await fs.rm(scratch, { recursive: true, force: true });
});

function status(run: string | null, state = 'CONVERGED'): string {
  return `AI-HUB-STATUS: ${state} | artifact=-${run === null ? '' : ` | run=${run}`} | reason=done`;
}

describe('run id compartido (5.15, R-101)', () => {
  it('el id asignado, el del cierre y el de la telemetría son el mismo; esquema v2 sin salida capturada', async () => {
    await h.consumer();
    const run = await assignRun(h.root, { harness: 'doble', harnessVersion: '1.0.0', now: NOW, links: { issue: 7 } });
    expect(run).toMatch(RUN_PATTERN);
    expect(harnessEnvironment(run)).toEqual({ [RUN_ID_ENV]: run });
    const output = `salida privada del harness SECRETO_DE_SALIDA\n${status(run)}\n`;
    expect((await bindClosing(h.root, run, output, NOW)).accepted).toBe(true);
    const events = await readRunEvents(h.root, run);
    expect(events[0]).toMatchObject({ v: 2, run, kind: 'start', harness: 'doble', harness_version: '1.0.0', origin: 'runner', links: { issue: 7 } });
    expect(events.every((event) => event.run === run)).toBe(true);
    expect(events.find((event) => event.kind === 'status')).toMatchObject({ state: 'CONVERGED', reason_code: 'done' });
    for (const event of events) {
      await expect(validateRunEvent(h.root, event)).resolves.toBeTruthy();
    }
    const raw = await fs.readFile(path.join(h.root, '.ai-hub', 'runs', run, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('SECRETO_DE_SALIDA');
    expect(await runVersion(h.root, run)).toBe(2);
  });

  it('lee un run v1 sin reescribirlo', async () => {
    await h.consumer();
    const dir = path.join(h.root, '.ai-hub', 'runs', '20260101-000000Z-abcdef');
    await fs.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify({ v: 1, ts: NOW.toISOString(), run: '20260101-000000Z-abcdef', kind: 'start' })}\n`;
    await fs.writeFile(path.join(dir, 'events.jsonl'), line, 'utf8');
    expect(await readRunEvents(h.root, '20260101-000000Z-abcdef')).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe(line);
  });
});

describe('contexto canónico y vinculación del cierre (5.14, R-100, R-107)', () => {
  const fresh = { lockFresh: async () => true };

  it('contexto correcto: identidad registrada sin rutas; proyección ausente y otro proyecto se rechazan antes de arrancar', async () => {
    await h.consumer();
    const project = (await loadManifest(h.root)).project.id;
    const ok = await verifyCanonicalContext({ worktree: h.root, project, target: 'claude' }, fresh);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    if (ok.ok) {
      expect(ok.identity).toMatchObject({ project, target: 'claude' });
      expect(ok.identity.lockHash).toMatch(/^[0-9a-f]{64}$/);
      const run = await assignRun(h.root, { harness: 'doble', harnessVersion: '1', now: NOW });
      await recordContext(h.root, run, ok.identity, NOW);
      const note = (await readRunEvents(h.root, run)).find((event) => event.kind === 'note');
      expect(note?.note).toContain('contexto verificado');
      expect(note?.note).not.toContain(h.root);
    }
    expect(await verifyCanonicalContext({ worktree: h.root, project: 'otro-proyecto', target: 'claude' }, fresh)).toMatchObject({ ok: false, reason: 'project_mismatch' });
    await fs.rm(path.join(h.root, '.claude'), { recursive: true, force: true });
    const missing = await verifyCanonicalContext({ worktree: h.root, project, target: 'claude' }, fresh);
    expect(missing).toMatchObject({ ok: false, reason: 'projection_missing' });
    expect(missing.ok === false && missing.detail).toContain('claude');
    expect(await verifyCanonicalContext({ worktree: h.root, project, target: 'opencode' }, { lockFresh: async () => false })).toMatchObject({ ok: false, reason: 'lock_stale' });
  });

  it('cierre sin run, de otro run e inválido: no se acepta ni se aplica ningún efecto de la línea', async () => {
    await h.consumer();
    const run = await assignRun(h.root, { harness: 'doble', harnessVersion: '1', now: NOW });
    const other = await assignRun(h.root, { harness: 'doble', harnessVersion: '1', now: new Date(NOW.getTime() + 1000) });
    expect(await bindClosing(h.root, run, 'terminé sin línea de estado', NOW)).toEqual({ accepted: false, reason: 'context_unverified' });
    expect(await bindClosing(h.root, run, status(null), NOW)).toEqual({ accepted: false, reason: 'context_unverified' });
    expect(await bindClosing(h.root, run, status(other, 'VERIFIED'), NOW)).toEqual({ accepted: false, reason: 'run_mismatch' });
    expect(await bindClosing(h.root, run, 'AI-HUB-STATUS: ESTO NO PARSEA', NOW)).toEqual({ accepted: false, reason: 'invalid_status' });
    const events = await readRunEvents(h.root, run);
    const statuses = events.filter((event) => event.kind === 'status');
    expect(statuses.map((event) => event.reason_code)).toEqual(['context_unverified', 'context_unverified', 'run_mismatch', 'invalid_status']);
    expect(statuses.every((event) => event.state === undefined && event.artifact === undefined)).toBe(true);
  });

  it('cierre correcto: vinculado al run y uso del contexto «no observado», aparte de la verificación previa', async () => {
    await h.consumer();
    const run = await assignRun(h.root, { harness: 'doble', harnessVersion: '1', now: NOW });
    expect(await bindClosing(h.root, run, status(run), NOW)).toMatchObject({ accepted: true, status: { state: 'CONVERGED', runId: run } });
    const notes = (await readRunEvents(h.root, run)).filter((event) => event.kind === 'note').map((event) => event.note);
    expect(notes.join(' ')).toContain('no observado');
  });
});

describe('el runner no escribe rutas de Spec Kit (5.17, R-103)', () => {
  async function snapshot(dir: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    async function walk(current: string): Promise<void> {
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const stat = await fs.stat(full);
          files.set(path.relative(dir, full), `${stat.size}:${stat.mtimeMs}`);
        }
      }
    }
    await walk(dir);
    return files;
  }

  it('preparar y cerrar una ejecución solo escribe telemetría bajo .ai-hub/runs/', async () => {
    await h.consumer();
    await h.feature('001-alpha');
    await fs.mkdir(path.join(h.root, '.specify', 'memory'), { recursive: true });
    await fs.writeFile(path.join(h.root, '.specify', 'memory', 'constitution.md'), '# c\n', 'utf8');
    const before = await snapshot(h.root);
    const project = (await loadManifest(h.root)).project.id;
    const context = await verifyCanonicalContext({ worktree: h.root, project, target: 'claude' }, { lockFresh: async () => true });
    const run = await assignRun(h.root, { harness: 'doble', harnessVersion: '1', now: NOW });
    if (context.ok) {
      await recordContext(h.root, run, context.identity, NOW);
    }
    await bindClosing(h.root, run, status(run), NOW);
    const lock = await lockWorktree(h.root, h.root, run);
    await lock.release();
    const after = await snapshot(h.root);
    const changed = [...after.keys()].filter((file) => before.get(file) !== after.get(file));
    expect(changed.length).toBeGreaterThan(0);
    for (const file of changed) {
      expect(file.split(path.sep).join('/')).toMatch(/^\.ai-hub\/runs\//);
    }
  });

  it('inventario de escrituras del código del runner: ninguna ruta de Spec Kit', async () => {
    const dir = path.resolve(__dirname, '..', 'src', 'runner');
    for (const name of await fs.readdir(dir)) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/writeFile|appendFile|rename|\brm\(|unlink|mkdir/);
      expect(text, name).not.toMatch(/['"`]\.specify|['"`]specs\//);
    }
  });
});

describe('lock del worktree y cancelación del árbol (5.10, R-095, R-096)', () => {
  it('una segunda ejecución sobre el mismo worktree se rechaza nombrando al dueño', async () => {
    await h.consumer();
    const first = await lockWorktree(h.root, h.root, 'run-a');
    const error = await lockWorktree(h.root, h.root, 'run-b').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockHeldError);
    expect((error as Error).message).toContain('run-a');
    await first.release();
    const again = await lockWorktree(h.root, h.root, 'run-b');
    await again.release();
  });

  it('al vencer el timeout no queda ningún proceso del árbol (plataforma de la suite)', async () => {
    const pidFile = path.join(scratch, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "console.log('arrancado');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const result = await runHarnessProcess({ command: process.execPath, args: ['-e', script], cwd: scratch, timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(result.started).toBe(true);
    expect(result.tail).toContain('arrancado');
    const childPid = Number(await fs.readFile(pidFile, 'utf8'));
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while ((alive(childPid) || (result.pid !== null && alive(result.pid))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(alive(childPid)).toBe(false);
    expect(result.pid !== null && alive(result.pid)).toBe(false);
  }, 20_000);

  it('un binario inexistente no arranca: fallo anterior al arranque', async () => {
    const result = await runHarnessProcess({ command: path.join(scratch, 'no-existe-ai-hub'), args: [], cwd: scratch, timeoutMs: 2000 });
    expect(result.started).toBe(false);
  });
});

describe('fallback solo antes del arranque (5.11, R-097)', () => {
  it('binario que no arranca: se prueba el siguiente', async () => {
    const outcome = await runWithFallback(['a', 'b'], async (harness) => (harness === 'a' ? { harness, phase: 'resolve', ok: false, reason: 'ENOENT' } : { harness, phase: 'completed', ok: true }));
    expect(outcome).toMatchObject({ kind: 'completed', harness: 'b' });
  });

  it('hook de arranque que escribe antes de la tarea y fallo tras recibirla: se retiene para reconciliar', async () => {
    for (const phase of ['started', 'task_delivered'] as const) {
      const outcome = await runWithFallback(['a', 'b'], async (harness) => ({ harness, phase, ok: false }));
      expect(outcome).toMatchObject({ kind: 'held', harness: 'a' });
      expect(outcome.tried).toHaveLength(1);
    }
    expect(classifyFailure('version')).toBe('fallback');
    expect(classifyFailure('refused')).toBe('fallback');
  });
});

describe('reconciliación con marcadores e issue por ejecución (5.12, 5.16)', () => {
  function sink() {
    const notes: string[] = [];
    const issues = new Map<number, string>();
    return {
      notes,
      issues,
      issueNotes: async () => notes.map((body) => ({ body })),
      postIssueNote: async (_iid: number, body: string) => {
        notes.push(body);
      },
      findIssuesWithMarker: async (marker: string) => [...issues.entries()].filter(([, body]) => body.includes(marker)).map(([iid]) => iid),
      createIssue: async (_title: string, description: string) => {
        const iid = issues.size + 1;
        issues.set(iid, description);
        return iid;
      },
    };
  }

  it('una nota publicada antes de una caída no se duplica al reintentar', async () => {
    const tracker = sink();
    expect(await postNoteOnce(tracker, 7, 'run-1', 'avance')).toBe('posted');
    expect(await postNoteOnce(tracker, 7, 'run-1', 'avance')).toBe('already_present');
    expect(tracker.notes).toHaveLength(1);
    expect(tracker.notes[0]).toContain(runMarker('run-1'));
  });

  it('issue por ejecución: apagada por defecto; activa, una sola issue tras reintentar', async () => {
    const tracker = sink();
    expect(await ensureRunIssue(tracker, 'run-1', { title: 't', description: 'd' })).toEqual({ state: 'disabled' });
    expect(tracker.issues.size).toBe(0);
    const first = await ensureRunIssue(tracker, 'run-1', { enabled: true, title: 't', description: 'd' });
    const retry = await ensureRunIssue(tracker, 'run-1', { enabled: true, title: 't', description: 'd' });
    expect(first).toEqual({ state: 'created', iid: 1 });
    expect(retry).toEqual({ state: 'existing', iid: 1 });
    expect(tracker.issues.size).toBe(1);
  });
});
