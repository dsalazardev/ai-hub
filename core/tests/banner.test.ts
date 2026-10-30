import { describe, expect, it } from 'vitest';
import { renderBanner } from '../src/cli/banner.js';

/** Longitud visible de una línea: sin los escapes ANSI. */
function visible(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderBanner (script-choice 6.1, 6.2)', () => {
  it('renderiza el bloque de identidad: AI-HUB en blanco brillante sobre azul, tagline debajo', () => {
    const banner = renderBanner(80, true);
    expect(banner).toContain('A  I  -  H  U  B');
    expect(banner).toContain('Autonomous Software Factory');
    expect(banner).toContain('\x1b[44m');
    expect(banner).toContain('\x1b[97m');
    for (const line of banner.split('\n')) {
      expect(line.endsWith('\x1b[0m'), 'cada línea cierra su reset').toBe(true);
    }
  });

  it('NO_COLOR: misma estructura visible, cero escapes', () => {
    const plain = renderBanner(80, false);
    expect(plain).toContain('A  I  -  H  U  B');
    expect(plain).toContain('Autonomous Software Factory');
    expect(plain).not.toContain('\x1b[');
    expect(visible(renderBanner(80, true))).toBe(plain);
  });

  it('cada línea visible cabe en el ancho pedido', () => {
    for (const width of [80, 60, 40]) {
      for (const line of renderBanner(width, true).split('\n')) {
        expect(visible(line).length, `ancho ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('ancho estrecho recorta el espaciado, jamás el texto', () => {
    const narrow = renderBanner(30, false);
    expect(narrow).toContain('A I - H U B');
    expect(narrow).toContain('Autonomous Software Factory');
    expect(narrow).not.toContain('A  I  -  H  U  B');
    for (const line of narrow.split('\n')) {
      expect(line.length, 'el bloque estrecho no rompe la línea').toBeLessThanOrEqual(30);
    }
  });
});
