/**
 * Gramática estricta de las respuestas humanas en Discord. Todo lo que no case se ignora:
 *   aprobar <iid> <hash>     (hash: ≥ 8 hex, prefijo del hash de la decisión)
 *   rechazar <iid> <motivo>
 *   detalle <iid>
 */
export type Reply =
  | { verb: 'aprobar'; iid: number; hash: string }
  | { verb: 'rechazar'; iid: number; reason: string }
  | { verb: 'detalle'; iid: number };

export const MIN_HASH_PREFIX = 8;

export function parseReply(text: string): Reply | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }
  const verb = tokens[0].toLowerCase();
  if (!/^\d{1,9}$/.test(tokens[1])) {
    return null;
  }
  const iid = Number.parseInt(tokens[1], 10);
  if (verb === 'aprobar' && tokens.length === 3 && new RegExp(`^[0-9a-fA-F]{${MIN_HASH_PREFIX},64}$`).test(tokens[2])) {
    return { verb, iid, hash: tokens[2].toLowerCase() };
  }
  if (verb === 'rechazar' && tokens.length >= 3) {
    return { verb, iid, reason: tokens.slice(2).join(' ') };
  }
  if (verb === 'detalle' && tokens.length === 2) {
    return { verb, iid };
  }
  return null;
}
