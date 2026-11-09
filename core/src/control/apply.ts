import { loadEngine } from '../engine/engine.js';
import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import { ControlConfigError, requireSettings } from './decide.js';
import {
  OPEN_STATUSES,
  readDecisions,
  recordStatus,
  type ControlSettings,
  type Decision,
} from './ledger.js';
import { impactOf, renderDetail } from './render.js';
import { parseReply } from './reply.js';
import { APPROVED_HASH_MARKER, sealFor } from './tick.js';
import { GitlabTracker, defaultTrackerFetch, type TrackerFetch } from './tracker.js';

/**
 * `ai-hub control apply`: aplica una decisión solo con una aprobación humana válida (o preaprobada por el
 * hash de §5) y tras revalidar contra el tracker: etiqueta actual (CAS), WIP y sello. Escribe solo la
 * etiqueta (un PUT que añade el destino y retira los demás `ai::`) y las notas del plano de control.
 */
const IN_DEV = 'ai::in-dev';
const BLOCKED = 'ai::blocked';

export interface ApplyOptions {
  trackerFetch?: TrackerFetch;
  now?: Date;
  /** Rama del espejo para revalidar el sello (D3). */
  ref?: string;
}

export interface ApplyOutcome {
  code: number;
  /** Texto para el humano (Discord o terminal); nunca credenciales. */
  lines: string[];
}

export const DECISION_MARKER = (id: string): string => `ai-hub:decision=${id}`;

interface Context {
  root: string;
  manifest: ProjectManifest;
  settings: ControlSettings;
  tracker: GitlabTracker;
  now: Date;
  ref?: string;
}

async function context(root: string, options: ApplyOptions): Promise<Context> {
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  const tracker = await GitlabTracker.fromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch);
  return { root, manifest, settings, tracker, now: options.now ?? new Date(), ...(options.ref ? { ref: options.ref } : {}) };
}

function aiLabel(labels: string[]): string | null {
  return labels.find((label) => label.startsWith('ai::')) ?? null;
}

/** Hash aprobado de una issue: solo de notas del propio plano de control (mismo criterio que el tick). */
async function approvedHash(ctx: Context, iid: number): Promise<string | null> {
  const botId = await ctx.tracker.currentUserId();
  let hash: string | null = null;
  for (const note of await ctx.tracker.issueNotes(iid)) {
    const found = APPROVED_HASH_MARKER.exec(note.body)?.[1];
    if (found && botId !== null && note.authorId === botId) {
      hash = found;
    }
  }
  return hash;
}

async function wipLimit(manifest: ProjectManifest): Promise<number> {
  const engine = await loadEngine();
  return Math.min(engine.policy_limits.wip, manifest.policy.wip ?? engine.policy_limits.wip);
}

function noteBody(decision: Decision, extra: string[], approver: string | undefined): string {
  return [
    `**ai-hub control** · ${decision.from ?? '-'} → ${decision.to} · decisión \`${decision.id.slice(0, 8)}\``,
    approver ? `Aprobada por <@${approver}> en Discord.` : 'Aplicada por el plano de control.',
    ...extra,
    '',
    `<!-- ${DECISION_MARKER(decision.id)} -->`,
  ].join('\n');
}

/** Evidencia de la nota: estado, fuente y hash de la decisión, más lo revalidado al aplicar. */
function evidenceLines(decision: Decision, extra: string[]): string[] {
  return [
    `Estado: \`${decision.state ?? '-'}\` · fuente: ${decision.source} · hash de la decisión: \`${decision.hash.slice(0, 12)}…\``,
    ...extra,
  ];
}

/** Publica la nota de la decisión una sola vez: si ya existe una con su marcador, no repite. */
export async function postDecisionNote(ctx: Context, decision: Decision, extra: string[], approver?: string): Promise<void> {
  const marker = DECISION_MARKER(decision.id);
  const existing = await ctx.tracker.issueNotes(decision.iid);
  if (existing.some((note) => note.body.includes(marker))) {
    return;
  }
  await ctx.tracker.postIssueNote(decision.iid, noteBody(decision, extra, approver));
}

/**
 * Revalida y ejecuta una decisión. Ningún error deja una escritura parcial reportada como éxito: si el PUT
 * falla, la decisión sigue abierta; si la nota falla tras el PUT, un reintento la publica una sola vez.
 */
async function execute(ctx: Context, decision: Decision, approver: string | undefined): Promise<ApplyOutcome> {
  const issue = await ctx.tracker.issue(decision.iid);
  const current = aiLabel(issue.labels);
  if (decision.status === 'approved' && current === decision.to) {
    // Reintento tras "PUT hecho y nota fallida": la etiqueta ya es la de esta decisión. No se vuelve a
    // escribir la etiqueta ni se anula la decisión; se completa la nota (una sola, por su marcador).
    await postDecisionNote(ctx, decision, evidenceLines(decision, []), approver ?? decision.approver);
    await recordStatus(ctx.root, decision.id, 'applied', ctx.now, (approver ?? decision.approver) ? { approver: approver ?? decision.approver } : {});
    return { code: 0, lines: [`[ai-hub] aplicado #${decision.iid}: ${decision.from ?? '-'} -> ${decision.to} (decision ${decision.id.slice(0, 8)}; nota completada en el reintento)`] };
  }
  if (current !== decision.from) {
    await recordStatus(ctx.root, decision.id, 'superseded', ctx.now, { reason: 'label_changed' });
    return { code: 1, lines: [`#${decision.iid}: la etiqueta cambió (${decision.from ?? '-'} → ${current ?? '-'}); la decisión queda anulada`] };
  }
  const evidence: string[] = [];
  if (decision.kind === 'spec-approval') {
    const seal = await sealFor(ctx.root, decision.feature, ctx.ref);
    if (seal !== decision.hash) {
      await recordStatus(ctx.root, decision.id, 'failed', ctx.now, { reason: 'seal_mismatch' });
      return { code: 1, lines: [`#${decision.iid}: el sello actual no coincide con el aprobado; la spec cambió y necesita otra aprobación`] };
    }
    evidence.push(`Sello aprobado (§5): \`${seal}\``, `<!-- ai-hub:approved-hash=${seal} -->`);
  }
  if (decision.to === IN_DEV) {
    const others = (await ctx.tracker.issuesWithLabel(IN_DEV)).filter((item) => item.iid !== decision.iid);
    const limit = await wipLimit(ctx.manifest);
    if (others.length >= limit) {
      return {
        code: 1,
        lines: [`#${decision.iid}: WIP lleno (${others.length}/${limit} en ${IN_DEV}: ${others.map((item) => `#${item.iid}`).join(', ')}); la decisión sigue pendiente`],
      };
    }
    const approved = await approvedHash(ctx, decision.iid);
    const seal = await sealFor(ctx.root, decision.feature, ctx.ref);
    if (approved === null || seal === null || approved !== seal) {
      await recordStatus(ctx.root, decision.id, 'failed', ctx.now, { reason: 'seal_mismatch' });
      return { code: 1, lines: [`#${decision.iid}: el sello no coincide con el hash aprobado (fail-closed); no se pasa a ${IN_DEV}`] };
    }
    evidence.push(`Sello revalidado contra el hash aprobado: \`${seal.slice(0, 12)}…\``);
  }
  const remove = issue.labels.filter((label) => label.startsWith('ai::') && label !== decision.to);
  await ctx.tracker.moveLabel(decision.iid, decision.to, remove);
  // La etiqueta ya está escrita: se registra como aprobada antes de la nota, para que un reintento tras
  // "PUT hecho y nota fallida" se reconozca (y no se confunda con una etiqueta movida a mano). Si el PUT
  // falla, no se llega aquí y la decisión sigue pendiente.
  if (decision.status !== 'approved') {
    await recordStatus(ctx.root, decision.id, 'approved', ctx.now, approver ? { approver } : {});
  }
  // Una nota de evidencia por decisión aplicada (4.1); en una spec lleva el hash aprobado de §5, que el tick lee.
  await postDecisionNote(ctx, decision, evidenceLines(decision, evidence), approver);
  await recordStatus(ctx.root, decision.id, 'applied', ctx.now, approver ? { approver } : {});
  return { code: 0, lines: [`[ai-hub] aplicado #${decision.iid}: ${decision.from ?? '-'} -> ${decision.to} (decision ${decision.id.slice(0, 8)}; ${impactOf(decision.to)})`] };
}

function latestOpen(decisions: Map<string, Decision>, iid: number): Decision | null {
  const open = [...decisions.values()]
    .filter((decision) => decision.iid === iid && OPEN_STATUSES.includes(decision.status))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return open[0] ?? null;
}

/** Respuesta humana: gramática, aprobador en la lista, decisión abierta y no caducada, hash correcto. */
export async function applyReply(root: string, text: string, approver: string | undefined, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  if (settings.approvers.length === 0) {
    throw new ControlConfigError('manifest.control.approvers está vacío: las aprobaciones están desactivadas');
  }
  const reply = parseReply(text);
  if (reply === null) {
    return { code: 0, lines: ['respuesta ignorada: usa aprobar <iid> <hash>, rechazar <iid> <motivo> o detalle <iid>'] };
  }
  if (approver === undefined || !settings.approvers.includes(approver)) {
    return { code: 1, lines: ['aprobador no autorizado: no está en manifest.control.approvers; no se escribe nada'] };
  }
  const now = options.now ?? new Date();
  const decision = latestOpen(await readDecisions(root), reply.iid);
  if (decision === null) {
    return { code: 1, lines: [`#${reply.iid}: no hay ninguna decisión pendiente`] };
  }
  if (Date.parse(decision.expiresAt) <= now.getTime()) {
    return { code: 1, lines: [`#${reply.iid}: la decisión ${decision.id.slice(0, 8)} caducó; espera la siguiente`] };
  }
  if (reply.verb === 'detalle') {
    const view = { decision, title: decision.feature, summary: `estado ${decision.state ?? '-'}`, impact: impactOf(decision.to), evidence: [] };
    return { code: 0, lines: [renderDetail(view, settings.expire)] };
  }
  if (reply.verb === 'rechazar') {
    await recordStatus(root, decision.id, 'rejected', now, { approver, reason: 'human_rejected' });
    return { code: 0, lines: [`#${reply.iid}: decisión ${decision.id.slice(0, 8)} rechazada; la etiqueta no cambia`] };
  }
  if (decision.kind === 'preapproved' || !decision.hash.startsWith(reply.hash)) {
    return { code: 1, lines: [`#${reply.iid}: el hash ${reply.hash} no corresponde a la decisión pendiente; no se escribe nada`] };
  }
  const ctx: Context = {
    root,
    manifest,
    settings,
    tracker: await GitlabTracker.fromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch),
    now,
    ...(options.ref ? { ref: options.ref } : {}),
  };
  return execute(ctx, decision, approver);
}

/** Decisiones preaprobadas por el hash de §5 (spec-ready → in-dev): se revalidan y se ejecutan. */
export async function applyPreapproved(root: string, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const ctx = await context(root, options);
  const lines: string[] = [];
  let code = 0;
  for (const decision of (await readDecisions(root)).values()) {
    if (decision.kind !== 'preapproved' || decision.status !== 'approved' || Date.parse(decision.expiresAt) <= ctx.now.getTime()) {
      continue;
    }
    const outcome = await execute(ctx, decision, undefined);
    lines.push(...outcome.lines);
    code = Math.max(code, outcome.code);
  }
  return { code, lines };
}

/** Caducidad: con `expire: block`, la issue pasa a `ai::blocked` (approval_expired); con `notify`, solo aviso. */
export async function expireDecisions(root: string, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  const now = options.now ?? new Date();
  const expired = [...(await readDecisions(root)).values()].filter(
    (decision) => OPEN_STATUSES.includes(decision.status) && Date.parse(decision.expiresAt) <= now.getTime(),
  );
  if (expired.length === 0) {
    return { code: 0, lines: [] };
  }
  const lines: string[] = [];
  if (settings.expire === 'notify') {
    for (const decision of expired) {
      await recordStatus(root, decision.id, 'expired', now, { reason: 'approval_expired' });
      lines.push(`[ai-hub] #${decision.iid}: la decisión ${decision.id.slice(0, 8)} caducó sin respuesta (approval_expired); la etiqueta no cambia`);
    }
    return { code: 0, lines };
  }
  const ctx: Context = { root, manifest, settings, tracker: await GitlabTracker.fromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch), now };
  for (const decision of expired) {
    const issue = await ctx.tracker.issue(decision.iid);
    const current = aiLabel(issue.labels);
    if (current !== decision.from) {
      await recordStatus(root, decision.id, 'superseded', now, { reason: 'label_changed' });
      continue;
    }
    const block: Decision = { ...decision, to: BLOCKED };
    await ctx.tracker.moveLabel(decision.iid, BLOCKED, issue.labels.filter((label) => label.startsWith('ai::') && label !== BLOCKED));
    await postDecisionNote(ctx, block, ['Motivo: `approval_expired` (nadie respondió antes de la caducidad).']);
    await recordStatus(root, decision.id, 'expired', now, { reason: 'approval_expired' });
    lines.push(`[ai-hub] #${decision.iid}: sin respuesta antes de ${decision.expiresAt}; ${current ?? '-'} -> ${BLOCKED} (approval_expired)`);
  }
  return { code: 0, lines };
}

