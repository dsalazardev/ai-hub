import type { GitlabTracker, RepositoryOwner } from '../control/tracker.js';
import { readAssociations, save, type Association } from './association.js';

/**
 * Petición de cambio de la entrega (R-070, R-071, R-072). La abre solo este componente (nunca un rol implementer),
 * en draft, una vez: antes busca por rama de origen y marcador. Revisión: el autor de la issue si es elegible; si
 * no, el owner que identifica el adaptador, con el motivo anotado; los configurados solo complementan al owner. Bot,
 * cuenta de servicio, identidad del arnés o sin acceso no son elegibles. Sin nadie elegible se registra que hace falta
 * intervención y no se aprueba nada. El componente nunca aprueba ni fusiona.
 */

export const DEVELOPER_ACCESS = 30;

export interface ReviewerCandidate {
  id: number;
  username: string;
  bot: boolean | null;
}

export interface ReviewerChoice {
  reviewerIds: number[];
  reason: string;
  intervention: boolean;
}

function ineligible(user: ReviewerCandidate | null, harnessId: number | null, members: Map<number, number>): string | null {
  if (user === null) {
    return 'el tracker no da el usuario';
  }
  if (user.bot === true || /^(project|group)_\d+_bot_/.test(user.username) || /\[bot\]$/.test(user.username)) {
    return `${user.username} es una cuenta bot`;
  }
  if (/^service_account/.test(user.username)) {
    return `${user.username} es una cuenta de servicio`;
  }
  if (harnessId !== null && user.id === harnessId) {
    return `${user.username} es la identidad que usa el arnés`;
  }
  if ((members.get(user.id) ?? 0) < DEVELOPER_ACCESS) {
    return `${user.username} no tiene acceso al proyecto`;
  }
  return null;
}

/** Elige revisores (R-071): autor elegible; si no, owner con motivo; los configurados complementan al owner. */
export function chooseReviewers(
  author: ReviewerCandidate | null,
  owners: RepositoryOwner[],
  harnessId: number | null,
  configured: number[],
  members: Map<number, number>,
): ReviewerChoice {
  const authorProblem = ineligible(author, harnessId, members);
  if (authorProblem === null && author !== null) {
    return { reviewerIds: [author.id], reason: `revisión pedida al autor de la issue (${author.username})`, intervention: false };
  }
  const owner = owners.find((candidate) => ineligible(candidate, harnessId, members) === null);
  if (owner === undefined) {
    return {
      reviewerIds: [],
      reason: `intervención necesaria: el autor no es elegible (${authorProblem}) y no hay un owner elegible; el arnés no aprueba nada`,
      intervention: true,
    };
  }
  return {
    reviewerIds: [...new Set([owner.id, ...configured])],
    reason: `el autor no es elegible (${authorProblem}); se pide al owner ${owner.username}${configured.length > 0 ? ' y a los revisores configurados' : ''}`,
    intervention: false,
  };
}

export function deliveryMarker(association: Association): string {
  return `ai-hub:delivery=${association.kind}:${association.project}:${association.iid}`;
}

export interface OpenInput {
  iid: number;
  title: string;
  target: string;
  summary: string;
  testEvidence: string;
  issueUrl: string;
  configuredReviewers?: number[];
}

/** Abre (o reencuentra) la petición de cambio (MR o PR, según el adaptador) en draft de la asociación de `iid` (R-070). */
export async function openChangeRequest(root: string, tracker: GitlabTracker, input: OpenInput): Promise<{ iid: number; created: boolean; reason: string }> {
  const entry = Object.entries(await readAssociations(root)).find(([, item]) => item.iid === input.iid);
  if (entry === undefined) {
    throw new Error(`#${input.iid}: sin asociación de entrega; no se abre ninguna petición de cambio`);
  }
  const [key, association] = entry;
  const marker = deliveryMarker(association);
  const existing = association.changeRequest !== null ? { iid: association.changeRequest.id } : await tracker.findMergeRequest(association.branch, marker);
  if (existing !== null) {
    if (association.changeRequest === null || !association.steps.changeRequest) {
      await save(root, key, { ...association, changeRequest: { id: existing.iid }, steps: { ...association.steps, changeRequest: true } });
    }
    return { iid: existing.iid, created: false, reason: 'ya existía; no se crea otra' };
  }
  const memberList = await tracker.projectMembers();
  const members = new Map(memberList.map((member) => [member.id, member.accessLevel]));
  const authorRef = await tracker.issueAuthor(input.iid);
  const owners = await tracker.repositoryOwners();
  const authorBot = authorRef === null ? null : (owners.find((owner) => owner.id === authorRef.id)?.bot ?? null);
  const author = authorRef === null ? null : { ...authorRef, bot: authorBot };
  const choice = chooseReviewers(author, owners, await tracker.currentUserId(), input.configuredReviewers ?? [], members);
  const description = [
    input.summary,
    '',
    `Evidencia de pruebas: ${input.testEvidence}`,
    `Issue: ${input.issueUrl} (#${input.iid})`,
    `Revisión: ${choice.reason}`,
    '',
    `<!-- ${marker} -->`,
  ].join('\n');
  const created = await tracker.createDraftMergeRequest({
    source: association.branch,
    target: input.target,
    title: `${input.title} (#${input.iid})`,
    description,
    reviewerIds: choice.reviewerIds,
    // GitHub pide revisores por login: se toman de los mismos usuarios elegidos, nunca de otra fuente.
    reviewerLogins: choice.reviewerIds
      .map((id) => [...owners, ...(author ? [author] : []), ...memberList].find((user) => user.id === id)?.username ?? '')
      .filter((login) => login !== ''),
  });
  await save(root, key, { ...association, changeRequest: { id: created.iid }, steps: { ...association.steps, changeRequest: true } });
  return { iid: created.iid, created: true, reason: choice.reason };
}
