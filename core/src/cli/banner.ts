/**
 * Banner de identidad de la TUI (change neon-banner, design D1–D5). Función
 * pura: sin clack, sin TTY, sin `process` — el ancho, el modo de color y la
 * versión del paquete los resuelve el adaptador (`assistant-clack.ts`), que
 * sólo se carga tras el gate de TTY, así ningún byte de banner existe en
 * salida pipeada.
 *
 * El banner es el arte slant de "AI-HUB" con gradiente vertical neón en ANSI
 * puro (cian → azul, sin dependencias), el subtítulo "» Autonomous Software
 * Factory" y la versión recibida por parámetro (cruda: el prefijo «v» vive
 * aquí, jamás una constante). Por debajo de 60 columnas renderiza una línea
 * minimalista sin arte: deformar un ASCII art no tiene sentido (D5).
 */

/** Arte slant canónico de "AI-HUB" (render verificado contra slant.flf oficial). */
const ART = [
  '    ___    ____        __  __  __  __ ____',
  '   /   |  /  _/       / / / / / / / // __ )',
  '  / /| |  / / ______ / /_/ / / / / // __  |',
  ' / ___ |_/ / /_____// __  / / /_/ // /_/ /',
  '/_/  |_/___/      /_/ /_/  \\____//_____/',
];

/** Ancho del arte: su línea más larga (43 columnas). */
const ART_W = Math.max(...ART.map((line) => line.length));

/** Modo de color del terminal; la detección vive en el adaptador (design D1). */
export type BannerMode = 'truecolor' | '256' | 'none';

/** Extremos del gradiente: cian neón → azul (design D2). */
const FROM: readonly [number, number, number] = [0, 242, 254];
const TO: readonly [number, number, number] = [0, 114, 255];

const SUBTITLE = '» Autonomous Software Factory';

/** Por debajo de este ancho el banner es una línea sin arte (design D5). */
const FULL_MIN_WIDTH = 60;

/** RGB interpolado de la línea i del arte: t = i/(N−1) entre FROM y TO (D2). */
function lineRgb(i: number): readonly [number, number, number] {
  const t = i / (ART.length - 1);
  const channel = (from: number, to: number): number => Math.round(from + (to - from) * t);
  return [channel(FROM[0], TO[0]), channel(FROM[1], TO[1]), channel(FROM[2], TO[2])];
}

/** Escape de apertura del color de la línea i en el modo pedido (D2). */
function gradientOpen(mode: BannerMode, i: number): string {
  const [r, g, b] = lineRgb(i);
  if (mode === 'truecolor') return `\x1b[38;2;${r};${g};${b}m`;
  if (mode === '256') {
    const cube = (c: number): number => Math.round((c / 255) * 5);
    return `\x1b[38;5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}m`;
  }
  return '';
}

/** Envuelve `text` en un escape ANSI con reset; `none` lo devuelve tal cual. */
function wrap(mode: BannerMode, open: string, text: string): string {
  return mode === 'none' ? text : `${open}${text}\x1b[0m`;
}

/** Banner completo (≥60 columnas): composición del design D4. */
function fullBanner(width: number, mode: BannerMode, version: string): string {
  const padLen = Math.max(Math.floor((width - ART_W) / 2), 0);
  const pad = ' '.repeat(padLen);
  const lines: string[] = [''];
  for (let i = 0; i < ART.length; i++) {
    lines.push(`${pad}${wrap(mode, gradientOpen(mode, i), ART[i])}`);
  }
  // Subtítulo al borde del arte (» en cian neón, texto en blanco brillante) y
  // versión en gris alineada a la derecha: la línea visible llena el ancho.
  const release = `v${version}`;
  const gap = Math.max(width - padLen - SUBTITLE.length - release.length, 1);
  lines.push(
    `${pad}${wrap(mode, gradientOpen(mode, 0), '»')}` +
      `${wrap(mode, '\x1b[97m', ' Autonomous Software Factory')}` +
      `${' '.repeat(gap)}${wrap(mode, '\x1b[90m', release)}`,
  );
  // Separador gris que escala al ancho completo.
  lines.push(wrap(mode, '\x1b[90m', '─'.repeat(width)));
  lines.push('');
  return lines.join('\n');
}

/** Fallback (<60 columnas): una línea que cabe, degradando antes del clamp (D5). */
function fallbackBanner(width: number, mode: BannerMode, version: string): string {
  const name = wrap(mode, gradientOpen(mode, 0), 'AI-HUB');
  const rest = ` · Autonomous Software Factory · v${version}`;
  if (width >= 'AI-HUB'.length + rest.length) {
    return name + wrap(mode, '\x1b[90m', rest);
  }
  const short = ` · v${version}`;
  if (width >= 'AI-HUB'.length + short.length) {
    return name + wrap(mode, '\x1b[90m', short);
  }
  return name;
}

/**
 * Renderiza el banner. `width` es el ancho del terminal (el adaptador pasa
 * `process.stdout.columns ?? 80`); `mode` es la profundidad de color sondeada
 * por el adaptador; `version` es la versión cruda del paquete (el prefijo
 * «v» se agrega aquí). Con 60 columnas o más renderiza la composición
 * completa; por debajo, una línea minimalista sin arte (D5): el texto se
 * degrada antes de clamparse, jamás se rompe.
 */
export function renderBanner(width: number, mode: BannerMode, version: string): string {
  const effective = Math.floor(width);
  if (effective < FULL_MIN_WIDTH) {
    return fallbackBanner(effective, mode, version);
  }
  return fullBanner(effective, mode, version);
}
