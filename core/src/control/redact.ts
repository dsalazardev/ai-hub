import type { RunResult } from '../speckit/runner.js';

/**
 * init-fiabilidad (HC-03, design.md §13): la salida de un comando de Hermes que falla se muestra redactada y
 * acotada; en éxito no se muestra nada. `webhook subscribe` imprime el secreto HMAC de la ruta: jamás sale en claro.
 *
 * Doble barrera:
 * 1. valores conocidos (el `.env` del perfil y el por defecto, y el token tecleado) → `[redactado]`;
 * 2. líneas que nombran un secreto, token, autorización, contraseña o API key → se quitan; credenciales en URL y
 *    cadenas base64url/hex de 32+ caracteres → `[redactado]`.
 */
export const REDACTED = '[redactado]';
export const MAX_CAUSE_LINES = 20;

const SENSITIVE_LINE = /secret|token|authorization|password|api[_-]?key/i;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
const LONG_OPAQUE = /[A-Za-z0-9_-]{32,}/g;

export function redactText(text: string, secrets: readonly string[]): string[] {
  const known = secrets.filter((value) => value.trim().length >= 4).sort((a, b) => b.length - a.length);
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    for (const value of known) {
      line = line.split(value).join(REDACTED);
    }
    if (SENSITIVE_LINE.test(line)) {
      continue;
    }
    line = line.replace(URL_CREDENTIALS, `//${REDACTED}@`).replace(LONG_OPAQUE, REDACTED);
    if (line.trim() !== '') {
      lines.push(line);
    }
  }
  return lines;
}

/** Causa mostrable de un comando fallido: código de salida y, como mucho, 20 líneas redactadas de stdout y stderr. */
export function redactedCause(result: RunResult, secrets: readonly string[]): string[] {
  const body = redactText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, secrets).slice(0, MAX_CAUSE_LINES);
  const exit = result.status === null ? `sin código${result.error ? ` (${result.error})` : ''}` : String(result.status);
  return [`exit ${exit}`, ...body];
}
