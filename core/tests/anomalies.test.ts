import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDecide } from '../src/control/decide.js';
import type { HermesCli } from '../src/control/hermes.js';
import { CONTROL_DIR, readDecisions, recordDecision, type Decision } from '../src/control/ledger.js';
import { resolveListener } from '../src/control/listener.js';
import { setTrackerSleep } from '../src/control/tracker.js';
import { buildGuardContext } from '../src/harness/guards/adapters/context.js';
import { runPreflight } from '../src/harness/guards/preflight.js';
import { SimulatedCrash, transactWrite } from '../src/writes/transaction.js';
import { fakeGitlab, TOKEN_SENTINEL, writes, type FakeGitlab, type FakeIssue } from './control-fake.js';
import { APPROVER, NOW, harness, issue, type Harness } from './control-harness.js';
import { gitUnavailable, runGit } from './git.js';

/**
 * Catálogo ejecutable de anomalías (R-021–R-030, tareas 4.1–4.10). Cada fixture declara su contrato completo y
 * una función que lo ejecuta contra el código real; `weaken` desactiva la protección que la fixture prueba
 * (por sustitución de módulo en la prueba, sin interruptores en el código de producción) y al menos una
 * aserción debe fallar (R-028). Los centinelas se buscan en toda salida y archivo (R-027).
 */

// --- Debilitamientos (R-028): sustituyen la protección nombrada solo dentro de esta prueba. ---------------
const weak = vi.hoisted(() => ({ ambiguous: false, barrier: false, permit: false, store: false }));

vi.mock('../src/control/ledger.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/control/ledger.js')>();
  /** Lector anterior a R-025: salta las líneas ilegibles y no detiene nada. */
  async function lenientDecisions(root: string): Promise<Map<string, Decision>> {
    const text = await fs.readFile(path.join(root, real.CONTROL_DIR, 'decisions.jsonl'), 'utf8').catch(() => '');
    const decisions = new Map<string, Decision>();
    for (const raw of text.split('\n')) {
      let line: { type?: string; decision?: Decision; id?: string; status?: Decision['status']; ts?: string };
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (line.type === 'decision' && line.decision) {
        decisions.set(line.decision.id, { ...line.decision, updatedAt: line.ts ?? '' });
      } else if (line.type === 'status' && line.id && line.status && decisions.has(line.id)) {
        decisions.set(line.id, { ...decisions.get(line.id)!, status: line.status });
      }
    }
    return decisions;
  }
  return {
    ...real,
    readDecisions: async (root: string) => {
      const all = weak.barrier ? await lenientDecisions(root) : await real.readDecisions(root);
      if (!weak.ambiguous) {
        return all;
      }
      // Lector anterior a R-022: solo la decisión abierta más reciente de cada issue.
      const newest = new Map<number, Decision>();
      for (const decision of all.values()) {
        if (real.OPEN_STATUSES.includes(decision.status) && (!newest.has(decision.iid) || decision.createdAt > newest.get(decision.iid)!.createdAt)) {
          newest.set(decision.iid, decision);
        }
      }
      return new Map([...all].filter(([, decision]) => !real.OPEN_STATUSES.includes(decision.status) || newest.get(decision.iid)?.id === decision.id));
    },
    ledgerBarrier: async (root: string) => (weak.barrier ? { issues: new Set<number>(), project: false, lines: [], corrupt: [] } : real.ledgerBarrier(root)),
  };
});

vi.mock('../src/control/label-policy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/control/label-policy.js')>();
  return {
    ...real,
    labelPermit: (...args: Parameters<typeof real.labelPermit>) => {
      const permit = real.labelPermit(...args);
      // Sin la retención: se presenta una garantía condicional que el tracker no ofrece.
      return weak.permit ? { kind: 'protected' as const, capability: permit.capability } : permit;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (file: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
    if (weak.store && String(file).endsWith('webhook_subscriptions.json')) {
      // Sin la clasificación de R-023: el store ilegible se lee como ausente.
      throw Object.assign(new Error('ENOENT (debilitado)'), { code: 'ENOENT' });
    }
    return (real.readFile as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.readFile;
  return { ...real, readFile, default: { ...real.default, readFile } };
});

// --- Formato de fixture (4.1, R-021). --------------------------------------------------------------------
type Coverage = 'contrato-completo' | 'contrato-actual';

export interface AnomalyFixture {
  id: string;
  version: number;
  input: string;
  fault: string;
  expected: { result: string; code: number | null; diagnostic: string };
  effects: { allowed: string[]; forbidden: string[] };
  sentinels: string[];
  recovery: string;
  protection: string;
  coverage: Coverage;
  execute: (weaken: boolean) => Promise<void>;
}

const REQUIRED: ReadonlyArray<string> = [
  'id',
  'version',
  'input',
  'fault',
  'expected.result',
  'expected.code',
  'expected.diagnostic',
  'effects.allowed',
  'effects.forbidden',
  'sentinels',
  'recovery',
  'protection',
  'coverage',
  'execute',
];

/** Campos que faltan, como `<id>: falta <campo>`; una lista vacía de efectos prohibidos o de centinelas cuenta como falta. */
export function fixtureProblems(fixture: Record<string, unknown>): string[] {
  const id = typeof fixture.id === 'string' ? fixture.id : '(sin id)';
  const problems: string[] = [];
  for (const field of REQUIRED) {
    const value = field.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), fixture);
    const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0 && (field === 'effects.forbidden' || field === 'sentinels'));
    if (empty) {
      problems.push(`${id}: falta ${field}`);
    }
  }
  return problems;
}

// --- Utilidades comunes. ---------------------------------------------------------------------------------
let h: Harness;
const scratch: string[] = [];

beforeEach(async () => {
  h = await harness();
  setTrackerSleep(async () => undefined);
});
afterEach(async () => {
  Object.assign(weak, { ambiguous: false, barrier: false, permit: false, store: false });
  setTrackerSleep(null);
  await h.dispose();
  for (const dir of scratch.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function treeTexts(dir: string): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'node_modules') {
        out.push(...(await treeTexts(full)));
      }
    } else {
      out.push({ file: full, text: await fs.readFile(full, 'utf8').catch(() => '') });
    }
  }
  return out;
}

/**
 * R-027: ningún centinela en stdout, stderr, notas del tracker, salud, telemetría ni archivos del repositorio.
 * `allowedFiles` son los archivos que contienen el centinela por diseño de la fixture (la credencial misma).
 */
async function assertNoSentinel(sentinels: string[], outputs: string[], roots: string[], allowedFiles: string[], gitlab?: FakeGitlab): Promise<void> {
  const notes = gitlab ? [...gitlab.issues.values()].flatMap((item) => item.notes.map((note) => note.body)) : [];
  const requests = gitlab ? writes(gitlab.requests).map((request) => JSON.stringify(request.body ?? '')) : [];
  for (const sentinel of sentinels) {
    for (const text of [...outputs, ...notes, ...requests]) {
      expect(text).not.toContain(sentinel);
    }
    for (const root of roots) {
      for (const { file, text } of await treeTexts(root)) {
        if (!allowedFiles.includes(path.resolve(file))) {
          expect(text, `${sentinel} en ${file}`).not.toContain(sentinel);
        }
      }
    }
  }
}

const harnessEnv = (): string => path.resolve(h.root, '.ai-hub', '.env');

async function published(labels: 'withhold' | 'unprotected', notes: FakeIssue['notes'] = []): Promise<{ gitlab: FakeGitlab; id: string }> {
  await h.consumer({ labels });
  await h.feature('001-alpha');
  await h.status('001-alpha', 'CONVERGED');
  const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev', { notes })]);
  const { fresh } = await runDecide(h.root, { online: true, trackerFetch: gitlab.fetch, now: NOW });
  gitlab.requests.length = 0;
  h.use(gitlab);
  return { gitlab, id: fresh[0].decision.id };
}

const ROUTE = 'ai-hub-gitlab';
const STORE_SENTINEL = 'AIHUB_ANOMALY_STORE_SENTINEL_7d21';
const MULTIPLEX = 'Gateway is running via the default-profile multiplexer';

async function listenerFixture(storeText: string | null, weaken = false): Promise<{ home: string; view: Awaited<ReturnType<typeof resolveListener>>; before: Buffer | null; file: string }> {
  const home = await tempDir('ai-anomaly-home-');
  await fs.mkdir(path.join(home, 'profiles', 'hermes-control'), { recursive: true });
  await fs.writeFile(path.join(home, 'config.yaml'), 'model: x\nplatforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 8644\n');
  const file = path.join(home, 'webhook_subscriptions.json');
  if (storeText !== null) {
    await fs.writeFile(file, storeText);
  }
  const before = storeText === null ? null : await fs.readFile(file);
  const cli: HermesCli = {
    path: 'hermes',
    version: '0.23.0',
    run: async (args) => {
      const rest = args[0] === '-p' ? args.slice(2) : args;
      if (rest[0] === 'gateway') {
        return { status: 0, stdout: MULTIPLEX, stderr: '' };
      }
      if (rest[0] === 'webhook' && rest[1] === 'list') {
        return { status: 0, stdout: `  ◆ ${ROUTE}`, stderr: '' };
      }
      return { status: 2, stdout: '', stderr: 'unexpected' };
    },
  };
  // El debilitamiento solo envuelve la resolución, no las lecturas de la propia prueba.
  weak.store = weaken;
  const view = await resolveListener({ cli, home, profile: 'hermes-control', route: ROUTE, probe: async () => 'listening' }).finally(() => {
    weak.store = false;
  });
  return { home, view, before, file };
}

// --- Catálogo (4.2–4.8). ---------------------------------------------------------------------------------
const CATALOG: AnomalyFixture[] = [
  {
    id: 'ambiguous-two-decisions',
    version: 1,
    input: 'dos decisiones abiertas para la issue 7 con el mismo prefijo de hash (publicadores concurrentes); respuesta `aprobar 7 <prefijo>`',
    fault: 'una segunda decisión abierta escrita en el registro sin sustituir a la primera',
    expected: { result: 'rechazo sin aplicar', code: 1, diagnostic: 'nombra ambas decisiones y «no se escribe nada»' },
    effects: { allowed: ['lecturas del registro'], forbidden: ['PUT de etiqueta', 'nota en el tracker', 'línea nueva en el registro'] },
    sentinels: [TOKEN_SENTINEL],
    recovery: 'la persona elige con `aprobar 7 confirmar <ref>` (se obtiene con `aprobar 7`)',
    protection: 'R-022: selección de candidatas en `applyReply` (debilitada: solo la abierta más reciente)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      weak.ambiguous = weaken;
      const { gitlab, id } = await published('unprotected');
      const a = (await readDecisions(h.root)).get(id)!;
      const b = { ...a, id: `${'d'.repeat(8)}${a.id.slice(8)}`, to: 'ai::blocked', createdAt: new Date(NOW.getTime() + 1000).toISOString() };
      await recordDecision(h.root, b);
      const before = await h.ledgerText();
      const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--reply', `aprobar 7 ${a.hash.slice(0, 8)}`]);
      expect(writes(gitlab.requests)).toEqual([]);
      expect(await h.ledgerText()).toBe(before);
      expect(result.code).toBe(1);
      expect(result.err).toContain(a.id.slice(0, 8));
      expect(result.err).toContain(b.id.slice(0, 8));
      await assertNoSentinel(this.sentinels, [result.out, result.err], [h.root], [harnessEnv()], gitlab);
    },
  },
  {
    id: 'store-corrupted',
    version: 1,
    input: 'store de rutas del dueño del listener con JSON inválido que contiene un secreto; `webhook list` lista la ruta',
    fault: 'archivo `webhook_subscriptions.json` truncado',
    expected: { result: 'aviso de corrupción con la otra fuente y la incertidumbre', code: null, diagnostic: 'store_corrupt' },
    effects: { allowed: ['lectura del store', '`hermes webhook list`'], forbidden: ['reescribir o reparar el store', 'tratarlo como ausente', 'secreto del store en la salida'] },
    sentinels: [STORE_SENTINEL],
    recovery: 'la persona revisa el store; `enroll --check` vuelve a contrastar',
    protection: 'R-023: clasificación `malformed` de `readRouteStore` y aviso en `resolveListener` (debilitada: lectura como ausente)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      const { home, view, before, file } = await listenerFixture(`{ "ai-hub-gitlab": { "secret": "${STORE_SENTINEL}"`, weaken);
      const notices = view.notices.join('\n');
      expect(notices).toContain('store_corrupt');
      expect(notices).toContain(`sí lista la ruta ${ROUTE}`);
      expect((await fs.readFile(file)).equals(before!)).toBe(true);
      await assertNoSentinel(this.sentinels, [notices, JSON.stringify(view)], [], [], undefined);
      expect(home).not.toBe('');
    },
  },
  {
    id: 'store-absent',
    version: 1,
    input: 'sin store de rutas; `webhook list` lista la ruta',
    fault: 'archivo `webhook_subscriptions.json` inexistente',
    expected: { result: 'ruta tomada de `webhook list`, sin aviso de corrupción', code: null, diagnostic: 'routeSource=list' },
    effects: { allowed: ['`hermes webhook list`'], forbidden: ['informar corrupción', 'crear el store'] },
    sentinels: [STORE_SENTINEL],
    recovery: 'ninguna necesaria',
    protection: 'R-023: distinción ENOENT frente a ilegible (debilitada: un store ausente presentado como corrupto)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      // El debilitamiento invierte la distinción: se escribe un store ilegible donde la fixture espera ausencia.
      const { home, view, file } = await listenerFixture(weaken ? '{ roto' : null);
      expect(view.notices.join('\n')).not.toContain('store_corrupt');
      expect(view).toMatchObject({ route: 'present', routeSource: 'list' });
      await expect(fs.access(file)).rejects.toThrow();
      expect(home).not.toBe('');
    },
  },
  {
    id: 'lock-hash-mismatch',
    version: 1,
    input: 'consumidor sincronizado cuyo `sync.lock.json` declara un hash de archivo distinto',
    fault: 'hash de un destino alterado en el lock',
    expected: { result: 'verificación fallida sin reparar', code: 1, diagnostic: 'difieren' },
    effects: { allowed: ['lectura de destinos y lock'], forbidden: ['escribir destinos', 'escribir el lock'] },
    sentinels: [TOKEN_SENTINEL],
    recovery: '`ai-hub sync` explícito regenera',
    protection: 'R-024: `sync --check-lock` es de solo lectura (debilitada: se ejecuta `sync`, que regenera)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      await h.consumer();
      const lockFile = path.join(h.root, 'sync.lock.json');
      const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as { files: Record<string, { hash: string }> };
      const target = Object.keys(lock.files).find((name) => name.endsWith('.md'))!;
      lock.files[target].hash = '0'.repeat(64);
      await fs.writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
      const before = await treeTexts(h.root);
      const result = await h.cli(weaken ? ['sync'] : ['sync', '--check-lock']);
      expect(result.code).toBe(1);
      expect(result.out).toContain('difieren');
      expect(await treeTexts(h.root)).toEqual(before);
      await assertNoSentinel(this.sentinels, [result.out, result.err], [h.root], [harnessEnv()]);
    },
  },
  {
    id: 'recovery-after-interrupt',
    version: 1,
    input: '(a) escritura transaccional interrumpida tras el temporal; (b) registro de decisiones con una línea truncada',
    fault: '(a) `SimulatedCrash` antes del reemplazo; (b) línea JSON incompleta al final del registro',
    expected: { result: '(a) original intacto y temporal informado al rearrancar; (b) control detenido con el registro intacto', code: 1, diagnostic: 'ledger_corrupt' },
    effects: { allowed: ['temporal huérfano informado', 'lecturas'], forbidden: ['original modificado', 'decisión aplicada', 'registro reescrito'] },
    sentinels: [TOKEN_SENTINEL],
    recovery: '(a) la siguiente transacción informa el temporal y completa; (b) una persona revisa el registro',
    protection: 'R-025: barrera del registro ante líneas ilegibles (debilitada: lector que las salta)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      weak.barrier = weaken;
      const { gitlab, id } = await published('unprotected');
      // (a) Interrupción entre el temporal y el reemplazo, en la raíz del consumidor.
      const root = h.root;
      const file = path.join(root, '.gitignore');
      await fs.writeFile(file, 'original\n');
      const base = { root, file, module: 'test', capture: false, retention: 0, env: {} } as const;
      await expect(
        transactWrite({
          ...base,
          transform: () => 'nuevo\n',
          lock: { host: 'h', pid: 9999, isAlive: () => false, waitMs: 1000, pollMs: 5 },
          hooks: {
            afterTempWritten: () => {
              throw new SimulatedCrash('kill');
            },
          },
        }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(await fs.readFile(file, 'utf8')).toBe('original\n');
      // Al arrancar, doctor informa la interrupción (solo el nombre del temporal).
      const doctor = await h.cli(['doctor']);
      expect(doctor.out).toContain('leftover-temps: aviso: 1 temporal(es)');
      expect(doctor.out).toContain('.gitignore.ai-hub-tmp-');
      const restart = await transactWrite({ ...base, transform: (current) => current ?? '', lock: { host: 'h', pid: 10000, isAlive: (pid: number) => pid === 10000, waitMs: 1000, pollMs: 5 } });
      expect(restart.leftoverTemps).toHaveLength(1);
      // (b) Registro con una línea truncada.
      const ledger = path.join(h.root, CONTROL_DIR, 'decisions.jsonl');
      await fs.appendFile(ledger, '{"v":1,"type":"status","id":"trunc');
      const bytes = await fs.readFile(ledger);
      const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
      expect(writes(gitlab.requests)).toEqual([]);
      expect((await fs.readFile(ledger)).equals(bytes)).toBe(true);
      expect(result.code).toBe(1);
      expect(result.err).toContain('ledger_corrupt');
      await assertNoSentinel(this.sentinels, [result.out, result.err, doctor.out, doctor.err], [h.root], [harnessEnv()], gitlab);
    },
  },
  {
    id: 'review-seal-changed',
    version: 1,
    input: 'rama `feat` con revisión sellada (APPROVE) y un cambio posterior del diff',
    fault: 'el diff cambia después de sellar el veredicto',
    expected: { result: 'la guardia ship deniega la vuelta a la trunk', code: null, diagnostic: 'ship:review-seal' },
    effects: { allowed: ['lectura del sello y del diff'], forbidden: ['permitir `git checkout main`'] },
    sentinels: [TOKEN_SENTINEL],
    recovery: 'volver a revisar y sellar con `ai-hub seal review`',
    protection: 'R-026: revalidación del sello en `classifyReviewSeal` (debilitada: contexto sin revisión)',
    // Cubre la guardia existente; el panel del candidato congelado tendrá su propia fixture (R-026).
    coverage: 'contrato-actual',
    async execute(weaken) {
      await h.consumer();
      const git = (...args: string[]): void => {
        expect(runGit(args, h.root).status, args.join(' ')).toBe(0);
      };
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('add', '.');
      git('commit', '-m', 'base');
      git('checkout', '-b', 'feat');
      await fs.mkdir(path.join(h.root, 'src'), { recursive: true });
      await fs.writeFile(path.join(h.root, 'src', 'a.ts'), 'export const a = 1;\n');
      git('add', '.');
      git('commit', '-m', 'feat');
      const sealed = await h.cli(['seal', 'review', '--verdict', 'APPROVE']);
      expect(sealed.code, sealed.out + sealed.err).toBe(0);
      await fs.writeFile(path.join(h.root, 'src', 'a.ts'), 'export const a = 2;\n');
      git('commit', '-am', 'cambio tras sellar');
      const context = await buildGuardContext({ root: h.root, preset: 'generic-ts', languages: ['typescript'], policy: { trunk: 'open', guardMode: 'enforce', optOuts: [] } });
      const result = runPreflight('git checkout main', weaken ? { ...context, review: undefined } : context);
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('ship:review-seal');
      await assertNoSentinel(this.sentinels, [JSON.stringify(result), sealed.out, sealed.err], [h.root], [harnessEnv()]);
    },
  },
  {
    id: 'tracker-pagination-incomplete',
    version: 1,
    input: 'issue con 150 notas en páginas de 100; la evidencia CONVERGED más reciente es la nota 130 (página 2)',
    fault: 'la petición de la página 2 falla (404) en una segunda lectura',
    expected: { result: 'lectura completa usa la evidencia; lectura incompleta detiene la decisión', code: 2, diagnostic: 'error del tracker, nunca lista parcial' },
    effects: { allowed: ['GET paginados'], forbidden: ['decisión publicada con una lectura incompleta', 'escrituras en el tracker'] },
    sentinels: [TOKEN_SENTINEL],
    recovery: 'el siguiente poll repite la lectura completa',
    protection: 'R-029: `readAll` sigue x-next-page/Link y falla ante una página fallida (debilitada: sin cabeceras de paginación, la primera página parece la última)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      await h.consumer();
      await h.feature('001-alpha');
      const notes = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, body: index + 1 === 130 ? 'AI-HUB-STATUS: CONVERGED | artifact=- | reason=-' : `nota ${index + 1}`, authorId: 1 }));
      const gitlab = fakeGitlab([issue(7, '001-alpha', 'ai::in-dev', { notes })]);
      const fetch: FakeGitlab['fetch'] = weaken
        ? async (url, init) => {
            const response = await gitlab.fetch(url, init);
            // Sin paginación y con páginas cortas, la primera página parece la última (truncación silenciosa).
            const data = await response.json();
            const short = Array.isArray(data) && data.length >= 100 ? data.slice(0, 99) : data;
            return { status: response.status, json: async () => short, headers: { get: () => null } };
          }
        : gitlab.fetch;
      const complete = await runDecide(h.root, { online: true, trackerFetch: fetch, now: NOW });
      expect(complete.fresh.map((view) => view.decision.to)).toContain('ai::in-review');
      // Una página fallida: la decisión se detiene y no se publica nada.
      await h.consumer();
      await h.feature('001-alpha');
      const failing = fakeGitlab([issue(8, '001-alpha', 'ai::in-dev', { notes })]);
      failing.failPage(/\/issues\/8\/notes$/, 2, { status: 404 });
      h.use(failing);
      const stopped = await h.cli(['control', 'decide', '--online', '--format', 'json']);
      expect(stopped.code).toBe(2);
      expect(writes(failing.requests)).toEqual([]);
      expect([...(await readDecisions(h.root)).values()].filter((decision) => decision.iid === 8)).toEqual([]);
      await assertNoSentinel(this.sentinels, [stopped.out, stopped.err], [h.root], [harnessEnv()], failing);
    },
  },
  {
    id: 'label-changed-before-put',
    version: 1,
    input: 'decisión aprobable para la issue 7 en modo por defecto (`withhold`); una persona cambia la etiqueta durante apply',
    fault: 'la etiqueta pasa a `ai::blocked` entre la lectura de apply y la actualización',
    expected: { result: 'sin PUT y sin éxito', code: 1, diagnostic: 'label_update_unprotected' },
    effects: { allowed: ['GET de la issue'], forbidden: ['PUT de etiqueta', 'informar éxito'] },
    sentinels: [TOKEN_SENTINEL],
    recovery: 'la decisión queda pendiente; con capacidad declarada, la actualización condicional la rechazaría',
    protection: 'R-030, R-004: retención sin garantía condicional verificada (debilitada: se presenta una garantía inexistente)',
    coverage: 'contrato-completo',
    async execute(weaken) {
      weak.permit = weaken;
      const { gitlab, id } = await published('withhold');
      const original = gitlab.fetch;
      let reads = 0;
      gitlab.fetch = async (url, init) => {
        if ((init.method ?? 'GET') === 'GET' && /\/issues\/7$/.test(new URL(url).pathname)) {
          reads += 1;
          const response = await original(url, init);
          gitlab.issues.get(7)!.labels = ['ai::blocked'];
          return response;
        }
        return original(url, init);
      };
      h.use(gitlab);
      const result = await h.cli(['control', 'apply', '--approver', APPROVER, '--', 'aprobar', '7', id.slice(0, 8)]);
      expect(writes(gitlab.requests).filter((request) => request.method === 'PUT')).toEqual([]);
      expect(result.code).toBe(1);
      expect(result.out + result.err).toContain('label_update_unprotected');
      expect((await readDecisions(h.root)).get(id)?.status).not.toBe('applied');
      expect(reads).toBeGreaterThan(0);
      await assertNoSentinel(this.sentinels, [result.out, result.err], [h.root], [harnessEnv()], gitlab);
    },
  },
];

const EXPECTED_IDS = [
  'ambiguous-two-decisions',
  'store-corrupted',
  'store-absent',
  'lock-hash-mismatch',
  'recovery-after-interrupt',
  'review-seal-changed',
  'tracker-pagination-incomplete',
  'label-changed-before-put',
];

const gitSkip = gitUnavailable() !== null;

describe('catálogo de anomalías (4.1, R-021)', () => {
  it('contiene cada anomalía exigida con todos sus campos', () => {
    expect(CATALOG.map((fixture) => fixture.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const fixture of CATALOG) {
      expect(fixtureProblems(fixture as unknown as Record<string, unknown>)).toEqual([]);
    }
  });

  it('una fixture sin efectos prohibidos se rechaza nombrando la fixture y el campo', () => {
    const [first] = CATALOG;
    const broken = { ...first, effects: { allowed: first.effects.allowed } };
    expect(fixtureProblems(broken as unknown as Record<string, unknown>)).toEqual([`${first.id}: falta effects.forbidden`]);
    expect(fixtureProblems({ ...first, sentinels: [] } as unknown as Record<string, unknown>)).toEqual([`${first.id}: falta sentinels`]);
  });

  it('la cobertura del sello existente se etiqueta distinta de la del panel futuro (R-026)', () => {
    expect(CATALOG.find((fixture) => fixture.id === 'review-seal-changed')?.coverage).toBe('contrato-actual');
  });
});

describe.each(CATALOG.map((fixture) => [fixture.id, fixture] as const))('fixture %s (4.2–4.10)', (id, fixture) => {
  const skip = id === 'review-seal-changed' && gitSkip;

  it.skipIf(skip)('cumple su contrato y no filtra centinelas', async () => {
    await fixture.execute(false);
  }, 60_000);

  it.skipIf(skip)('con la protección desactivada, al menos una aserción falla (R-028)', async () => {
    // El fallo debe ser una aserción de la fixture (resultado o efecto prohibido), no un error incidental.
    const error = await fixture.execute(true).then(() => null, (caught: unknown) => caught);
    expect(error, 'la fixture debilitada no falló').not.toBeNull();
    expect((error as Error).name).toBe('AssertionError');
  }, 60_000);
});
