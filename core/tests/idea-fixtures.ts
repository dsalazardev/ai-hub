/**
 * idea-input: fixtures deterministas de la idea del proyecto. Markdown con todo lo que rompía 0.13.0
 * (`##`, fences de 3 y 4 backticks, tablas, líneas vacías, una línea con solo `.`) y un centinela que
 * solo puede acabar en `backlog/seed.md` e `IDEA.md`. El texto CRDT real no se versiona.
 */
export const IDEA_SENTINEL = 'AIHUB_IDEA_SENTINEL_5e7a';

const BLOCK: readonly string[] = [
  '## Sección {n}: motor local-first',
  '',
  'Párrafo {n} con acentos (ñ, á, é) y un enlace [doc](https://example.invalid/{n}).',
  '| Hito | Entregable | Criterio de Aceptación |',
  '| --- | --- | --- |',
  '| **Hito {n}** | Core CRDT Wasm | Resuelve ediciones concurrentes sí/no |',
  '',
  '```rust',
  'fn merge_{n}(a: &Doc, b: &Doc) -> Doc { a.join(b) }',
  '```',
  '````markdown',
  'Un fence interno de tres:',
  '```',
  'texto dentro {n}',
  '```',
  '````',
  '.',
  `Centinela {n}: ${IDEA_SENTINEL}`,
  '\tLínea {n} con tabulador inicial y espacios finales   ',
  '',
];

export interface IdeaFixtureOptions {
  /** Número exacto de líneas (se ignora `bytes`). */
  lines?: number;
  /** Tamaño mínimo en bytes UTF-8; se completa el bloque en curso y se recorta por líneas. */
  bytes?: number;
  crlf?: boolean;
  bom?: boolean;
}

/** Texto LF sin salto final (forma ya normalizada), salvo las variantes CRLF/BOM. */
export function makeIdeaFixture(options: IdeaFixtureOptions): string {
  const out: string[] = [];
  let size = 0;
  for (let n = 0; ; n += 1) {
    for (const template of BLOCK) {
      const line = template.replace(/\{n\}/g, String(n));
      if (options.lines !== undefined) {
        if (out.length >= options.lines) {
          return finish(out, options);
        }
      } else if (size >= (options.bytes ?? 0)) {
        return finish(out, options);
      }
      out.push(line);
      size += Buffer.byteLength(line) + 1;
    }
  }
}

function finish(lines: string[], options: IdeaFixtureOptions): string {
  // Sin línea final vacía: la forma normalizada no termina en salto.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
    lines.push('Cierre.');
  }
  const text = lines.join(options.crlf ? '\r\n' : '\n');
  return options.bom ? `﻿${text}` : text;
}

/** Lo que entrega un terminal al pegar: cada salto de línea es `\r` (Enter en raw mode). */
export function asTerminalPaste(text: string): string {
  return text.replace(/\r\n|\n/g, '\r');
}

export const BRACKETED_START = '\x1b[200~';
export const BRACKETED_END = '\x1b[201~';
