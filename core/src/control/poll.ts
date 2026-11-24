import { loadManifestContext } from '../manifest/manifest.js';
import { reconcileDeliveries } from '../delivery/reconcile.js';
import { appendRunEvent } from '../harness/runs.js';
import { applyPreapproved, expireDecisions } from './apply.js';
import { requireSettings, runDecide } from './decide.js';
import { CIRCUIT_THRESHOLD, claimCorruptNotice, readHealth, updateHealth, type PollHealth } from './health.js';
import { renderDiscord } from './render.js';
import { boardIssues } from './tick.js';
import { defaultTrackerFetch, trackerFromHarness, TrackerError, type TrackerFetch } from './tracker.js';

/**
 * `ai-hub control poll` (R-009–R-011): una ejecución del cron con tres fases separadas.
 *   1. Lectura: tablero del tracker (los GET reintentan dentro del cliente; un reintento que acaba bien no es fallo).
 *   2. Decisión: publicación en el registro a partir del tablero ya leído, sin volver a leer.
 *   3. Escritura: `apply --preapproved` y `expire`, cada uno una sola vez por ejecución y nunca reintentados.
 * Avisa en el primer fallo de una caída y una vez al recuperarse; entre medias calla. Un poll sano sin nada que
 * decir no imprime nada y sale 0. Tras CIRCUIT_THRESHOLD fallos abre el circuito: pausa el job configurado solo si
 * hay una sonda independiente instalada; sin sonda no pausa (los comandos manuales van en el primer aviso).
 */

export const POLL_RUN = 'control-poll';
export const PROBE_SUFFIX = '-probe';

/** Lo que el poll necesita del host de Hermes; `null` cuando no se puede consultar. */
export interface PollHost {
  /** Nombres de los jobs de cron del perfil, o null si no se pueden listar. */
  cronJobs(): Promise<string[] | null>;
  pause(job: string): Promise<boolean>;
  resume(job: string): Promise<boolean>;
  /** Evidencia documentada de que el gateway está arrancando (`gateway_state.json`), nunca inventada. */
  gatewayStarting(): Promise<boolean>;
}

export interface PollOptions {
  now?: Date;
  trackerFetch?: TrackerFetch;
  host?: PollHost | null;
  /** Solo lectura y salud: nunca decide, aplica ni caduca (la sonda del circuito). */
  probe?: boolean;
}

export interface PollOutcome {
  code: number;
  lines: string[];
}

function manualCommands(job: string): string {
  return `si la caída persiste, pausa el poll con «hermes -p hermes-control cron pause ${job}» y reanúdalo con «hermes -p hermes-control cron resume ${job}»`;
}

async function telemetry(root: string, now: Date, durationMs: number, failure: TrackerError | null): Promise<void> {
  // Evidencia del poll (R-043): clase, estado HTTP y duración; nunca cuerpos ni mensajes con contenido.
  await appendRunEvent(root, {
    ts: now.toISOString(),
    run: POLL_RUN,
    kind: 'note',
    note_type: 'health',
    duration_ms: Math.max(0, Math.round(durationMs)),
    // `config` no es una clase de la telemetría: se registra como `unknown`.
    ...(failure !== null ? { failure_class: failure.failureClass === 'config' ? ('unknown' as const) : failure.failureClass, ...(failure.status !== null ? { http_status: failure.status } : {}) } : {}),
  }).catch(() => undefined);
}

export async function runPoll(root: string, options: PollOptions = {}): Promise<PollOutcome> {
  const now = options.now ?? new Date();
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  const project = manifest.project.id;
  const job = settings.pollJob;
  const host = options.host ?? null;

  // Estado ilegible o más nuevo: se conserva, se informa una vez y no se actúa (ni circuito ni decisiones).
  const health = await readHealth(root);
  if (health.kind === 'corrupt' || health.kind === 'newer') {
    const first = await claimCorruptNotice(root, health.fingerprint);
    const what = health.kind === 'corrupt' ? 'health_corrupt: el estado de salud no es legible' : `state_version_newer: el estado de salud es de la versión ${health.version}`;
    return {
      code: 1,
      lines: first ? [`[ai-hub] poll detenido: ${what}; se conserva sin tocar y no se decide nada hasta recuperarlo con «ai-hub control poll --reset-health»`] : [],
    };
  }

  // Arranque del gateway con evidencia documentada: no es una caída del tracker.
  if (host !== null && (await host.gatewayStarting())) {
    return { code: 0, lines: [] };
  }

  const started = Date.now();
  const tracker = await trackerFromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch);
  let board: Awaited<ReturnType<typeof boardIssues>>;
  try {
    board = await boardIssues(tracker);
  } catch (error) {
    if (!(error instanceof TrackerError)) {
      throw error;
    }
    await telemetry(root, now, Date.now() - started, error);
    return failure(root, project, job, now, error, host, settings.pollMinutes * 60_000);
  }
  await telemetry(root, now, Date.now() - started, null);
  const recovered = await success(root, project, job, now, host);
  if (options.probe) {
    return { code: 0, lines: recovered };
  }

  const lines: string[] = [...recovered];
  // R-076 (4.67): cada poll reconcilia las entregas (idempotente); un merge con el host apagado se limpia al volver.
  if (manifest.delivery !== undefined) {
    lines.push(...(await reconcileDeliveries(root, tracker)));
  }
  // Escritura: una sola vez cada paso; su fallo no se reintenta en esta ejecución.
  let message: string[] = [];
  for (const step of [() => applyPreapproved(root, { now, ...(options.trackerFetch ? { trackerFetch: options.trackerFetch } : {}) }), () => expireDecisions(root, { now, ...(options.trackerFetch ? { trackerFetch: options.trackerFetch } : {}) })]) {
    if (message.length > 0) {
      break;
    }
    try {
      message = (await step()).lines;
    } catch (error) {
      if (!(error instanceof TrackerError)) {
        throw error;
      }
      message = [`[ai-hub] poll: un paso de escritura falló (${error.failureClass}); no se reintenta en esta ejecución`];
    }
  }
  if (message.length === 0) {
    // Decisión a partir del tablero ya leído (sin una segunda lectura).
    const { fresh, barrier } = await runDecide(root, { board, now, limit: 1 });
    if (fresh.length > 0) {
      message = [renderDiscord(fresh[0], settings.expire)];
    } else if (barrier !== null) {
      message = [`[ai-hub] registro de decisiones detenido: ${barrier}`];
    }
  }
  lines.push(...message);
  return { code: 0, lines };
}

async function success(root: string, project: string, job: string, now: Date, host: PollHost | null): Promise<string[]> {
  let previous: PollHealth | null = null;
  await updateHealth(root, project, job, (health) => {
    previous = health;
    return { ...health, phase: 'closed', failures: 0, failureClass: null, lastSuccessAt: now.toISOString(), nextProbeAt: null, notified: false };
  });
  const before = previous as PollHealth | null;
  if (before === null || !before.notified) {
    return [];
  }
  // Solo se reanuda lo que este poll pausó (marcado con la próxima sonda).
  const resumed = before.nextProbeAt !== null && host !== null ? await host.resume(job) : false;
  return [`[ai-hub] poll: el tracker responde de nuevo tras ${before.failures} fallo(s)${before.lastFailureAt ? ` (el último a las ${before.lastFailureAt})` : ''}${resumed ? `; ${job} reanudado` : ''}`];
}

async function failure(root: string, project: string, job: string, now: Date, error: TrackerError, host: PollHost | null, probeDelayMs: number): Promise<PollOutcome> {
  let next: PollHealth | null = null;
  let firstOfOutage = false;
  await updateHealth(root, project, job, (health) => {
    firstOfOutage = !health.notified;
    const failures = health.failures + 1;
    next = {
      ...health,
      failures,
      failureClass: error.failureClass,
      lastFailureAt: now.toISOString(),
      notified: true,
      phase: failures >= CIRCUIT_THRESHOLD ? 'open' : health.phase,
    };
    return next;
  });
  const after = next as unknown as PollHealth;
  const lines: string[] = [];
  if (firstOfOutage) {
    lines.push(`[ai-hub] poll: el tracker falla (${error.failureClass}${error.status !== null ? `, HTTP ${error.status}` : ''}); se avisará al recuperarse. ${manualCommands(job)}`);
  }
  // Circuito: solo con sonda independiente instalada se pausa el job configurado; la sonda lo reanuda.
  if (after.failures === CIRCUIT_THRESHOLD && host !== null) {
    const jobs = await host.cronJobs();
    if (jobs !== null && jobs.includes(`${job}${PROBE_SUFFIX}`) && (await host.pause(job))) {
      await updateHealth(root, project, job, (health) => ({ ...health, nextProbeAt: new Date(now.getTime() + probeDelayMs).toISOString() }));
    }
  }
  return { code: 1, lines };
}
