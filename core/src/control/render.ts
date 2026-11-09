import type { Decision } from './ledger.js';

/**
 * Mensaje de una decisión, renderizado por el arnés. Hermes lo transporta tal cual a Discord: no
 * redacta veredictos. Una decisión por mensaje; la evidencia nombra siempre su fuente.
 */
export interface EvidenceItem {
  text: string;
  source: string;
}

export interface DecisionView {
  decision: Decision;
  title: string;
  summary: string;
  impact: string;
  evidence: EvidenceItem[];
}

/** Límite práctico de un mensaje de Discord; la evidencia que no cabe queda para `detalle`. */
export const MESSAGE_LIMIT = 2000;

const IMPACT: Record<string, string> = {
  'ai::spec-ready': 'la spec queda aprobada con este hash; cualquier cambio posterior la invalida (§5)',
  'ai::in-dev': 'empieza el desarrollo de la feature (WIP limitado por policy.wip)',
  'ai::in-review': 'la issue pasa a revisión; el motor deja de trabajar en ella',
  'ai::blocked': 'la issue queda bloqueada con motivo y evidencia',
  'ai::done': 'la issue se da por terminada en el tablero',
  'ai::in-spec': 'la issue vuelve a especificación',
  'ai::todo': 'la issue vuelve a la cola',
};

export function impactOf(label: string): string {
  return IMPACT[label] ?? `la issue pasa a ${label}`;
}

function shortId(decision: Decision): string {
  return decision.id.slice(0, 8);
}

function expiry(decision: Decision): string {
  return decision.expiresAt.replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

function header(view: DecisionView): string[] {
  const { decision } = view;
  return [
    `[ai-hub] decision ${shortId(decision)} | #${decision.iid} "${view.title}" (${decision.feature})`,
    `Transicion: ${decision.from ?? '-'} -> ${decision.to}`,
    `Resumen:   ${view.summary}`,
    `Impacto:   ${view.impact}`,
  ];
}

function options(decision: Decision): string {
  if (decision.kind === 'preapproved') {
    return `Opciones:  preaprobada por el hash aprobado; se aplica con ai-hub control apply --preapproved | detalle ${decision.iid}`;
  }
  return `Opciones:  aprobar ${decision.iid} ${decision.hash.slice(0, 8)} | rechazar ${decision.iid} <motivo> | detalle ${decision.iid}`;
}

function footer(decision: Decision, onExpire: 'block' | 'notify'): string {
  const consequence = onExpire === 'block' ? 'sin respuesta -> ai::blocked, approval_expired' : 'sin respuesta -> solo aviso';
  return `Expira:    ${expiry(decision)} (${consequence})`;
}

function evidenceLines(items: EvidenceItem[]): string[] {
  return items.flatMap((item) => [`  - ${item.text}`, `    fuente: ${item.source}`]);
}

/** Texto para Discord, dentro del límite; si la evidencia no cabe, se recorta y se remite a `detalle`. */
export function renderDiscord(view: DecisionView, onExpire: 'block' | 'notify'): string {
  const fixed = [...header(view), 'Evidencia:'];
  const tail = [options(view.decision), footer(view.decision, onExpire)];
  const evidence = evidenceLines(view.evidence);
  const fits = (lines: string[]): boolean => [...fixed, ...lines, ...tail].join('\n').length <= MESSAGE_LIMIT;
  let shown = evidence;
  while (!fits(shown) && shown.length > 0) {
    shown = shown.slice(0, -2);
  }
  if (shown.length < evidence.length) {
    shown = [...shown, `  - evidencia completa: detalle ${view.decision.iid}`];
  }
  return [...fixed, ...shown, ...tail].join('\n');
}

/** Detalle completo (respuesta a `detalle <iid>`), sin límite de evidencia. */
export function renderDetail(view: DecisionView, onExpire: 'block' | 'notify'): string {
  const { decision } = view;
  return [
    ...header(view),
    'Evidencia:',
    ...evidenceLines(view.evidence),
    `Hash:      ${decision.hash}`,
    `Estado:    ${decision.status}${decision.reason ? ` (${decision.reason})` : ''}`,
    options(decision),
    footer(decision, onExpire),
  ].join('\n');
}

export function renderJson(view: DecisionView): Record<string, unknown> {
  const { decision } = view;
  return {
    id: decision.id,
    kind: decision.kind,
    iid: decision.iid,
    feature: decision.feature,
    title: view.title,
    from: decision.from,
    to: decision.to,
    state: decision.state,
    source: decision.source,
    hash: decision.hash,
    summary: view.summary,
    impact: view.impact,
    evidence: view.evidence,
    expiresAt: decision.expiresAt,
    status: decision.status,
  };
}
