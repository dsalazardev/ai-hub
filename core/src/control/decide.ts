import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import {
  controlSettings,
  decisionId,
  openDecisionsFor,
  readDecisions,
  recordDecision,
  recordStatus,
  type ControlSettings,
  type Decision,
  type DecisionKind,
  type EvidenceSource,
} from './ledger.js';
import { impactOf, type DecisionView, type EvidenceItem } from './render.js';
import { boardIssues, runTick, sealFor, type TickIssue, type TickProposal } from './tick.js';
import { GitlabTracker, defaultTrackerFetch, type TrackerFetch } from './tracker.js';

const SPEC_READY = 'ai::spec-ready';
const IN_SPEC = 'ai::in-spec';
const IN_DEV = 'ai::in-dev';

export interface DecideOptions {
  online?: boolean;
  labelsFrom?: string;
  issue?: number;
  /** Máximo de decisiones nuevas a publicar en esta ejecución (Discord: una por mensaje). */
  limit?: number;
  now?: Date;
  trackerFetch?: TrackerFetch;
  /** Rama del espejo para el sello (D3). */
  ref?: string;
  /** Tablero ya leído (ingest). */
  board?: { issues: TickIssue[]; unmapped: number[] };
}

export interface DecideResult {
  fresh: DecisionView[];
  settings: ControlSettings;
}

export class ControlConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlConfigError';
  }
}

export async function requireSettings(manifest: ProjectManifest): Promise<ControlSettings> {
  const settings = controlSettings(manifest);
  if (settings === null) {
    throw new ControlConfigError('el plano de control necesita manifest.control (aprobadores, ttlHours, expire)');
  }
  return settings;
}

interface Candidate {
  kind: DecisionKind;
  to: string;
  hash?: string;
  summary: string;
}

/** Qué decisión corresponde a una propuesta del tick (D0: la etiqueta y `human` vienen de `exit_effects`). */
export function candidateFor(proposal: TickProposal, sealValue: string | null, approvedHash: string | undefined): Candidate | null {
  const { current, proposed, latest } = proposal;
  if (proposed !== null && proposed !== current) {
    if (proposal.human) {
      return { kind: 'closing', to: proposed, summary: `el carril propone cerrar (${latest}); requiere confirmación humana` };
    }
    if (current === SPEC_READY && proposed === IN_DEV && proposal.seal === 'ok') {
      return { kind: 'preapproved', to: IN_DEV, summary: 'la spec aprobada sigue intacta; el desarrollo puede empezar' };
    }
    return { kind: 'transition', to: proposed, summary: `${proposal.reason}${proposal.rounds > 0 ? ` (ronda ${proposal.rounds})` : ''}` };
  }
  // §5: el arnés publica la spec sellada para que un humano la apruebe con su hash.
  if (current === IN_SPEC && sealValue !== null && approvedHash === undefined) {
    return { kind: 'spec-approval', to: SPEC_READY, hash: sealValue, summary: 'la spec está completa y sellada; falta la aprobación humana (§5)' };
  }
  return null;
}

function evidenceFor(proposal: TickProposal, candidate: Candidate, source: EvidenceSource, sealValue: string | null): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (proposal.latest !== null) {
    const where = proposal.sourceRef ? ` (${proposal.sourceRef})` : '';
    items.push(
      source === 'local'
        ? { text: `estado ${proposal.latest} registrado para ${proposal.feature}`, source: 'local (.ai-hub/runs, ai-hub control tick)' }
        : source === 'pipeline'
          ? { text: `estado ${proposal.latest} reportado por el motor y confirmado por CI${where}`, source: 'pipeline (verificado por CI, no por este host)' }
          : { text: `estado ${proposal.latest} reportado por el motor${where}`, source: 'remote: declarado por el motor, no verificado por el arnés' },
    );
  }
  if (candidate.kind === 'spec-approval' && sealValue !== null) {
    items.push({ text: `sello sha256 ${sealValue}`, source: `local (ai-hub gate --seal ${sealValue.slice(0, 8)}…)` });
  } else if (proposal.seal !== 'not-needed') {
    items.push({ text: `sello ${proposal.seal}: ${proposal.reason}`, source: 'local (ai-hub control tick)' });
  }
  if (proposal.rounds > 0) {
    items.push({ text: `rondas de converge: ${proposal.rounds}`, source: 'local (.ai-hub/runs)' });
  }
  return items;
}

/**
 * Calcula y publica (en el registro) las decisiones nuevas. Determinista e idempotente: una decisión ya
 * registrada no se vuelve a publicar; una nueva para la misma issue supersede a la abierta anterior.
 */
export async function runDecide(root: string, options: DecideOptions = {}): Promise<DecideResult> {
  const now = options.now ?? new Date();
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  let board = options.board;
  if (!board && options.online && options.labelsFrom === undefined) {
    board = await boardIssues(await GitlabTracker.fromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch));
  }
  const tick = await runTick(root, {
    ...(options.labelsFrom !== undefined ? { labelsFrom: options.labelsFrom } : {}),
    ...(options.issue !== undefined ? { issue: options.issue } : {}),
    ...(board ? { board } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
  });
  const issues = new Map((board?.issues ?? []).map((issue) => [issue.feature, issue]));
  const decisions = await readDecisions(root);
  const fresh: DecisionView[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (const proposal of tick.proposals) {
    if (proposal.iid === null || fresh.length >= limit) {
      continue;
    }
    const issue = issues.get(proposal.feature);
    const sealValue = await sealFor(root, proposal.feature, options.ref);
    const candidate = candidateFor(proposal, sealValue, issue?.approvedHash);
    if (candidate === null) {
      continue;
    }
    const source: EvidenceSource = proposal.source ?? 'local';
    const base = {
      kind: candidate.kind,
      iid: proposal.iid,
      from: proposal.current,
      to: candidate.to,
      state: proposal.latest,
      source,
      seal: sealValue,
    };
    const id = decisionId(base);
    if (decisions.has(id)) {
      continue;
    }
    for (const open of openDecisionsFor(decisions, proposal.iid)) {
      await recordStatus(root, open.id, 'superseded', now, { reason: 'new_decision' });
    }
    const decision: Decision = {
      id,
      ...base,
      feature: proposal.feature,
      hash: candidate.hash ?? id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + settings.ttlHours * 3_600_000).toISOString(),
      status: candidate.kind === 'preapproved' ? 'approved' : 'pending',
      updatedAt: now.toISOString(),
    };
    await recordDecision(root, {
      id: decision.id,
      kind: decision.kind,
      iid: decision.iid,
      feature: decision.feature,
      from: decision.from,
      to: decision.to,
      state: decision.state,
      source: decision.source,
      seal: decision.seal,
      hash: decision.hash,
      createdAt: decision.createdAt,
      expiresAt: decision.expiresAt,
      status: decision.status,
    });
    decisions.set(id, decision);
    fresh.push({
      decision,
      title: issue?.title ?? proposal.feature,
      summary: candidate.summary,
      impact: impactOf(candidate.to),
      evidence: evidenceFor(proposal, candidate, source, sealValue),
    });
  }
  return { fresh, settings };
}
