import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEngine, type EngineManifest } from '../engine/engine.js';
import { readFeatures } from '../cli/gate.js';
import { featureSeal } from '../speckit/seal.js';
import { listRuns, readRunEvents, type RunEvent } from '../harness/runs.js';
import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import { readHarnessEnv } from '../env/dotenv.js';
import { flagString } from '../cli/args.js';
import type { FetchLike } from '../env/doctor.js';
import type { CliContext, ParsedArgs } from '../cli/types.js';

/**
 * Plano de control en modo observación (F-04 fase a): calcula y PROPONE transiciones de etiqueta
 * según `exit_effects`. Jamás escribe archivos, mueve etiquetas, comenta ni lanza agentes; aplicar
 * es de hermes-control. Nunca propone `ai::spec-ready`: esa puerta es humana (§5).
 */
export const DEFAULT_MAX_ROUNDS = 3;
const HUMAN_ONLY_LABEL = 'ai::spec-ready';

export interface TickIssue {
  feature: string;
  iid?: number;
  labels: string[];
  /** Hash aprobado por el humano (§5); lo publica el publisher, no el tick. */
  approvedHash?: string;
}

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
}

export interface TickResult {
  proposals: TickProposal[];
  pendingHuman: Array<{ kind: 'awaiting-ok' | 'closing'; ref: string }>;
}

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
    if (human) {
      pendingHuman.push({ kind: 'closing', ref: `${feature} → ${proposed ?? '-'} (${latest})` });
    }
    const report = (input.reports ?? []).includes(feature);
    proposals.push({ feature, iid: issue?.iid ?? null, current, latest, proposed, reason, seal, rounds, human, report });
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
}

export async function runTick(root: string, options: TickOptions): Promise<TickResult> {
  const engine = await loadEngine();
  const manifest = (await loadManifestContext(root)).manifest;
  const features = (await readFeatures(root)).map((feature) => feature.name);
  let issues: TickIssue[] = [];
  if (options.labelsFrom !== undefined) {
    issues = parseIssues(JSON.parse(await fs.readFile(path.resolve(root, options.labelsFrom), 'utf8')));
  }
  if (options.issue !== undefined) {
    issues = issues.filter((item) => item.iid === options.issue);
  }
  if (options.online) {
    issues = await onlineLabels(root, manifest, issues, options.fetch ?? ((target, init) => fetch(target, init)));
  }
  const selected = options.issue !== undefined ? features.filter((feature) => issues.some((item) => item.feature === feature)) : features;
  const seals: Record<string, string | null> = {};
  for (const feature of selected) {
    seals[feature] = await featureSeal(root, `specs/${feature}`).catch(() => null);
  }
  const engineLimit = engine.loop?.converge?.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const maxRounds = Math.min(engineLimit, manifest.policy.maxRounds ?? engineLimit);
  const reports: string[] = [];
  for (const feature of selected) {
    if (await fs.access(path.join(root, '.ai-hub', 'work', feature, 'report.md')).then(() => true, () => false)) {
      reports.push(feature);
    }
  }
  return computeTick(engine, { features: selected, issues, seals, maxRounds, reports, ...(await collectRunsInput(root)) });
}

const USAGE = 'Uso: ai-hub control tick --dry-run [--json] [--issue <iid>] [--labels-from <archivo>] [--online]';

export async function cmdControl(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  if (sub !== 'tick') {
    ctx.io.err(USAGE);
    return 2;
  }
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
  return 0;
}
