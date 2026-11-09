import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEngine, type EngineManifest } from '../engine/engine.js';
import { readFeatures } from '../cli/gate.js';
import { featureSeal, featureSealAtRef } from '../speckit/seal.js';
import { lastStatusLine, statusContract } from '../speckit/status.js';
import { listRuns, readRunEvents, type RunEvent } from '../harness/runs.js';
import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import { readHarnessEnv } from '../env/dotenv.js';
import { flagString } from '../cli/args.js';
import type { FetchLike } from '../env/doctor.js';
import { GitlabTracker, defaultTrackerFetch, type TrackerFetch } from './tracker.js';
import type { CliContext, ParsedArgs } from '../cli/types.js';

/**
 * Plano de control en modo observación (F-04 fase a): calcula y PROPONE transiciones de etiqueta
 * según `exit_effects`. Jamás escribe archivos, mueve etiquetas, comenta ni lanza agentes; aplicar
 * es de hermes-control. Nunca propone `ai::spec-ready`: esa puerta es humana (§5).
 */
export const DEFAULT_MAX_ROUNDS = 3;
const HUMAN_ONLY_LABEL = 'ai::spec-ready';
const DONE_LABEL = 'ai::done';

export interface TickIssue {
  feature: string;
  iid?: number;
  labels: string[];
  /** Hash aprobado por el humano (§5); lo publica el publisher, no el tick. */
  approvedHash?: string;
  /** Título de la issue (solo en el modo que lista el tablero). */
  title?: string;
  /** Último estado válido publicado por un motor en una nota de la issue o de su MR (evidencia remota). */
  remote?: { state: string; source: EvidenceRank; ref: string };
}

/** Rango de la evidencia: verificada en este host, verificada por CI, o solo declarada por el motor. */
export type EvidenceRank = 'local' | 'pipeline' | 'remote';

export interface TickInput {
  features: string[];
  issues: TickIssue[];
  /** Último estado registrado por feature (desde `.ai-hub/runs`). */
  latest: Record<string, string>;
  rounds: Record<string, number>;
  seals: Record<string, string | null>;
  awaitingOk: Array<{ run: string; step?: string }>;
  maxRounds: number;
  reports?: string[];
  /** Rango de la evidencia por feature (solo al listar el tablero; sin él, la salida es la de 0.11.0). */
  sources?: Record<string, { rank: EvidenceRank; ref?: string }>;
}

export interface TickProposal {
  feature: string;
  iid: number | null;
  current: string | null;
  latest: string | null;
  proposed: string | null;
  reason: string;
  seal: 'ok' | 'mismatch' | 'missing' | 'not-needed';
  rounds: number;
  /** `true` cuando la propuesta exige confirmación humana (KILL/INVALID, cierres). */
  human: boolean;
  /** Informe del narrador ya guardado en `.ai-hub/work/<feature>/report.md` (el tick solo lo enumera). */
  report: boolean;
  /** Rango de la evidencia del estado (solo al listar el tablero). */
  source?: EvidenceRank;
  /** De dónde sale la evidencia remota (nota de la issue o del MR). */
  sourceRef?: string;
}

export interface TickResult {
  proposals: TickProposal[];
  pendingHuman: Array<{ kind: 'awaiting-ok' | 'closing'; ref: string }>;
  /** Issues del tablero sin el marcador `ai-hub:feature=` (solo al listar el tablero con `--online`). */
  unmapped?: number[];
}

/** Marcador que liga una issue a su feature; solo en la descripción. */
export const FEATURE_MARKER = /ai-hub:feature=(\d{3}-[a-z0-9][a-z0-9-]*)/;
/** Nota del plano de control con el hash aprobado (§5). */
export const APPROVED_HASH_MARKER = /ai-hub:approved-hash=([a-f0-9]{64})/;

function labelOf(engine: EngineManifest, labels: string[]): string | null {
  return labels.find((label) => engine.labels.includes(label)) ?? null;
}

/** Interpreta el efecto de `exit_effects`: etiqueta propuesta y si necesita confirmación humana. */
export function effectFor(engine: EngineManifest, state: string, current: string | null): { label: string | null; human: boolean } {
  const effect = engine.exit_effects[state] ?? '';
  if (/^propone\s+ai::/.test(effect)) {
    return { label: /ai::[a-z-]+/.exec(effect)?.[0] ?? null, human: true };
  }
  if (/^(mantiene|sin cambio)/.test(effect)) {
    return { label: current, human: false };
  }
  return { label: /ai::[a-z-]+/.exec(effect)?.[0] ?? current, human: false };
}

/** Núcleo puro del tick: mismas entradas, mismas propuestas; sin E/S. */
export function computeTick(engine: EngineManifest, input: TickInput): TickResult {
  const proposals: TickProposal[] = [];
  const pendingHuman: TickResult['pendingHuman'] = input.awaitingOk.map((item) => ({
    kind: 'awaiting-ok' as const,
    ref: item.step ? `${item.run} · ${item.step}` : item.run,
  }));
  for (const feature of input.features) {
    const issue = input.issues.find((item) => item.feature === feature);
    const current = issue ? labelOf(engine, issue.labels) : null;
    const latest = input.latest[feature] ?? null;
    const rounds = input.rounds[feature] ?? 0;
    let proposed: string | null = current;
    let reason = latest === null ? 'sin estado registrado' : `estado ${latest}`;
    let human = false;
    let seal: TickProposal['seal'] = 'not-needed';
    if (latest !== null) {
      const effect = effectFor(engine, latest, current);
      proposed = effect.label;
      human = effect.human;
      if (latest === 'NEEDS_WORK' && rounds >= input.maxRounds) {
        proposed = 'ai::blocked';
        reason = `max_rounds (${rounds}/${input.maxRounds})`;
        human = false;
      }
    }
    // §5: la transición a desarrollo exige un hash aprobado que coincida con el sello actual.
    const toDev = proposed === 'ai::in-dev' && current !== 'ai::in-dev';
    const approvedDev = current === HUMAN_ONLY_LABEL && issue?.approvedHash !== undefined;
    if (toDev || approvedDev) {
      const actual = input.seals[feature] ?? null;
      if (issue?.approvedHash === undefined || actual === null) {
        seal = 'missing';
        proposed = 'ai::blocked';
        reason = actual === null ? 'la feature no se puede sellar (faltan artefactos)' : 'sin hash aprobado por un humano';
      } else if (issue.approvedHash !== actual) {
        seal = 'mismatch';
        proposed = 'ai::blocked';
        reason = 'el sello no coincide con el hash aprobado (fail-closed)';
      } else {
        seal = 'ok';
        proposed = 'ai::in-dev';
        reason = 'sello revalidado contra el hash aprobado';
      }
    }
    if (proposed === HUMAN_ONLY_LABEL) {
      proposed = current;
      reason = `${reason}; ai::spec-ready solo lo aprueba un humano`;
    }
    const source = input.sources?.[feature];
    if (proposed === DONE_LABEL && proposed !== current && source?.rank === 'remote') {
      // Una línea de estado de un comentario es una declaración del motor, no una verificación.
      proposed = current;
      human = false;
      reason = `estado ${latest} declarado por el motor (remoto); ${DONE_LABEL} exige el gate local o el pipeline verde del MR`;
    }
    if (human) {
      pendingHuman.push({ kind: 'closing', ref: `${feature} → ${proposed ?? '-'} (${latest})` });
    }
    const report = (input.reports ?? []).includes(feature);
    proposals.push({
      feature,
      iid: issue?.iid ?? null,
      current,
      latest,
      proposed,
      reason,
      seal,
      rounds,
      human,
      report,
      ...(source ? { source: source.rank, ...(source.ref ? { sourceRef: source.ref } : {}) } : {}),
    });
  }
  return { proposals, pendingHuman };
}

/** Feature a la que pertenece un evento: por su artefacto (`specs/<f>/…` o `.ai-hub/work/<f>/…`). */
export function featureOf(event: RunEvent): string | null {
  const artifact = event.artifact ?? '';
  return /^(?:specs|\.ai-hub\/work)\/([^/]+)\//.exec(artifact)?.[1] ?? null;
}

export async function collectRunsInput(root: string): Promise<Pick<TickInput, 'latest' | 'rounds' | 'awaitingOk'>> {
  const latest: Record<string, string> = {};
  const rounds: Record<string, number> = {};
  const awaitingOk: TickInput['awaitingOk'] = [];
  for (const run of await listRuns(root)) {
    for (const event of await readRunEvents(root, run)) {
      if (event.kind === 'note' && event.note_type === 'awaiting-ok') {
        awaitingOk.push({ run, ...(event.step ? { step: event.step } : {}) });
      }
      const feature = featureOf(event);
      if (feature === null || event.state === undefined) {
        continue;
      }
      latest[feature] = event.state;
      if (event.state === 'NEEDS_WORK') {
        rounds[feature] = (rounds[feature] ?? 0) + 1;
      }
    }
  }
  return { latest, rounds, awaitingOk };
}

function parseIssues(raw: unknown): TickIssue[] {
  if (!Array.isArray(raw)) {
    throw new Error('--labels-from debe contener una lista [{feature, iid?, labels, approvedHash?}]');
  }
  return raw.map((item, index) => {
    const data = item as Record<string, unknown>;
    if (typeof data.feature !== 'string' || !Array.isArray(data.labels) || !data.labels.every((label) => typeof label === 'string')) {
      throw new Error(`--labels-from: la entrada ${index} necesita feature (texto) y labels (lista de textos)`);
    }
    return {
      feature: data.feature,
      labels: data.labels as string[],
      ...(typeof data.iid === 'number' ? { iid: data.iid } : {}),
      ...(typeof data.approvedHash === 'string' ? { approvedHash: data.approvedHash } : {}),
    };
  });
}

/** Lectura online de etiquetas (solo GET); nunca imprime credenciales. */
async function onlineLabels(root: string, manifest: ProjectManifest, issues: TickIssue[], doFetch: FetchLike): Promise<TickIssue[]> {
  const tracker = manifest.tracker;
  if (!tracker) {
    throw new Error('--online necesita manifest.tracker');
  }
  const env = (await readHarnessEnv(root)) ?? {};
  const url = env[tracker.urlEnv];
  const token = env[tracker.tokenEnv];
  const project = env.GITLAB_PROJECT_PATH;
  if (!url || !token || !project) {
    throw new Error(`--online necesita ${tracker.urlEnv}, ${tracker.tokenEnv} y GITLAB_PROJECT_PATH en .ai-hub/.env`);
  }
  const result: TickIssue[] = [];
  for (const issue of issues) {
    if (issue.iid === undefined) {
      result.push(issue);
      continue;
    }
    const response = await doFetch(`${url.replace(/\/+$/, '')}/api/v4/projects/${project}/issues/${issue.iid}`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      throw new Error(`el tracker respondió HTTP ${response.status} para la issue ${issue.iid}`);
    }
    const body = (await response.json()) as { labels?: unknown };
    const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
    result.push({ ...issue, labels });
  }
  return result;
}

export interface TickOptions {
  labelsFrom?: string;
  issue?: number;
  online?: boolean;
  fetch?: FetchLike;
  /** Cliente del tracker para listar el tablero (`--online` sin `--labels-from`). */
  trackerFetch?: TrackerFetch;
  /** Tablero ya leído por quien llama (decide, ingest): evita una segunda lectura. */
  board?: { issues: TickIssue[]; unmapped: number[] };
  /** Rama o commit del espejo del que leer los artefactos para el sello (D3); sin ella, el árbol de trabajo. */
  ref?: string;
}

/** Sello de una feature desde el árbol de trabajo o, con `ref`, desde esa rama del espejo. */
export async function sealFor(root: string, feature: string, ref?: string): Promise<string | null> {
  const dir = `specs/${feature}`;
  return (ref ? featureSealAtRef(root, ref, dir) : featureSeal(root, dir)).catch(() => null);
}

/**
 * Tablero desde el tracker (solo GET): issues abiertas con etiqueta `ai::`, mapeadas por el marcador de la
 * descripción; el hash aprobado sale solo de la última nota del propio plano de control con su marcador.
 */
export async function boardIssues(tracker: GitlabTracker): Promise<{ issues: TickIssue[]; unmapped: number[] }> {
  const issues: TickIssue[] = [];
  const unmapped: number[] = [];
  const botId = await tracker.currentUserId();
  const contract = statusContract(await loadEngine());
  for (const issue of await tracker.labelledIssues()) {
    const feature = FEATURE_MARKER.exec(issue.description)?.[1];
    if (!feature) {
      unmapped.push(issue.iid);
      continue;
    }
    let approvedHash: string | undefined;
    // Evidencia remota: la última nota (id mayor) de la issue o de sus MR que termina en una línea válida.
    let remote: { id: number; state: string; ref: string; mr: number | null } | null = null;
    const consider = (id: number, body: string, ref: string, mr: number | null): void => {
      const status = lastStatusLine(body, contract);
      if (status !== null && (remote === null || id > remote.id)) {
        remote = { id, state: status.state, ref, mr };
      }
    };
    for (const note of await tracker.issueNotes(issue.iid)) {
      const hash = APPROVED_HASH_MARKER.exec(note.body)?.[1];
      if (hash && botId !== null && note.authorId === botId) {
        approvedHash = hash;
      }
      consider(note.id, note.body, `nota de la issue #${issue.iid}`, null);
    }
    const mergeRequests = await tracker.relatedMergeRequests(issue.iid);
    for (const mr of mergeRequests) {
      for (const note of await tracker.mergeRequestNotes(mr.iid)) {
        consider(note.id, note.body, `nota del MR !${mr.iid}`, mr.iid);
      }
    }
    let evidence: TickIssue['remote'];
    const found = remote as { id: number; state: string; ref: string; mr: number | null } | null;
    if (found !== null) {
      evidence = { state: found.state, source: 'remote', ref: found.ref };
      // Un VERIFIED remoto solo sube de rango con el pipeline verde de un MR de la issue.
      for (const mr of found.state === 'VERIFIED' ? mergeRequests : []) {
        if ((await tracker.latestPipelineStatus(mr.iid)) === 'success') {
          evidence = { state: found.state, source: 'pipeline', ref: `pipeline del MR !${mr.iid}: success` };
          break;
        }
      }
    }
    issues.push({
      feature,
      iid: issue.iid,
      labels: issue.labels,
      title: issue.title,
      ...(approvedHash ? { approvedHash } : {}),
      ...(evidence ? { remote: evidence } : {}),
    });
  }
  return { issues, unmapped };
}

export async function runTick(root: string, options: TickOptions): Promise<TickResult> {
  const engine = await loadEngine();
  const manifest = (await loadManifestContext(root)).manifest;
  const features = (await readFeatures(root)).map((feature) => feature.name);
  let issues: TickIssue[] = [];
  let unmapped: number[] | undefined;
  if (options.labelsFrom !== undefined) {
    issues = parseIssues(JSON.parse(await fs.readFile(path.resolve(root, options.labelsFrom), 'utf8')));
  } else if (options.board) {
    issues = options.board.issues;
    unmapped = options.board.unmapped;
  } else if (options.online) {
    const board = await boardIssues(await GitlabTracker.fromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch));
    issues = board.issues;
    unmapped = board.unmapped;
  }
  if (options.issue !== undefined) {
    issues = issues.filter((item) => item.iid === options.issue);
  }
  if (options.online && options.labelsFrom !== undefined && !options.board) {
    issues = await onlineLabels(root, manifest, issues, options.fetch ?? ((target, init) => fetch(target, init)));
  }
  const selected = options.issue !== undefined ? features.filter((feature) => issues.some((item) => item.feature === feature)) : features;
  const seals: Record<string, string | null> = {};
  for (const feature of selected) {
    seals[feature] = await sealFor(root, feature, options.ref);
  }
  const engineLimit = engine.loop?.converge?.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const maxRounds = Math.min(engineLimit, manifest.policy.maxRounds ?? engineLimit);
  const reports: string[] = [];
  for (const feature of selected) {
    if (await fs.access(path.join(root, '.ai-hub', 'work', feature, 'report.md')).then(() => true, () => false)) {
      reports.push(feature);
    }
  }
  const runs = await collectRunsInput(root);
  if (unmapped === undefined) {
    // Modos de 0.11.0 (archivo de etiquetas o sin tracker): solo runs locales, salida intacta.
    return computeTick(engine, { features: selected, issues, seals, maxRounds, reports, ...runs });
  }
  // Tablero: un run local manda; si no hay, la línea de estado del motor cuenta con su rango (remota o pipeline).
  const latest = { ...runs.latest };
  const sources: NonNullable<TickInput['sources']> = {};
  for (const feature of selected) {
    const remote = issues.find((item) => item.feature === feature)?.remote;
    if (runs.latest[feature] !== undefined) {
      sources[feature] = { rank: 'local' };
    } else if (remote) {
      latest[feature] = remote.state;
      sources[feature] = { rank: remote.source, ref: remote.ref };
    }
  }
  const result = computeTick(engine, { features: selected, issues, seals, maxRounds, reports, ...runs, latest, sources });
  return { ...result, unmapped };
}

const USAGE = 'Uso: ai-hub control tick --dry-run [--json] [--issue <iid>] [--labels-from <archivo>] [--online] [--ref <rama>]';

export const TICK_USAGE = USAGE;

/** `ai-hub control tick`: salida y códigos de 0.11.0; el modo que lista el tablero añade las no mapeadas. */
export async function cmdTick(args: ParsedArgs, ctx: CliContext): Promise<number> {
  if (!args.flags['dry-run']) {
    ctx.io.err('control tick solo propone (--dry-run): aplicar etiquetas, comentar o lanzar agentes es de hermes-control');
    return 2;
  }
  const issueRaw = flagString(args, 'issue');
  if (issueRaw !== null && !/^\d+$/.test(issueRaw)) {
    ctx.io.err('--issue debe ser un número de issue');
    return 2;
  }
  let result: TickResult;
  try {
    result = await runTick(ctx.root, {
      labelsFrom: flagString(args, 'labels-from') ?? undefined,
      issue: issueRaw === null ? undefined : Number.parseInt(issueRaw, 10),
      online: Boolean(args.flags.online),
      ...(flagString(args, 'ref') !== null ? { ref: flagString(args, 'ref') ?? undefined } : {}),
    });
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  if (args.flags.json) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  ctx.io.out(`control tick (dry-run): ${result.proposals.length} feature(s); no se escribió ni movió nada`);
  for (const item of result.proposals) {
    ctx.io.out(
      `  ${item.feature}${item.iid !== null ? ` #${item.iid}` : ''}: ${item.current ?? '-'} → ${item.proposed ?? '-'} · ${item.reason} · sello ${item.seal} · rondas ${item.rounds}${item.human ? ' · requiere humano' : ''}${item.report ? ' · informe del narrador listo' : ''}`,
    );
  }
  ctx.io.out(`pendientes de OK humano: ${result.pendingHuman.length}`);
  for (const item of result.pendingHuman) {
    ctx.io.out(`  [${item.kind}] ${item.ref}`);
  }
  if (result.unmapped !== undefined) {
    ctx.io.out(`issues sin marcador ai-hub:feature=: ${result.unmapped.length === 0 ? '0' : result.unmapped.map((iid) => `#${iid}`).join(', ')}`);
  }
  return 0;
}
