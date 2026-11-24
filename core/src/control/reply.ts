import { createHash } from 'node:crypto';

/**
 * Gramática estricta de las respuestas humanas en Discord (R-001, R-006). Todo lo que no case se ignora:
 *   aprobar <iid> <hash>              (hash: 8–64 hex, prefijo del hash de la decisión)
 *   aprobar <iid> confirmar <ref>     (ref: la referencia mostrada para esa decisión)
 *   aprobar <iid>                     (solo informa a un aprobador; no escribe nada)
 *   rechazar <iid> <motivo>
 *   detalle <iid>
 * Un hash de longitud o caracteres inválidos se diagnostica por su nombre (`hash_length`, `hash_charset`).
 */
export type ReplyDiagnostic = 'hash_length' | 'hash_charset' | 'ref_format';

export type Reply =
  | { verb: 'aprobar'; iid: number; hash: string }
  | { verb: 'confirmar'; iid: number; ref: string }
  | { verb: 'consultar'; iid: number }
  | { verb: 'rechazar'; iid: number; reason: string }
  | { verb: 'detalle'; iid: number }
  | { verb: 'diagnostico'; iid: number; code: ReplyDiagnostic; message: string };

export const MIN_HASH_PREFIX = 8;
export const MAX_HASH_PREFIX = 64;
export const REF_LENGTH = 10;
export const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CONFIRM_WORD = 'confirmar';

/** Formas válidas, para los mensajes de ayuda. */
export const REPLY_FORMS = 'aprobar <iid> <hash>, aprobar <iid> confirmar <ref>, aprobar <iid>, rechazar <iid> <motivo> o detalle <iid>';

/**
 * Referencia de confirmación (R-006): derivada de la identidad del proyecto, el id de la decisión y su
 * caducidad, de modo que solo vale para esa decisión de ese proyecto. No es un secreto: es un enlace.
 */
export function confirmationRef(project: string, decisionId: string, expiresAt: string): string {
  const digest = createHash('sha256').update(`ai-hub-ref\n${project}\n${decisionId}\n${expiresAt}`).digest();
  // Base32 de Crockford (sin I, L, O, U) de los primeros 50 bits: fácil de dictar y de copiar desde el móvil.
  let bits = 0n;
  for (const byte of digest.subarray(0, 7)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  bits >>= 6n;
  let ref = '';
  for (let index = 0; index < REF_LENGTH; index += 1) {
    ref = REF_ALPHABET[Number(bits & 31n)] + ref;
    bits >>= 5n;
  }
  return ref;
}

function diagnose(iid: number, token: string): Reply {
  if (!/^[0-9a-fA-F]+$/.test(token)) {
    return { verb: 'diagnostico', iid, code: 'hash_charset', message: 'el hash solo admite caracteres hexadecimales (0-9, a-f)' };
  }
  return {
    verb: 'diagnostico',
    iid,
    code: 'hash_length',
    message: `el hash recibido tiene ${token.length} caracteres; se admiten de ${MIN_HASH_PREFIX} a ${MAX_HASH_PREFIX}`,
  };
}

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
  if (verb === 'aprobar') {
    if (tokens.length === 2) {
      return { verb: 'consultar', iid };
    }
    if (tokens.length === 3) {
      const token = tokens[2];
      if (new RegExp(`^[0-9a-fA-F]{${MIN_HASH_PREFIX},${MAX_HASH_PREFIX}}$`).test(token)) {
        return { verb, iid, hash: token.toLowerCase() };
      }
      if (token.toLowerCase() === CONFIRM_WORD) {
        return { verb: 'diagnostico', iid, code: 'ref_format', message: `falta la referencia: aprobar ${iid} ${CONFIRM_WORD} <ref>; pídela con aprobar ${iid}` };
      }
      return diagnose(iid, token);
    }
    if (tokens.length === 4 && tokens[2].toLowerCase() === CONFIRM_WORD) {
      const ref = tokens[3].toUpperCase();
      if (new RegExp(`^[${REF_ALPHABET}]{${REF_LENGTH}}$`).test(ref)) {
        return { verb: 'confirmar', iid, ref };
      }
      return { verb: 'diagnostico', iid, code: 'ref_format', message: `la referencia tiene ${REF_LENGTH} caracteres (0-9 y letras sin I, L, O, U); cópiala de la respuesta a aprobar ${iid}` };
    }
    return null;
  }
  if (verb === 'rechazar' && tokens.length >= 3) {
    return { verb, iid, reason: tokens.slice(2).join(' ') };
  }
  if (verb === 'detalle' && tokens.length === 2) {
    return { verb, iid };
  }
  return null;
}
