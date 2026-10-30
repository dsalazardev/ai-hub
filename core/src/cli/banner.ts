/**
 * Banner de identidad de la TUI (design D8). Función pura: sin clack, sin TTY,
 * sin `process` — el ancho y la detección de `NO_COLOR` los resuelve el adaptador
 * (`assistant-clack.ts`), que sólo se carga tras el gate de TTY, así ningún byte
 * de banner existe en salida pipeada.
 *
 * El "tamaño destacado" en ANSI puro es espaciado y bloque, no fuente: fondo azul
 * (`\x1b[44m`), "AI-HUB" en blanco brillante (`\x1b[97m`) con letter-spacing, y el
 * tagline debajo. El bloque se adapta al ancho recortando el espaciado, jamás el
 * texto; por debajo del mínimo el bloque se clampa (nunca se rompe una línea).
 */

const TAGLINE = 'Autonomous Software Factory';

/** Ancho mínimo del bloque: el tagline (línea más larga) más una columna de aire a cada lado. */
const MIN_WIDTH = TAGLINE.length + 2;

/** Letter-spacing amplio con ancho holgado; simple cuando el ancho aprieta. */
function titleFor(width: number): string {
  return width >= 40 ? 'A  I  -  H  U  B' : 'A I - H U B';
}

/** Línea del bloque: fondo azul en toda la línea, texto centrado, reset por línea. */
function blockLine(text: string, width: number, color: boolean): string {
  const bg = color ? '\x1b[44m' : '';
  const fg = color ? '\x1b[97m' : '';
  const reset = color ? '\x1b[0m' : '';
  const pad = Math.max(width - text.length, 0);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return bg + ' '.repeat(left) + fg + text + ' '.repeat(right) + reset;
}

/**
 * Renderiza el banner. `width` es el ancho del terminal (el adaptador pasa
 * `process.stdout.columns ?? 80`); por debajo del mínimo el bloque se clampa a
 * `MIN_WIDTH` en vez de romper el texto. `color: false` (`NO_COLOR`) devuelve la
 * misma estructura visible sin un solo escape.
 */
export function renderBanner(width: number, color: boolean): string {
  const effective = Math.max(Math.floor(width), MIN_WIDTH);
  const blank = blockLine('', effective, color);
  const title = blockLine(titleFor(effective), effective, color);
  const tagline = blockLine(TAGLINE, effective, color);
  return [blank, title, tagline, blank].join('\n');
}
