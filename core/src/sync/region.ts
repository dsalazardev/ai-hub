/**
 * Región reservada en archivos del usuario (factory-evolution E2, M-17): ai-hub solo escribe entre
 * `<!-- ai-hub:start -->` y `<!-- ai-hub:end -->`; el texto fuera de los marcadores es del usuario y
 * se conserva byte a byte. El lock registra el hash de la región, no el del archivo.
 */
export const REGION_START = '<!-- ai-hub:start -->';
export const REGION_END = '<!-- ai-hub:end -->';

function bounds(text: string): { start: number; end: number } | null {
  const start = text.indexOf(REGION_START);
  if (start < 0) {
    return null;
  }
  const end = text.indexOf(REGION_END, start + REGION_START.length);
  return end < 0 ? null : { start, end };
}

/** Contenido entre los marcadores (sin ellos), o `null` si el archivo no tiene región. */
export function extractRegion(text: string): string | null {
  const found = bounds(text);
  if (found === null) {
    return null;
  }
  const inner = text.slice(found.start + REGION_START.length, found.end);
  return inner.startsWith('\n') ? inner.slice(1) : inner;
}

/** Sustituye el contenido de la región; si no existe, la añade al final del archivo. */
export function replaceRegion(text: string, content: string): string {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  const block = `${REGION_START}\n${body}${REGION_END}`;
  const found = bounds(text);
  if (found === null) {
    if (text.trim() === '') {
      return `${block}\n`;
    }
    return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  return `${text.slice(0, found.start)}${block}${text.slice(found.end + REGION_END.length)}`;
}

/** Quita la región (marcadores incluidos) y deja intacto el resto del archivo. */
export function removeRegion(text: string): string {
  const found = bounds(text);
  if (found === null) {
    return text;
  }
  const before = text.slice(0, found.start).replace(/\n*$/, '');
  const after = text.slice(found.end + REGION_END.length).replace(/^\n*/, '');
  return before === '' ? after : after === '' ? `${before}\n` : `${before}\n\n${after}`;
}
