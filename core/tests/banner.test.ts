import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBanner } from '../src/cli/banner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Suite del banner neón (change neon-banner, design D1–D5). La firma es
 * `renderBanner(width, mode, version)`: el modo de color y la versión del
 * paquete los resuelve el adaptador (`assistant-clack.ts`), que es quien
 * toca `process`; el módulo del banner sigue siendo puro. La versión llega
 * cruda (cliVersion() no incluye la «v»): el módulo la prefija.
 */

/** Longitud visible de una línea: sin los escapes ANSI. */
function visible(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Arte slant canónico de "AI-HUB" (render verificado contra slant.flf oficial). */
const ART = [
  '    ___    ____        __  __  __  __ ____',
  '   /   |  /  _/       / / / / / / / // __ )',
  '  / /| |  / / ______ / /_/ / / / / // __  |',
  ' / ___ |_/ / /_____// __  / / /_/ // /_/ /',
  '/_/  |_/___/      /_/ /_/  \\____//_____/',
];

/** RGB interpolado por línea del gradiente (0,242,254) → (0,114,255), t = i/(N−1). */
const RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 242, 254],
  [0, 210, 254],
  [0, 178, 255],
  [0, 146, 255],
  [0, 114, 255],
];

/** Índice del cubo 6×6×6 más cercano por línea: 16 + 36r + 6g + b (modo 256). */
const CUBE256 = [51, 45, 39, 39, 33];

const ART_W = Math.max(...ART.map((line) => line.length));

/** Pad izquierdo del bloque de arte para un ancho (centrado sobre el arte real). */
function padFor(width: number): number {
  return Math.max(Math.floor((width - ART_W) / 2), 0);
}

describe('renderBanner (neon-banner D1–D5)', () => {
  it('el arte canónico mide 42/43/43/42/40 columnas (guardia de transcripción)', () => {
    expect(ART.map((line) => line.length)).toEqual([42, 43, 43, 42, 40]);
  });

  it('renderiza el arte slant con gradiente neón, » y la versión (≥60 columnas)', () => {
    const lines = renderBanner(80, 'truecolor', '0.9.0').split('\n');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('');
    expect(lines[8]).toBe('');
    const pad = ' '.repeat(padFor(80));
    for (let i = 0; i < ART.length; i++) {
      const [r, g, b] = RGB[i];
      expect(lines[1 + i], `línea ${i + 1} del arte`).toBe(
        `${pad}\x1b[38;2;${r};${g};${b}m${ART[i]}\x1b[0m`,
      );
    }
    // Primera línea del arte en cian neón, última en azul (D2).
    expect(lines[1]).toContain('\x1b[38;2;0;242;254m');
    expect(lines[5]).toContain('\x1b[38;2;0;114;255m');
    // Subtítulo al borde del arte (» en cian, texto en blanco brillante) y
    // versión en gris alineada a la derecha: la línea visible llena el ancho.
    const sub = visible(lines[6]);
    expect(sub.startsWith(`${pad}» Autonomous Software Factory`)).toBe(true);
    expect(sub.endsWith('v0.9.0')).toBe(true);
    expect(sub.length).toBe(80);
    expect(lines[6]).toContain('\x1b[38;2;0;242;254m»');
    expect(lines[6]).toContain('\x1b[97m Autonomous Software Factory');
    expect(lines[6]).toContain('\x1b[90mv0.9.0');
    // Separador gris que escala al ancho completo (D4).
    expect(lines[7]).toBe(`\x1b[90m${'─'.repeat(80)}\x1b[0m`);
  });

  it('gradiente: interpolación RGB exacta por línea (D2)', () => {
    const lines = renderBanner(80, 'truecolor', '0.9.0').split('\n');
    for (let i = 0; i < ART.length; i++) {
      const [r, g, b] = RGB[i];
      expect(lines[1 + i], `línea ${i + 1}`).toContain(`\x1b[38;2;${r};${g};${b}m${ART[i]}`);
    }
  });

  it('modo 256: índice del cubo 6×6×6 más cercano por línea (D2)', () => {
    const lines = renderBanner(80, '256', '0.9.0').split('\n');
    for (let i = 0; i < ART.length; i++) {
      expect(lines[1 + i], `línea ${i + 1}`).toContain(`\x1b[38;5;${CUBE256[i]}m${ART[i]}`);
    }
  });

  it('NO_COLOR (modo none): misma estructura visible, cero escapes (tres modos)', () => {
    const none = renderBanner(80, 'none', '0.9.0');
    expect(none).not.toContain('\x1b[');
    expect(visible(renderBanner(80, 'truecolor', '0.9.0'))).toBe(none);
    expect(visible(renderBanner(80, '256', '0.9.0'))).toBe(none);
    expect(renderBanner(80, '256', '0.9.0')).toContain('\x1b[38;5;');
  });

  it('cada línea visible cabe en el ancho pedido; frontera del fallback en 60/59', () => {
    for (const width of [80, 60, 59, 40]) {
      for (const version of ['0.9.0', '10.0.0']) {
        for (const line of renderBanner(width, 'truecolor', version).split('\n')) {
          expect(visible(line).length, `ancho ${width}, versión ${version}`).toBeLessThanOrEqual(width);
        }
      }
    }
    // 60 = banner completo con arte; 59 = fallback de una línea (frontera exacta).
    expect(renderBanner(60, 'truecolor', '0.9.0')).toContain(ART[0]);
    const narrow = renderBanner(59, 'truecolor', '0.9.0');
    expect(narrow).not.toContain(ART[0]);
    expect(narrow.split('\n')).toHaveLength(1);
  });

  it('ancho estrecho (<60): una línea sin arte, degradando antes del clamp (D5)', () => {
    expect(visible(renderBanner(59, 'none', '0.9.0'))).toBe(
      'AI-HUB · Autonomous Software Factory · v0.9.0',
    );
    expect(visible(renderBanner(40, 'none', '0.9.0'))).toBe('AI-HUB · v0.9.0');
    expect(renderBanner(4, 'none', '0.9.0')).toBe('AI-HUB');
    for (const width of [59, 40, 4]) {
      expect(renderBanner(width, 'truecolor', '0.9.0'), `ancho ${width}`).not.toContain(ART[0]);
    }
  });

  it('la versión llega por parámetro: cambia sin tocar el módulo', () => {
    const full = renderBanner(80, 'none', '9.9.9');
    expect(full).toContain('v9.9.9');
    expect(full).not.toContain('v0.9.0');
    expect(visible(renderBanner(59, 'truecolor', '1.2.3'))).toContain('v1.2.3');
  });

  it('sonda anti-hardcode: ninguna constante de versión en el fuente del módulo', async () => {
    const source = await fs.readFile(path.join(__dirname, '..', 'src', 'cli', 'banner.ts'), 'utf8');
    expect(source).not.toMatch(/\d+\.\d+\.\d+/);
  });
});
