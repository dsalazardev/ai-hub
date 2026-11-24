import { loadEngine } from '../engine/engine.js';
import { openRequests, setRequestStatus } from './requests.js';
import { DeliveryError, ensureAssociation } from '../delivery/association.js';
import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import { ControlConfigError, requireSettings } from './decide.js';
import {
  barred,
  describeBarrier,
  ledgerBarrier,
  OPEN_STATUSES,
  readDecisions,
  recordStatus,
  type ControlSettings,
  type Decision,
} from './ledger.js';
import { impactOf, renderDetail } from './render.js';
import { CONFIRM_WORD, confirmationRef, MIN_HASH_PREFIX, parseReply, REPLY_FORMS } from './reply.js';
import { APPROVED_HASH_MARKER, sealFor } from './tick.js';
import { type GitlabTracker, trackerFromHarness, defaultTrackerFetch, type TrackerFetch } from './tracker.js';
import { LockHeldError } from '../harness/lock.js';
import { labelPermit, UNPROTECTED_TEXT, withIssueLock, WITHHELD_TEXT, type LabelPermit } from './label-policy.js';
import { recordConflict } from './ledger.js';

/**
 * `ai-hub control apply`: aplica una decisión solo con una aprobación humana válida (o preaprobada por el
 * hash de §5) y tras revalidar contra el tracker: etiqueta actual, WIP y sello. Escribe solo la etiqueta
 * (un PUT que añade el destino y retira los demás `ai::`) y las notas del plano de control.
 *
 * Releer la etiqueta antes del PUT NO es una actualización condicional (no es CAS): entre la relectura y
 * la escritura otro escritor puede cambiarla. Por eso, sin una capacidad condicional declarada, el
 * movimiento se retiene (R-004); el modo `unprotected` lo escribe declarándolo sin garantía (R-111).
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
  const tracker = await trackerFromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch);
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
  const permit = labelPermit(ctx.manifest);
  if (permit.kind === 'withheld') {
    return { code: 1, lines: [`#${decision.iid}: ${WITHHELD_TEXT}; la decisión ${decision.id.slice(0, 8)} sigue pendiente`] };
  }
  let labels = issue.labels;
  if (permit.kind === 'unprotected') {
    // Relectura y revalidación dentro de la sección protegida, justo antes del PUT (R-112).
    const fresh = await ctx.tracker.issue(decision.iid);
    if (aiLabel(fresh.labels) !== decision.from) {
      await recordConflict(ctx.root, decision.id, 'label_conflict', ctx.now);
      await recordStatus(ctx.root, decision.id, 'superseded', ctx.now, { reason: 'label_conflict' });
      return { code: 1, lines: [`#${decision.iid}: label_conflict: la etiqueta cambió (${decision.from ?? '-'} → ${aiLabel(fresh.labels) ?? '-'}); no se escribe y se reconcilia`] };
    }
    labels = fresh.labels;
  }
  const remove = labels.filter((label) => label.startsWith('ai::') && label !== decision.to);
  await ctx.tracker.moveLabel(decision.iid, decision.to, remove);
  // La etiqueta ya está escrita: se registra como aprobada antes de la nota, para que un reintento tras
  // "PUT hecho y nota fallida" se reconozca (y no se confunda con una etiqueta movida a mano). Si el PUT
  // falla, no se llega aquí y la decisión sigue pendiente.
  if (decision.status !== 'approved') {
    await recordStatus(ctx.root, decision.id, 'approved', ctx.now, approver ? { approver } : {});
  }
  // Una nota de evidencia por decisión aplicada (4.1); en una spec lleva el hash aprobado de §5, que el tick lee.
  await postDecisionNote(ctx, decision, evidenceLines(decision, evidence), approver);
  const unprotected = permit.kind === 'unprotected';
  await recordStatus(ctx.root, decision.id, 'applied', ctx.now, {
    ...(approver ? { approver } : {}),
    ...(unprotected ? { reason: 'label_update_unprotected' } : {}),
  });
  const lines = [
    `[ai-hub] aplicado #${decision.iid}: ${decision.from ?? '-'} -> ${decision.to} (decision ${decision.id.slice(0, 8)}; ${impactOf(decision.to)})${unprotected ? ` · ${UNPROTECTED_TEXT}` : ''}`,
  ];
  // R-068 (4.58): la asociación de entrega nace después de aplicar `ai::in-dev`, es decir, tras pasar el WIP.
  if (decision.to === IN_DEV && ctx.manifest.delivery !== undefined) {
    try {
      const association = await ensureAssociation(ctx.root, {
        kind: ctx.tracker.kind,
        project: ctx.tracker.projectPath,
        iid: decision.iid,
        title: issue.title,
        base: ctx.manifest.delivery.base ?? 'HEAD',
        ...(ctx.manifest.delivery.branchPrefix ? { prefix: ctx.manifest.delivery.branchPrefix } : {}),
      });
      lines.push(`[ai-hub] #${decision.iid}: rama ${association.branch} y worktree ${association.worktree}`);
    } catch (error) {
      if (!(error instanceof DeliveryError)) {
        throw error;
      }
      lines.push(`[ai-hub] #${decision.iid}: entrega detenida (${error.reasonCode}): ${error.message}`);
    }
  }
  return { code: 0, lines };
}

/** Ejecuta bajo la política de etiquetas: en modo `unprotected`, toda la transacción bajo el lock de la issue. */
async function guarded(ctx: Context, decision: Decision, approver: string | undefined, permit: LabelPermit = labelPermit(ctx.manifest)): Promise<ApplyOutcome> {
  if (permit.kind !== 'unprotected') {
    return execute(ctx, decision, approver);
  }
  try {
    return await withIssueLock(ctx.tracker.baseUrl, ctx.tracker.projectPath, decision.iid, () => execute(ctx, decision, approver));
  } catch (error) {
    if (error instanceof LockHeldError) {
      await recordConflict(ctx.root, decision.id, 'label_lock_timeout', ctx.now);
      return { code: 1, lines: [`#${decision.iid}: label_lock_timeout: ${error.message}; no se escribe nada`] };
    }
    throw error;
  }
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
    return { code: 0, lines: [`respuesta ignorada: usa ${REPLY_FORMS}`] };
  }
  // Antes que nada: un usuario fuera de la lista no ve hash, referencia ni diagnóstico (R-001).
  if (approver === undefined || !settings.approvers.includes(approver)) {
    return { code: 1, lines: ['aprobador no autorizado: no está en manifest.control.approvers; no se escribe nada'] };
  }
  // R-025, R-045: una línea ilegible o más nueva del registro detiene las decisiones afectadas; se informa.
  const barrier = await ledgerBarrier(root);
  if (barred(barrier, reply.iid)) {
    return { code: 1, lines: [`#${reply.iid}: registro de decisiones detenido: ${describeBarrier(barrier) ?? ''}; no se escribe nada`] };
  }
  if (reply.verb === 'diagnostico') {
    return { code: 1, lines: [`#${reply.iid}: ${reply.code}: ${reply.message}; no se escribe nada`] };
  }
  const now = options.now ?? new Date();
  const decisions = await readDecisions(root);
  const project = manifest.project.id;
  const open = openFor(decisions, reply.iid, now);
  if (reply.verb === 'confirmar') {
    const chosen = byRef(decisions, reply.iid, reply.ref, project);
    if (chosen === null) {
      return { code: 1, lines: [`#${reply.iid}: la referencia ${reply.ref} no corresponde a ninguna decisión de este proyecto para #${reply.iid}; usa detalle ${reply.iid}; no se escribe nada`] };
    }
    if (chosen.status === 'applied') {
      return { code: 0, lines: [`#${reply.iid}: la decisión ${chosen.id.slice(0, 8)} ya se aplicó; no se escribe nada`] };
    }
    if (!OPEN_STATUSES.includes(chosen.status) || Date.parse(chosen.expiresAt) <= now.getTime()) {
      const current = open.filter((item) => item.id !== chosen.id).map((item) => item.id.slice(0, 8));
      const replaced = current.length > 0 ? `; la vigente es ${current.join(', ')}` : '';
      return { code: 1, lines: [`#${reply.iid}: la referencia es de la decisión ${chosen.id.slice(0, 8)}, que ya no está vigente (${chosen.status})${replaced}; usa detalle ${reply.iid}; no se escribe nada`] };
    }
    if (chosen.kind === 'preapproved') {
      return { code: 1, lines: [`#${reply.iid}: la decisión ${chosen.id.slice(0, 8)} se aplica por su sello, no por respuesta; no se escribe nada`] };
    }
    return guarded(await replyContext(root, manifest, settings, now, options), chosen, approver);
  }
  // R-005 (4.20): las peticiones de ejecución pendientes compiten con las decisiones por la misma respuesta.
  const requests = await openRequests(root, reply.iid, now);
  if (open.length === 0 && requests.length === 0) {
    const expired = latestOpen(decisions, reply.iid);
    return {
      code: 1,
      lines: [expired === null ? `#${reply.iid}: no hay ninguna decisión pendiente` : `#${reply.iid}: la decisión ${expired.id.slice(0, 8)} caducó; espera la siguiente`],
    };
  }
  if (reply.verb === 'consultar') {
    // Solo informa: hash, referencia y comandos exactos; ninguna petición ni estado del ledger (R-001).
    return {
      code: 0,
      lines: [
        ...open
          .filter((item) => item.kind !== 'preapproved')
          .map(
            (item) =>
              `#${reply.iid}: decisión ${item.id.slice(0, 8)} pendiente (${item.from ?? '-'} → ${item.to}); hash ${item.hash.slice(0, MIN_HASH_PREFIX)}, ` +
              `ref ${confirmationRef(project, item.id, item.expiresAt)}; responde aprobar ${reply.iid} ${item.hash.slice(0, MIN_HASH_PREFIX)} ` +
              `o aprobar ${reply.iid} ${CONFIRM_WORD} ${confirmationRef(project, item.id, item.expiresAt)}`,
          ),
        ...requests.map(
          (item) => `#${reply.iid}: petición de ejecución ${item.id.slice(0, 8)} pendiente («${item.summary}»); hash ${item.id.slice(0, MIN_HASH_PREFIX)}; responde aprobar ${reply.iid} ${item.id.slice(0, MIN_HASH_PREFIX)}`,
        ),
      ],
    };
  }
  const candidates = reply.verb === 'aprobar' ? open.filter((item) => item.kind !== 'preapproved' && item.hash.startsWith(reply.hash)) : open;
  const requestCandidates = reply.verb === 'aprobar' ? requests.filter((item) => item.id.startsWith(reply.hash)) : requests;
  if (candidates.length + requestCandidates.length > 1) {
    if (requestCandidates.length > 0) {
      const names = [
        ...candidates.map((item) => `decisión ${item.id.slice(0, 8)} (hash ${item.hash.slice(0, MIN_HASH_PREFIX)})`),
        ...requestCandidates.map((item) => `petición ${item.id.slice(0, 8)} (hash ${item.id.slice(0, MIN_HASH_PREFIX)})`),
      ];
      return { code: 1, lines: [`#${reply.iid}: la respuesta coincide con ${names.join(' y ')}; usa un prefijo más largo; no se aprueba nada`] };
    }
    return { code: 1, lines: [ambiguous(reply.iid, candidates)] };
  }
  if (requestCandidates.length === 1) {
    const request = requestCandidates[0];
    if (reply.verb === 'detalle') {
      return { code: 0, lines: [`#${reply.iid}: petición ${request.id.slice(0, 8)}: «${request.summary}»; efectos ${request.effects.join(', ')}; base ${request.base.slice(0, 12)}; caduca ${request.expiresAt}`] };
    }
    // Una concesión nunca mueve etiquetas: solo cambia el registro de concesiones.
    await setRequestStatus(root, request.id, reply.verb === 'aprobar' ? 'approved' : 'rejected', approver, now);
    return {
      code: 0,
      lines: [
        reply.verb === 'aprobar'
          ? `#${reply.iid}: petición ${request.id.slice(0, 8)} aprobada como concesión (aprobador ${approver}, caduca ${request.expiresAt}); la etiqueta no cambia`
          : `#${reply.iid}: petición ${request.id.slice(0, 8)} rechazada; no se podrá consumir`,
      ],
    };
  }
  if (reply.verb === 'aprobar' && candidates.length === 0) {
    return { code: 1, lines: [`#${reply.iid}: el hash ${reply.hash} no corresponde a la decisión pendiente; no se escribe nada`] };
  }
  const decision = candidates[0];
  if (reply.verb === 'detalle') {
    const view = { decision, title: decision.feature, summary: `estado ${decision.state ?? '-'}`, impact: impactOf(decision.to), evidence: [] };
    return { code: 0, lines: [renderDetail(view, settings.expire)] };
  }
  if (reply.verb === 'rechazar') {
    await recordStatus(root, decision.id, 'rejected', now, { approver, reason: 'human_rejected' });
    return { code: 0, lines: [`#${reply.iid}: decisión ${decision.id.slice(0, 8)} rechazada; la etiqueta no cambia`] };
  }
  return guarded(await replyContext(root, manifest, settings, now, options), decision, approver);
}

/** Decisiones abiertas y no caducadas de la issue, de la más reciente a la más antigua. */
function openFor(decisions: Map<string, Decision>, iid: number, now: Date): Decision[] {
  return [...decisions.values()]
    .filter((decision) => decision.iid === iid && OPEN_STATUSES.includes(decision.status) && Date.parse(decision.expiresAt) > now.getTime())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** La decisión de la issue cuya referencia coincide (de este proyecto), en cualquier estado. */
function byRef(decisions: Map<string, Decision>, iid: number, ref: string, project: string): Decision | null {
  return [...decisions.values()].find((decision) => decision.iid === iid && confirmationRef(project, decision.id, decision.expiresAt) === ref) ?? null;
}

/** R-022: más de una decisión abierta y una respuesta que no elige una sola: no se escribe nada y se nombran todas. */
function ambiguous(iid: number, open: Decision[]): string {
  const names = open.map((decision) => `${decision.id.slice(0, 8)} (${decision.from ?? '-'} → ${decision.to})`).join(', ');
  return `#${iid}: hay ${open.length} decisiones abiertas (${names}); la respuesta no elige una sola: usa aprobar ${iid} confirmar <ref> (pídela con aprobar ${iid}); no se escribe nada`;
}

async function replyContext(root: string, manifest: ProjectManifest, settings: Context['settings'], now: Date, options: ApplyOptions): Promise<Context> {
  return {
    root,
    manifest,
    settings,
    tracker: await trackerFromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch),
    now,
    ...(options.ref ? { ref: options.ref } : {}),
  };
}

/** Decisiones preaprobadas por el hash de §5 (spec-ready → in-dev): se revalidan y se ejecutan. */
export async function applyPreapproved(root: string, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const ctx = await context(root, options);
  const lines: string[] = [];
  let code = 0;
  const barrierText = describeBarrier(await ledgerBarrier(root));
  if (barrierText !== null) {
    lines.push(`registro de decisiones detenido: ${barrierText}`);
    code = 1;
  }
  for (const decision of (await readDecisions(root)).values()) {
    if (decision.kind !== 'preapproved' || decision.status !== 'approved' || Date.parse(decision.expiresAt) <= ctx.now.getTime()) {
      continue;
    }
    const outcome = await guarded(ctx, decision, undefined);
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
  const ctx: Context = { root, manifest, settings, tracker: await trackerFromHarness(root, manifest, options.trackerFetch ?? defaultTrackerFetch), now };
  const permit = labelPermit(manifest);
  let code = 0;
  for (const decision of expired) {
    if (permit.kind === 'withheld') {
      // La caducidad se registra; la etiqueta no se mueve sin garantía (R-004).
      await recordStatus(root, decision.id, 'expired', now, { reason: 'approval_expired' });
      lines.push(`[ai-hub] #${decision.iid}: la decisión ${decision.id.slice(0, 8)} caducó (approval_expired); la etiqueta no se mueve a ${BLOCKED}: ${WITHHELD_TEXT}`);
      continue;
    }
    const once = async (): Promise<void> => {
      const issue = await ctx.tracker.issue(decision.iid);
      const current = aiLabel(issue.labels);
      if (current !== decision.from) {
        const reason = permit.kind === 'unprotected' ? 'label_conflict' : 'label_changed';
        if (permit.kind === 'unprotected') {
          await recordConflict(root, decision.id, 'label_conflict', now);
        }
        await recordStatus(root, decision.id, 'superseded', now, { reason });
        return;
      }
      const block: Decision = { ...decision, to: BLOCKED };
      await ctx.tracker.moveLabel(decision.iid, BLOCKED, issue.labels.filter((label) => label.startsWith('ai::') && label !== BLOCKED));
      await postDecisionNote(ctx, block, ['Motivo: `approval_expired` (nadie respondió antes de la caducidad).']);
      await recordStatus(root, decision.id, 'expired', now, { reason: 'approval_expired' });
      lines.push(
        `[ai-hub] #${decision.iid}: sin respuesta antes de ${decision.expiresAt}; ${current ?? '-'} -> ${BLOCKED} (approval_expired)${permit.kind === 'unprotected' ? ` · ${UNPROTECTED_TEXT}` : ''}`,
      );
    };
    if (permit.kind !== 'unprotected') {
      await once();
      continue;
    }
    try {
      await withIssueLock(ctx.tracker.baseUrl, ctx.tracker.projectPath, decision.iid, once);
    } catch (error) {
      if (!(error instanceof LockHeldError)) {
        throw error;
      }
      await recordConflict(root, decision.id, 'label_lock_timeout', now);
      lines.push(`#${decision.iid}: label_lock_timeout: ${error.message}; no se escribe nada`);
      code = 1;
    }
  }
  return { code, lines };
}

