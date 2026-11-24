/**
 * Filtro de mensajes de ambos perfiles (R-087): ignoran bots y usuarios fuera de su lista y solo actúan en su canal.
 * El control solo actúa sobre `aprobar`, `rechazar` o `detalle`; el advisor nunca interpreta esos verbos.
 */

export interface IncomingMessage {
  authorId: string;
  isBot: boolean;
  channelId: string;
  text: string;
}

export interface MessageScope {
  users: readonly string[];
  channels: readonly string[];
}

const CONTROL_VERBS = /^\s*(aprobar|rechazar|detalle)\b/i;

function allowed(message: IncomingMessage, scope: MessageScope): boolean {
  return !message.isBot && scope.users.includes(message.authorId) && scope.channels.includes(message.channelId);
}

/** ¿Debe responder el advisor? Nunca a bots, a desconocidos, fuera de su canal ni a los verbos de control. */
export function advisorShouldAnswer(message: IncomingMessage, scope: MessageScope): boolean {
  return allowed(message, scope) && !CONTROL_VERBS.test(message.text);
}

/** ¿Debe actuar el control? Solo sobre sus tres verbos, de un aprobador humano y en su canal. */
export function controlShouldAct(message: IncomingMessage, scope: MessageScope): boolean {
  return allowed(message, scope) && CONTROL_VERBS.test(message.text);
}
