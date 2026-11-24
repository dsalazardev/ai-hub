import { consumeGrant, verifyGrantForRun, type RunClaim } from '../control/grants.js';
import { LockHeldError } from '../harness/lock.js';
import { appendRunEvent } from '../harness/runs.js';
import { readState, updateState, type ExecutionIndexEntry } from '../harness/state-store.js';
import { assignRun, bindClosing, harnessEnvironment, recordContext, verifyCanonicalContext, type ContextDeps } from './execution.js';
import { describeNoCandidate, selectHarness, type DiscoveryDeps, type HarnessDeclaration } from './discovery.js';
import { ensureRunIssue, lockWorktree, postNoteOnce, runWithFallback, type Attempt, type NoteSink, type RunIssueSink } from './process.js';

/**
 * Orquestación de una ejecución concedida (R-093–R-103): concesión verificada → harness seleccionado → contexto
 * canónico verificado → run id → lock del worktree → consumo exclusivo de la concesión → arranque con fallback solo
 * antes del arranque → cierre vinculado al run, o retención para reconciliar. Cada paso es un componente probado por
 * separado; aquí se encadenan. El lanzador es inyectable: el real solo arranca harnesses con ejecución sin interfaz
 * declarada y verificada, y hoy ninguno la tiene (2.6), así que la ejecución real queda deshabilitada.
 */

export interface LaunchResult {
  phase: Attempt['phase'];
  ok: boolean;
  /** Salida en memoria; solo se lee su última línea para el cierre. */
  output: string;
  sessionId?: string | null;
  reason?: string;
}

export type Launcher = (input: { harness: string; run: string; cwd: string; env: Record<string, string>; task: string }) => Promise<LaunchResult>;

export interface ExecutionRequestInput {
  root: string;
  claim: RunClaim;
  /** Id del proyecto en `manifest.project.id` (contexto canónico). */
  contextProject: string;
  /** Ruta absoluta del worktree concedido. */
  worktreePath: string;
  target: string;
  task: string;
  order?: readonly string[];
  now?: Date;
}

export interface ExecutionDeps {
  declarations: readonly HarnessDeclaration[];
  discovery: DiscoveryDeps;
  launch: Launcher;
  context?: ContextDeps;
  notes?: NoteSink;
  runIssues?: RunIssueSink & { enabled?: boolean };
}

export type ExecutionOutcome =
  | { state: 'refused'; reason: string; detail: string; run: string | null }
  | { state: 'completed'; run: string; harness: string; accepted: boolean; closing: string }
  | { state: 'held'; run: string; harness: string; reason: 'reconcile_required' }
  | { state: 'exhausted'; run: string; detail: string };

async function index(root: string, run: string, patch: Partial<RunIndex>): Promise<void> {
  await updateState<RunIndex>(root, 'execution-index', (records) => ({ ...records, [run]: { ...(records[run] ?? { run, createdAt: new Date().toISOString() }), ...patch } }));
}

/** Entrada del índice de ejecuciones con lo necesario para reconciliar y reanudar (sin salida ni secretos). */
export interface RunIndex extends ExecutionIndexEntry {
  harness?: string;
  session?: string;
  state?: 'running' | 'held' | 'completed' | 'reconciled';
}

export async function executeGrantedRun(input: ExecutionRequestInput, deps: ExecutionDeps): Promise<ExecutionOutcome> {
  const { root, claim } = input;
  const now = input.now ?? new Date();
  const grant = await verifyGrantForRun(root, claim);
  if (!grant.ok) {
    return { state: 'refused', reason: grant.reason, detail: grant.detail, run: null };
  }
  const selection = await selectHarness(deps.declarations, deps.discovery, input.order);
  if (selection.selected === null) {
    return { state: 'refused', reason: 'no_eligible_harness', detail: describeNoCandidate(selection.skipped), run: null };
  }
  const context = await verifyCanonicalContext({ worktree: input.worktreePath, project: input.contextProject, target: input.target }, deps.context);
  if (!context.ok) {
    return { state: 'refused', reason: context.reason, detail: context.detail, run: null };
  }
  const harness = selection.selected;
  const run = await assignRun(root, { harness: harness.id, harnessVersion: harness.version ?? 'desconocida', links: { issue: claim.iid }, now });
  let lock;
  try {
    lock = await lockWorktree(root, input.worktreePath, run);
  } catch (error) {
    if (error instanceof LockHeldError) {
      await appendRunEvent(root, { ts: now.toISOString(), run, kind: 'end', reason_code: 'worktree_locked' });
      return { state: 'refused', reason: 'worktree_locked', detail: error.message, run };
    }
    throw error;
  }
  try {
    const consumed = await consumeGrant(root, claim, run);
    if (!consumed.ok) {
      await appendRunEvent(root, { ts: now.toISOString(), run, kind: 'end', reason_code: consumed.reason });
      return { state: 'refused', reason: consumed.reason, detail: consumed.detail, run };
    }
    await recordContext(root, run, context.identity, now);
    await index(root, run, { issue: claim.iid, state: 'running' });
    const issue = deps.runIssues ? await ensureRunIssue(deps.runIssues, run, { enabled: deps.runIssues.enabled, title: `Ejecución ${run}`, description: `Run ${run} de la issue #${claim.iid}` }) : null;
    let last: LaunchResult | null = null;
    const outcome = await runWithFallback(
      selection.eligible.map((item) => item.id),
      async (id) => {
        last = await deps.launch({ harness: id, run, cwd: input.worktreePath, env: harnessEnvironment(run), task: input.task });
        if (last.sessionId) {
          await index(root, run, { harness: id, session: last.sessionId });
        }
        return { harness: id, phase: last.phase, ok: last.ok, ...(last.reason ? { reason: last.reason } : {}) };
      },
    );
    const ts = new Date(now.getTime()).toISOString();
    if (outcome.kind === 'exhausted') {
      await index(root, run, { state: 'completed' });
      await appendRunEvent(root, { ts, run, kind: 'end', reason_code: 'no_harness_started' });
      return { state: 'exhausted', run, detail: outcome.tried.map((item) => `${item.harness} (${item.reason ?? item.phase})`).join('; ') };
    }
    if (outcome.kind === 'held') {
      // Fallo tras el arranque: efectos posibles. Se conserva el worktree y se reconcilia antes de reintentar.
      await index(root, run, { harness: outcome.harness, state: 'held' });
      await appendRunEvent(root, { ts, run, kind: 'end', reason_code: 'reconcile_required' });
      return { state: 'held', run, harness: outcome.harness, reason: 'reconcile_required' };
    }
    const result = last as LaunchResult | null;
    const closing = await bindClosing(root, run, result?.output ?? '', now);
    if (closing.accepted && deps.notes) {
      await postNoteOnce(deps.notes, claim.iid, run, `Ejecución ${run}: ${closing.status.state}${issue && issue.state !== 'disabled' ? ` (issue #${issue.iid})` : ''}`);
    }
    await index(root, run, { harness: outcome.harness, state: 'completed' });
    await appendRunEvent(root, { ts, run, kind: 'end', ...(closing.accepted ? { state: closing.status.state } : { reason_code: closing.reason }) });
    return { state: 'completed', run, harness: outcome.harness, accepted: closing.accepted, closing: closing.accepted ? closing.status.state : closing.reason };
  } finally {
    await lock.release();
  }
}

/** Marca un run retenido como reconciliado (la persona o el reconciliador revisó efectos locales y remotos). */
export async function markReconciled(root: string, run: string): Promise<void> {
  await index(root, run, { state: 'reconciled' });
}

export type ResumeOffer =
  | { offer: true; harness: string; args: string[] }
  | { offer: false; reason: 'unknown_run' | 'reconcile_first' | 'no_session' | 'not_resumable' };

/** 5.13: tras reconciliar, ofrece reanudar la sesión registrada si el harness declara sesiones reanudables. */
export async function resumeOffer(root: string, run: string, declarations: readonly HarnessDeclaration[]): Promise<ResumeOffer> {
  const entry = (await readState<RunIndex>(root, 'execution-index')).records[run];
  if (entry === undefined) {
    return { offer: false, reason: 'unknown_run' };
  }
  if (entry.state !== 'reconciled') {
    return { offer: false, reason: 'reconcile_first' };
  }
  if (!entry.session || !entry.harness) {
    return { offer: false, reason: 'no_session' };
  }
  const session = declarations.find((item) => item.id === entry.harness)?.session ?? null;
  if (session === null) {
    return { offer: false, reason: 'not_resumable' };
  }
  return { offer: true, harness: entry.harness, args: session.resumeArgs(entry.session) };
}

/**
 * Lanzador real: solo arranca un harness con ejecución sin interfaz declarada y verificada; sin ella el intento falla
 * antes del arranque (`resolve`) y no se lanza ningún proceso. Un timeout cancela el árbol completo y, como el proceso
 * ya arrancó en el proyecto, el fallo es incierto (se retiene para reconciliar).
 */
export function processLauncher(
  declarations: readonly HarnessDeclaration[],
  resolveBinary: (binary: string) => Promise<string | null>,
  timeoutMs: number,
): Launcher {
  return async ({ harness, cwd, env, task }) => {
    const declaration = declarations.find((item) => item.id === harness);
    if (!declaration || declaration.headless === null) {
      return { phase: 'resolve', ok: false, output: '', reason: 'ejecución sin interfaz no verificada' };
    }
    const binary = await resolveBinary(declaration.binary);
    if (binary === null) {
      return { phase: 'resolve', ok: false, output: '', reason: 'binario ausente' };
    }
    const { runHarnessProcess } = await import('./process.js');
    const result = await runHarnessProcess({ command: binary, args: declaration.headless.build(task), cwd, env, timeoutMs });
    if (!result.started) {
      return { phase: 'resolve', ok: false, output: '', reason: 'el binario no arrancó' };
    }
    const sessionId = declaration.session?.sessionId(result.tail) ?? null;
    if (result.timedOut || result.exitCode !== 0) {
      return { phase: 'task_delivered', ok: false, output: result.tail, sessionId, reason: result.timedOut ? 'timeout' : `salida ${result.exitCode}` };
    }
    return { phase: 'completed', ok: true, output: result.tail, sessionId };
  };
}
