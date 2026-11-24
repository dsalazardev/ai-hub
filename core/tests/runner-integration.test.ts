import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setRequestStatus, submitRequest } from '../src/control/requests.js';
import type { RunClaim } from '../src/control/grants.js';
import { readRunEvents } from '../src/harness/runs.js';
import { loadManifest } from '../src/manifest/manifest.js';
import { DEFAULT_HARNESS_ORDER, HARNESS_DECLARATIONS, runProbe, selectHarness, type DiscoveryDeps, type HarnessDeclaration } from '../src/runner/discovery.js';
import { executeGrantedRun, markReconciled, processLauncher, resumeOffer, type Launcher } from '../src/runner/orchestrate.js';
import { lockWorktree } from '../src/runner/process.js';
import { harness, type Harness } from './control-harness.js';

/**
 * Integración local del runner (5.6, 5.7, 5.10–5.13, 5.16, 5.21 con dobles): concesión, descubrimiento, contexto,
 * run id, lock, consumo, arranque con fallback, cierre, reconciliación y reanudación encadenados. Los harnesses son
 * declaraciones de prueba y procesos `node`; ningún harness real, sesión ni cuota.
 */

const NOW = new Date('2026-11-24T12:00:00.000Z');
const APPROVER = '123456789012345678';
let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.dispose();
});

function declaration(id: string, overrides: Partial<HarnessDeclaration> = {}): HarnessDeclaration {
  return {
    id,
    binary: id,
    version: { args: ['--version'], evidence: 'doble', parse: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null, range: { min: '1.0.0', max: '9.9.9' } },
    status: { args: ['status'], evidence: 'doble', operable: ({ exitCode, stdout }) => exitCode === 0 && stdout.includes('logged-in') },
    probe: null,
    headless: null,
    session: { sessionId: (out) => /session=(\S+)/.exec(out)?.[1] ?? null, resumeArgs: (id) => ['--resume', id], evidence: 'doble' },
    ...overrides,
  };
}

/** Doble de descubrimiento: binarios presentes y estado por harness; registra cada comando y su directorio. */
function discovery(state: Record<string, 'operable' | 'not_operable' | 'absent'>): DiscoveryDeps & { calls: Array<{ command: string; args: string[]; cwd: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  return {
    calls,
    resolveBinary: async (binary) => (state[binary] === undefined || state[binary] === 'absent' ? null : `/fake/${binary}`),
    emptyDir: async () => path.join(os.tmpdir(), 'ai-hub-probe-vacio'),
    run: async (command, args, { cwd }) => {
      calls.push({ command, args, cwd });
      const id = path.basename(command);
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: `${id} 2.1.0`, started: true };
      }
      return { exitCode: 0, stdout: state[id] === 'operable' ? 'logged-in' : 'no session', started: true };
    },
  };
}

describe('descubrimiento y prioridad (5.6, 5.7, 5.21 con dobles)', () => {
  it('instalado no operativo y sin comando de estado se excluyen; Claude no operativo selecciona Codex con motivo', async () => {
    const declarations = [declaration('claude'), declaration('codex'), declaration('opencode', { status: null })];
    const selection = await selectHarness(declarations, discovery({ claude: 'not_operable', codex: 'operable', opencode: 'operable' }));
    expect(selection.selected?.id).toBe('codex');
    expect(selection.skipped).toEqual([
      { id: 'claude', reason: expect.stringContaining('no operativo') },
      { id: 'opencode', reason: expect.stringContaining('no verificable') },
    ]);
  });

  it('ningún candidato: falla nombrando cada uno con su motivo; el orden es configurable', async () => {
    const declarations = [declaration('claude'), declaration('codex'), declaration('opencode')];
    const none = await selectHarness(declarations, discovery({ claude: 'absent', codex: 'not_operable', opencode: 'absent' }));
    expect(none.selected).toBeNull();
    expect(none.skipped.map((item) => item.id)).toEqual([...DEFAULT_HARNESS_ORDER]);
    const reordered = await selectHarness(declarations, discovery({ claude: 'operable', codex: 'operable', opencode: 'operable' }), ['opencode', 'claude']);
    expect(reordered.selected?.id).toBe('opencode');
  });

  it('declaraciones vigentes (2.6): solo Claude Code 2.1.330 y Codex 0.172.0 medidos son elegibles; OpenCode no verificable', async () => {
    // Salidas como las medidas en 2.6 (sin secretos).
    const measured: DiscoveryDeps & { calls: string[][] } = {
      calls: [],
      resolveBinary: async (binary) => `/fake/${binary}`,
      emptyDir: async () => path.join(os.tmpdir(), 'ai-hub-probe-vacio'),
      run: async (command, args) => {
        measured.calls.push([path.basename(command), ...args]);
        const id = path.basename(command);
        if (args[0] === '--version') {
          return { exitCode: 0, stdout: id === 'claude' ? '2.1.330 (Claude Code)' : id === 'codex' ? 'codex-cli 0.172.0' : 'opencode v2.3.2', started: true };
        }
        if (id === 'claude') {
          return { exitCode: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', started: true };
        }
        return { exitCode: 0, stdout: 'Logged in using ChatGPT', started: true };
      },
    };
    const selection = await selectHarness(HARNESS_DECLARATIONS, measured);
    expect(selection.eligible.map((item) => item.id)).toEqual(['claude', 'codex']);
    expect(selection.skipped).toEqual([{ id: 'opencode', reason: expect.stringContaining('no verificable') }]);
    // OpenCode no ejecuta su comando de estado: no tiene uno verificado.
    expect(measured.calls.filter((call) => call[0] === 'opencode').map((call) => call[1])).toEqual(['--version']);
    // Fuera del rango medido o sin sesión, no elegible.
    const newer = { ...measured, run: async (command: string, args: string[]) => (args[0] === '--version' ? { exitCode: 0, stdout: 'codex-cli 0.173.0', started: true } : measured.run(command, args, { cwd: '', timeoutMs: 1 })) };
    expect((await selectHarness(HARNESS_DECLARATIONS, newer, ['codex'])).skipped[0].reason).toContain('fuera del rango');
    const loggedOut = { ...measured, run: async (command: string, args: string[]) => (args[0] === '--version' ? { exitCode: 0, stdout: '2.1.330 (Claude Code)', started: true } : { exitCode: 1, stdout: '{"loggedIn": false}', started: true }) };
    expect((await selectHarness(HARNESS_DECLARATIONS, loggedOut, ['claude'])).skipped[0].reason).toContain('no operativo');
  });

  it('la salida medida de cada harness da el texto de cierre y el id de sesión', () => {
    const claude = HARNESS_DECLARATIONS.find((item) => item.id === 'claude')!;
    const codex = HARNESS_DECLARATIONS.find((item) => item.id === 'codex')!;
    expect(claude.headless!.output('{"type":"result","result":"hecho\\nAI-HUB-STATUS: DONE | artifact=- | reason=-","session_id":"6905-abc"}')).toEqual({
      text: 'hecho\nAI-HUB-STATUS: DONE | artifact=- | reason=-',
      sessionId: '6905-abc',
    });
    const jsonl = ['{"type":"thread.started","thread_id":"01a2-th"}', '{"type":"item.completed","item":{"type":"agent_message","text":"listo"}}', '{"type":"turn.completed"}'].join('\n');
    expect(codex.headless!.output(jsonl)).toEqual({ text: 'listo', sessionId: '01a2-th' });
    expect(codex.session!.resumeArgs('01a2-th')).toEqual(['exec', 'resume', '01a2-th', '--json', '--skip-git-repo-check']);
    expect(HARNESS_DECLARATIONS.find((item) => item.id === 'opencode')!.headless).toBeNull();
  });

  it('sonda no declarada no arranca proceso (capability_unverified); declarada da diagnosed y no hace operable', async () => {
    const deps = discovery({ codex: 'not_operable' });
    expect(await runProbe(declaration('codex'), deps)).toEqual({ result: 'capability_unverified', started: false });
    expect(deps.calls).toEqual([]);
    const probed = await runProbe(declaration('codex', { probe: { args: ['probe'], evidence: 'doble' } }), deps);
    expect(probed).toMatchObject({ result: 'diagnosed', started: true });
    expect((await selectHarness([declaration('codex')], deps)).selected).toBeNull();
  });

  it('el descubrimiento no abre archivos: el módulo no importa el sistema de archivos', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '..', 'src', 'runner', 'discovery.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]node:fs|from ['"]fs['"]|readFile|open\(/);
  });
});

let grants = 0;
async function grant(overrides: Partial<{ effects: string[] }> = {}): Promise<RunClaim> {
  grants += 1;
  const request = await submitRequest(
    h.root,
    {
      project: 'grp/demo',
      iid: 42,
      summary: `implementar ${grants}`,
      worktree: '.',
      effects: overrides.effects ?? ['edit:src/**'],
      base: 'a'.repeat(40),
      seal: null,
      limits: { maxMinutes: 30 },
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    },
    NOW,
  );
  await setRequestStatus(h.root, request.id, 'approved', APPROVER, NOW);
  return { iid: 42, grantId: request.id, project: 'grp/demo', worktree: '.', effects: ['edit:src/**'], seal: null, approvers: [APPROVER], now: NOW };
}

function launcher(script: Record<string, (run: string) => Awaited<ReturnType<Launcher>>>): Launcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async ({ harness: id, run }) => {
    calls.push(id);
    return script[id](run);
  }) as Launcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const closing = (run: string) => `trabajo hecho\nAI-HUB-STATUS: CONVERGED | artifact=- | run=${run} | reason=done`;

describe('ejecución concedida de extremo a extremo con dobles (5.10–5.13, 5.16)', () => {
  async function base(claim: RunClaim, launch: Launcher, extra: Partial<Parameters<typeof executeGrantedRun>[1]> = {}) {
    const project = (await loadManifest(h.root)).project.id;
    return executeGrantedRun(
      { root: h.root, claim, contextProject: project, worktreePath: h.root, target: 'claude', task: 'tarea', now: NOW },
      {
        declarations: [declaration('claude'), declaration('codex')],
        discovery: discovery({ claude: 'operable', codex: 'operable' }),
        launch,
        context: { lockFresh: async () => true },
        ...extra,
      },
    );
  }

  it('cierre correcto: run id compartido, concesión consumida por ese run, nota publicada una vez y telemetría', async () => {
    await h.consumer();
    const notes: string[] = [];
    const sink = { issueNotes: async () => notes.map((body) => ({ body })), postIssueNote: async (_iid: number, body: string) => void notes.push(body) };
    const claim = await grant();
    const launch = launcher({ claude: (run) => ({ phase: 'completed', ok: true, output: closing(run) }) });
    const outcome = await base(claim, launch, { notes: sink });
    expect(outcome).toMatchObject({ state: 'completed', harness: 'claude', accepted: true, closing: 'CONVERGED' });
    const run = (outcome as { run: string }).run;
    const kinds = (await readRunEvents(h.root, run)).map((event) => event.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds.at(-1)).toBe('end');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`ai-hub:run=${run}`);
    // Repetir la misma concesión desde otro run: rechazada nombrando el run que la consumió.
    const again = await base(claim, launch, { notes: sink });
    expect(again).toMatchObject({ state: 'refused', reason: expect.stringMatching(/grant_consumed|grant_invalid/) });
    expect(notes).toHaveLength(1);
  });

  it('fallo antes del arranque prueba el siguiente; fallo tras el arranque retiene sin probar otro', async () => {
    await h.consumer();
    const fallback = launcher({
      claude: () => ({ phase: 'resolve', ok: false, output: '', reason: 'binario ausente' }),
      codex: (run) => ({ phase: 'completed', ok: true, output: closing(run) }),
    });
    expect(await base(await grant(), fallback)).toMatchObject({ state: 'completed', harness: 'codex' });
    expect(fallback.calls).toEqual(['claude', 'codex']);
    const held = launcher({
      claude: () => ({ phase: 'task_delivered', ok: false, output: '', sessionId: 'sess-1' }),
      codex: (run) => ({ phase: 'completed', ok: true, output: closing(run) }),
    });
    const outcome = await base(await grant(), held);
    expect(outcome).toMatchObject({ state: 'held', harness: 'claude', reason: 'reconcile_required' });
    expect(held.calls).toEqual(['claude']);
  });

  it('sesión reanudable: se ofrece solo tras reconciliar y solo si el harness declara sesiones (5.13)', async () => {
    await h.consumer();
    const held = launcher({ claude: () => ({ phase: 'started', ok: false, output: '', sessionId: 'sess-42' }), codex: () => ({ phase: 'completed', ok: true, output: '' }) });
    const outcome = (await base(await grant(), held)) as { run: string };
    const declarations = [declaration('claude'), declaration('codex')];
    expect(await resumeOffer(h.root, outcome.run, declarations)).toEqual({ offer: false, reason: 'reconcile_first' });
    await markReconciled(h.root, outcome.run);
    expect(await resumeOffer(h.root, outcome.run, declarations)).toEqual({ offer: true, harness: 'claude', args: ['--resume', 'sess-42'] });
    expect(await resumeOffer(h.root, outcome.run, [declaration('claude', { session: null })])).toEqual({ offer: false, reason: 'not_resumable' });
  });

  it('worktree ocupado por otra ejecución: rechazada sin consumir la concesión (5.10)', async () => {
    await h.consumer();
    const holder = await lockWorktree(h.root, h.root, 'otro-run');
    try {
      const claim = await grant();
      const launch = launcher({ claude: (run) => ({ phase: 'completed', ok: true, output: closing(run) }) });
      expect(await base(claim, launch)).toMatchObject({ state: 'refused', reason: 'worktree_locked' });
      expect(launch.calls).toEqual([]);
    } finally {
      await holder.release();
    }
  });

  it('issue por ejecución activada: una sola aunque el run se reintente (5.16)', async () => {
    await h.consumer();
    const issues = new Map<number, string>();
    const runIssues = {
      enabled: true,
      findIssuesWithMarker: async (marker: string) => [...issues.entries()].filter(([, body]) => body.includes(marker)).map(([iid]) => iid),
      createIssue: async (_title: string, body: string) => {
        issues.set(issues.size + 1, body);
        return issues.size;
      },
    };
    const outcome = await base(await grant(), launcher({ claude: (run) => ({ phase: 'completed', ok: true, output: closing(run) }) }), { runIssues });
    expect(outcome.state).toBe('completed');
    expect(issues.size).toBe(1);
  });

  it('lanzador real con un proceso doble: recibe el run id, su cierre se vincula y la ejecución sin declarar no arranca', async () => {
    await h.consumer();
    const script = "console.log('AI-HUB-STATUS: CONVERGED | artifact=- | run=' + process.env.AI_HUB_RUN_ID + ' | reason=done')";
    const node = declaration('claude', { headless: { args: [], evidence: 'doble', build: () => ['-e', script], output: (stdout) => ({ text: stdout, sessionId: null }) } });
    const launch = processLauncher([node, declaration('codex')], async (binary) => (binary === 'claude' ? process.execPath : null), 20_000);
    const outcome = await base(await grant(), launch);
    expect(outcome).toMatchObject({ state: 'completed', harness: 'claude', accepted: true });
    const real = processLauncher(HARNESS_DECLARATIONS, async () => process.execPath, 20_000);
    expect(await real({ harness: 'opencode', run: 'r', cwd: h.root, env: {}, task: 't' })).toMatchObject({ phase: 'resolve', ok: false });
  }, 30_000);
});

describe('dependencias reales del descubrimiento (host)', () => {
  it('resuelve el binario por PATH sin shell y ejecuta en un directorio temporal vacío fuera del proyecto', async () => {
    const { hostDiscoveryDeps } = await import('../src/runner/host.js');
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-bin-'));
    try {
      const name = process.platform === 'win32' ? 'harness-doble.exe' : 'harness-doble';
      await fs.writeFile(path.join(bin, name), 'x');
      if (process.platform === 'win32') {
        await fs.writeFile(path.join(bin, 'solo-shim.cmd'), 'x');
      }
      const deps = hostDiscoveryDeps({ PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, process.platform);
      expect(await deps.resolveBinary('harness-doble')).toBe(path.join(bin, name));
      // Un shim `.cmd` no se lanza sin shell: se informa como ausente.
      expect(await deps.resolveBinary('solo-shim')).toBeNull();
      expect(await deps.resolveBinary('no-existe-ai-hub')).toBeNull();
      const dir = await deps.emptyDir();
      expect(await fs.readdir(dir)).toEqual([]);
      const result = await deps.run(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd: dir, timeoutMs: 10_000 });
      expect(result).toMatchObject({ exitCode: 0, started: true });
      expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(dir));
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      await fs.rm(bin, { recursive: true, force: true });
    }
  });
});
