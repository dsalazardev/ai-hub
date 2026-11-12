import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import {
  BRACKETED_OFF,
  BRACKETED_ON,
  DEFAULT_MAX_IDEA,
  EDITOR_CONFIRM,
  IDEA_HELP,
  IdeaCancelled,
  IdeaInputError,
  createIdeaReader,
  extractFencedIdea,
  fenceIdea,
  ideaFromEditor,
  ideaFromFile,
  ideaFromStdin,
  isGuiEditor,
  maxIdeaBytes,
  normalizeIdea,
  readIdeaFromTerminal,
  resolveEditor,
  resolveIdeaFromFlags,
  selectIdeaSource,
  splitCommandLine,
  type EditorHost,
  type IdeaReader,
  type IdeaStdin,
  type ReaderSignal,
} from '../src/cli/idea.js';
import { PRE_PROMPT, PRE_PROMPT_HISTORY } from '../src/cli/preprompt.js';
import { classifySeed, renderSeed, writeBacklogSeed } from '../src/cli/assistant.js';
import { refreshTemplateFile, readScaffold } from '../src/presets/materialize.js';
import type { CliContext } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { BRACKETED_END, BRACKETED_START, IDEA_SENTINEL, asTerminalPaste, makeIdeaFixture } from './idea-fixtures.js';

/**
 * idea-input, fase 1: sondas del comportamiento de 0.13.0 y de `p.multiline` (D1) en proceso, con streams
 * falsos (nivel 1 de D9, todas las plataformas, sin red). Son rojas por diseño: afirman el defecto medido.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/idea-0.13.0/', import.meta.url));

interface FakeTty extends PassThrough {
  isTTY: boolean;
  setRawMode(mode: boolean): FakeTty;
}

function fakeInput(): FakeTty {
  const input = new PassThrough() as FakeTty;
  input.isTTY = true;
  input.setRawMode = () => input;
  return input;
}

interface Sink {
  out: Writable & { isTTY?: boolean; columns?: number; rows?: number };
  bytes(): number;
  text(): string;
}

function sink(): Sink {
  let bytes = 0;
  let text = '';
  const out = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (text.length < 500_000) {
        text += chunk.toString('utf8');
      }
      callback();
    },
  }) as Sink['out'];
  out.isTTY = true;
  out.columns = 120;
  out.rows = 40;
  return { out, bytes: () => bytes, text: () => text };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Entrega `data` en trozos, como un terminal, sin esperar a que nadie lo lea. */
async function feed(input: FakeTty, data: string, chunk = 4096): Promise<void> {
  for (let index = 0; index < data.length; index += chunk) {
    input.write(data.slice(index, index + chunk));
    await tick();
  }
}

function unreadBytes(input: FakeTty): number {
  let total = 0;
  for (let chunk = input.read() as Buffer | null; chunk !== null; chunk = input.read() as Buffer | null) {
    total += chunk.length;
  }
  return total;
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

describe('idea-input fase 1 — fixtures (1.3)', () => {
  it('genera fixtures deterministas de 2000 líneas y 1 MiB con todo lo que rompía 0.13.0', () => {
    const lines = makeIdeaFixture({ lines: 2000 });
    expect(sha(lines)).toBe(sha(makeIdeaFixture({ lines: 2000 })));
    expect(lines.split('\n')).toHaveLength(2000);
    const mib = makeIdeaFixture({ bytes: 1024 * 1024 });
    expect(sha(mib)).toBe(sha(makeIdeaFixture({ bytes: 1024 * 1024 })));
    expect(Buffer.byteLength(mib)).toBeGreaterThanOrEqual(1024 * 1024);
    for (const needle of ['\n## Sección', '\n```rust\n', '\n````markdown\n', '\n| --- |', '\n\n', '\n.\n', IDEA_SENTINEL, '\t']) {
      expect(lines).toContain(needle);
    }
    expect(lines.endsWith('\n')).toBe(false);
    expect(makeIdeaFixture({ lines: 20, crlf: true })).toContain('\r\n');
    expect(makeIdeaFixture({ lines: 20, bom: true }).startsWith('﻿')).toBe(true);
  });
});

describe('idea-input fase 1 — fixtures de 0.13.0 (1.4)', () => {
  const prefix =
    /^# Semilla del proyecto\n\n> Registrada por `ai-hub init` el \d{4}-\d{2}-\d{2}\. La idea es textual: el arnés no\n> añade requisitos\. Siguiente paso: abre `backlog\/pre-prompt\.md` en tu agente\.\n\n## Idea\n\n/;

  it('captura seeds reales de 0.13.0: idea cruda bajo ## Idea, sin fence', async () => {
    for (const name of ['seed-normal', 'seed-heading']) {
      const seed = await fs.readFile(path.join(FIXTURES, `${name}.md`), 'utf8');
      const idea = await fs.readFile(path.join(FIXTURES, `${name}.idea.txt`), 'utf8');
      expect(seed).toMatch(prefix);
      expect(seed.replace(prefix, '')).toBe(`${idea}\n`);
      expect(seed).not.toContain('```');
    }
    expect(await fs.readFile(path.join(FIXTURES, 'seed-heading.idea.txt'), 'utf8')).toMatch(/^## /);
  });

  it('captura el pre-prompt de 0.13.0 con su SHA-256 y coincide con la plantilla actual', async () => {
    const preprompt = await fs.readFile(path.join(FIXTURES, 'pre-prompt.md'));
    const recorded = (await fs.readFile(path.join(FIXTURES, 'pre-prompt.sha256'), 'utf8')).trim();
    expect(sha(preprompt)).toBe(recorded);
    expect(sha(PRE_PROMPT)).toBe(recorded);
  });
});

describe('idea-input fase 1 — sondas rojas del p.text de 0.13.0 (1.1, 1.2)', () => {
  it('1.1: un pegado de 2000 líneas se trunca a la primera línea', async () => {
    const idea = makeIdeaFixture({ lines: 2000 });
    const input = fakeInput();
    const screen = sink();
    const pending = p.text({ message: 'idea', input, output: screen.out });
    const feeding = feed(input, asTerminalPaste(idea));
    const value = await pending;
    await feeding;
    expect(typeof value).toBe('string');
    expect(value).toBe(idea.split('\n')[0]);
    expect(String(value).split('\n')).toHaveLength(1);
  });

  it('1.2: el resto del pegado queda sin leer y contesta la confirmación siguiente', async () => {
    const idea = makeIdeaFixture({ lines: 2000 });
    const paste = asTerminalPaste(idea);
    const input = fakeInput();
    const screen = sink();
    const pending = p.text({ message: 'idea', input, output: screen.out });
    const feeding = feed(input, paste);
    const value = String(await pending);
    await feeding;
    const notInValue = Buffer.byteLength(paste) - Buffer.byteLength(value);
    expect(notInValue).toBeGreaterThan(0);
    // Hipótesis: el confirm del plan (siguiente prompt) recibe bytes del pegado y se contesta solo.
    const answer = await Promise.race([
      p.confirm({ message: '¿Aplicamos este plan?', input, output: screen.out }),
      timeout(1500, 'sin-respuesta' as const),
    ]);
    const leftover = unreadBytes(input);
    expect(answer).not.toBe('sin-respuesta');
    expect(typeof answer).toBe('boolean');
    expect(leftover).toBeGreaterThan(0);
  });
});

describe('idea-input fase 1 — p.multiline de clack contra los requisitos (1.0)', () => {
  it('R1: sin showSubmit, dos Enter seguidos envían a mitad de un markdown con línea vacía', async () => {
    const idea = makeIdeaFixture({ lines: 2000 });
    const firstBlank = idea.split('\n').indexOf('');
    const input = fakeInput();
    const screen = sink();
    const pending = p.multiline({ message: 'idea', input, output: screen.out });
    void feed(input, asTerminalPaste(idea.split('\n').slice(0, 40).join('\n')));
    const value = String(await pending);
    expect(value.split('\n')).toHaveLength(firstBlank);
    expect(value).toBe(idea.split('\n').slice(0, firstBlank).join('\n'));
  });

  it('R1/R9: con showSubmit, un tabulador pegado mueve el foco y se pierde del texto', async () => {
    const input = fakeInput();
    const screen = sink();
    const pending = p.multiline({ message: 'idea', input, output: screen.out, showSubmit: true });
    await feed(input, 'a\r\tb\rc', 1);
    input.write('\t');
    await tick();
    input.write('\r');
    const value = String(await pending);
    expect(value).not.toBe('a\n\tb\nc');
    expect(value).not.toContain('\t');
  });

  it('R2: nunca activa bracketed paste', async () => {
    const input = fakeInput();
    const screen = sink();
    const pending = p.multiline({ message: 'idea', input, output: screen.out, showSubmit: true });
    await feed(input, 'línea uno\rlínea dos', 1);
    input.write('\t');
    await tick();
    input.write('\r');
    await pending;
    expect(screen.text()).not.toContain('\x1b[?2004h');
    expect(screen.text()).not.toContain('\x1b[?2004l');
  });

  it('R3: la salida crece con el tamaño de la idea (no está acotada)', { timeout: 60_000 }, async () => {
    const measure = async (lines: number): Promise<{ input: number; output: number }> => {
      const text = Array.from({ length: lines }, (_, i) => `Línea ${i} contenido de prueba`).join('\r');
      const input = fakeInput();
      const screen = sink();
      const pending = p.multiline({ message: 'idea', input, output: screen.out, showSubmit: true });
      await feed(input, text, 1);
      input.write('\t');
      await tick();
      input.write('\r');
      await pending;
      return { input: Buffer.byteLength(text), output: screen.bytes() };
    };
    const small = await measure(20);
    const large = await measure(40);
    expect(large.output / small.output).toBeGreaterThan(1.8);
    expect(large.output / large.input).toBeGreaterThan(10);
  });

  it('R4/R2: no tiene límite ni drena: lo que llega tras el envío queda sin leer', async () => {
    const input = fakeInput();
    const screen = sink();
    const pending = p.multiline({ message: 'idea', input, output: screen.out });
    // Sin showSubmit: el bloque se envía en la primera línea vacía; el resto queda en la entrada.
    const feeding = feed(input, 'uno\rdos\r\rtres\rcuatro; echo fuga\r', 4);
    const value = String(await pending);
    await feeding;
    expect(value).toBe('uno\ndos');
    expect(unreadBytes(input)).toBeGreaterThan(0);
  });
});

// ───────────────────────── Fase 2 — idea.ts y fuentes no interactivas ─────────────────────────

describe('idea-input fase 2 — normalizeIdea (2.1)', () => {
  it('quita BOM, convierte CRLF y CR a LF, quita saltos finales y no toca nada más', () => {
    expect(normalizeIdea('﻿uno\r\ndos\rtres\n\n\n', 'x')).toBe('uno\ndos\ntres');
    expect(normalizeIdea('\tsangría  \n  espacios finales  \nñ é ü 🚀', 'x')).toBe('\tsangría  \n  espacios finales  \nñ é ü 🚀');
    expect(normalizeIdea(Buffer.from('﻿a\r\nb', 'utf8'), 'x')).toBe('a\nb');
  });

  it('es idempotente y lleva las variantes CRLF y BOM al mismo texto', () => {
    const lf = makeIdeaFixture({ lines: 300 });
    const variant = normalizeIdea(Buffer.from(makeIdeaFixture({ lines: 300, crlf: true, bom: true }), 'utf8'), 'x');
    expect(variant).toBe(lf);
    expect(normalizeIdea(variant, 'x')).toBe(variant);
  });

  it('rechaza el byte NUL y el UTF-8 inválido con salida 2', () => {
    for (const raw of [Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0x61, 0xff, 0xfe]), 'a\0b']) {
      let error: unknown;
      try {
        normalizeIdea(raw, '--idea-file x.md');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(IdeaInputError);
      expect((error as IdeaInputError).exitCode).toBe(2);
      expect((error as Error).message).toContain('--idea-file x.md');
    }
  });
});

async function ideaDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aihub-idea-'));
}

async function rejection(promise: Promise<unknown>): Promise<IdeaInputError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IdeaInputError);
    expect((error as IdeaInputError).exitCode).toBe(2);
    return error as IdeaInputError;
  }
  throw new Error('se esperaba IdeaInputError');
}

describe('idea-input fase 2 — ideaFromFile (2.2)', () => {
  it('ruta inexistente, directorio y binario salen con 2 nombrando la ruta', async () => {
    const dir = await ideaDir();
    await fs.writeFile(path.join(dir, 'bin.md'), Buffer.from([0x23, 0x00, 0x41]));
    for (const file of ['no-existe.md', '.', 'bin.md']) {
      const error = await rejection(ideaFromFile(file, { cwd: dir, maxBytes: DEFAULT_MAX_IDEA }));
      expect(error.message).toContain(`--idea-file ${file}`);
    }
  });

  it('vacío o solo espacios equivale a saltar', async () => {
    const dir = await ideaDir();
    await fs.writeFile(path.join(dir, 'vacio.md'), '');
    await fs.writeFile(path.join(dir, 'blancos.md'), ' \r\n\t\n');
    for (const file of ['vacio.md', 'blancos.md']) {
      expect(await ideaFromFile(file, { cwd: dir, maxBytes: DEFAULT_MAX_IDEA })).toEqual({ kind: 'skip', source: 'file' });
    }
  });

  it('1 MiB con CRLF y BOM se normaliza byte a byte y la nota nombra solo el nombre base', async () => {
    const dir = await ideaDir();
    await fs.writeFile(path.join(dir, 'idea.md'), makeIdeaFixture({ bytes: 1024 * 1024, crlf: true, bom: true }), 'utf8');
    const result = await ideaFromFile(path.join(dir, 'idea.md'), { cwd: os.tmpdir(), maxBytes: DEFAULT_MAX_IDEA });
    expect(result).toEqual({ kind: 'idea', text: makeIdeaFixture({ bytes: 1024 * 1024 }), source: 'file', note: 'archivo idea.md' });
  });

  it('un archivo mayor que el tope de lectura se rechaza sin cargarlo, y los errores no contienen la idea', async () => {
    const dir = await ideaDir();
    await fs.writeFile(path.join(dir, 'grande.md'), `${IDEA_SENTINEL}\n`.repeat(200));
    const error = await rejection(ideaFromFile('grande.md', { cwd: dir, maxBytes: 1024 }));
    expect(error.message).toContain('AI_HUB_MAX_IDEA');
    expect(error.message).not.toContain(IDEA_SENTINEL);
  });
});

function fakeStdin(chunks: Array<string | Buffer>, isTTY = false): IdeaStdin & { consumed: boolean } {
  const state = {
    isTTY,
    consumed: false,
    chunks: () => {
      state.consumed = true;
      return (async function* () {
        yield* chunks;
      })();
    },
  };
  return state;
}

describe('idea-input fase 2 — ideaFromStdin (2.3)', () => {
  it('lee una tubería de 1 MiB hasta EOF con la misma normalización', async () => {
    const text = makeIdeaFixture({ bytes: 1024 * 1024, crlf: true });
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += 65_536) {
      chunks.push(text.slice(index, index + 65_536));
    }
    const result = await ideaFromStdin(fakeStdin(chunks), { maxBytes: DEFAULT_MAX_IDEA });
    expect(result).toEqual({ kind: 'idea', text: makeIdeaFixture({ bytes: 1024 * 1024 }), source: 'stdin', note: 'entrada estándar' });
  });

  it('vacío salta; con la entrada en una terminal sale con 2 y un ejemplo de tubería', async () => {
    expect(await ideaFromStdin(fakeStdin([]), { maxBytes: DEFAULT_MAX_IDEA })).toEqual({ kind: 'skip', source: 'stdin' });
    const tty = fakeStdin(['no debe leerse'], true);
    const error = await rejection(ideaFromStdin(tty, { maxBytes: DEFAULT_MAX_IDEA }));
    expect(error.message).toMatch(/\| npx ai-hub init --yes --idea-stdin/);
    expect(tty.consumed).toBe(false);
  });

  it('junto a --discord-token-stdin sale con 2 antes de leer la entrada (D11)', async () => {
    const stdin = fakeStdin(['idea']);
    const error = await rejection(
      resolveIdeaFromFlags({ yes: true, 'idea-stdin': true, 'discord-token-stdin': true }, { cwd: os.tmpdir(), stdin }),
    );
    expect(error.message).toContain('--idea-stdin');
    expect(error.message).toContain('--discord-token-stdin');
    expect(error.message).toContain('--idea-file');
    expect(stdin.consumed).toBe(false);
  });
});

describe('idea-input fase 2 — límite y AI_HUB_MAX_IDEA (2.4)', () => {
  it('AI_HUB_MAX_IDEA=1024 con 2 KiB: salida 2, nombra la variable y --idea-file, sin truncar', async () => {
    const dir = await ideaDir();
    await fs.writeFile(path.join(dir, 'dos-kib.md'), 'x'.repeat(2048));
    const error = await rejection(
      resolveIdeaFromFlags({ 'idea-file': 'dos-kib.md' }, { cwd: dir, env: { AI_HUB_MAX_IDEA: '1024' } }),
    );
    expect(error.message).toContain('AI_HUB_MAX_IDEA');
    expect(error.message).toContain('--idea-file');
    expect(error.message).toContain('2048');
  });

  it('valores no válidos de la variable salen con 2 nombrándola', () => {
    for (const value of ['0', 'abc', '-1', '1.5']) {
      expect(() => maxIdeaBytes({ AI_HUB_MAX_IDEA: value })).toThrow(/AI_HUB_MAX_IDEA/);
    }
    expect(maxIdeaBytes({})).toBe(DEFAULT_MAX_IDEA);
    expect(maxIdeaBytes({ AI_HUB_MAX_IDEA: '2048' })).toBe(2048);
  });
});

describe('idea-input fase 2 — fence dinámico (2.5)', () => {
  it('N = max(3, racha + 1) y el viaje de ida y vuelta devuelve la idea exacta', () => {
    const tick3 = '`'.repeat(3);
    const tick4 = '`'.repeat(4);
    const cases: Array<[string, number]> = [
      ['sin backticks', 3],
      ['uno `x` y dos ``y``', 3],
      [`${tick3}\nfence de tres\n${tick3}`, 4],
      [`${tick4}md\nfence de cuatro\n${tick4}`, 5],
      [`diez ${'`'.repeat(10)} seguidos`, 11],
    ];
    for (const [idea, length] of cases) {
      const block = fenceIdea(idea);
      expect(block.startsWith(`${'`'.repeat(length)}markdown\n`)).toBe(true);
      expect(block.endsWith(`\n${'`'.repeat(length)}`)).toBe(true);
      expect(extractFencedIdea(`## Idea\n\n${block}\n`)).toBe(idea);
    }
    const mib = makeIdeaFixture({ bytes: 1024 * 1024 });
    expect(extractFencedIdea(fenceIdea(mib))).toBe(mib);
  });

  it('sin bloque bien formado el extractor devuelve null', () => {
    expect(extractFencedIdea('## Idea\n\nidea cruda de 0.13.0\n')).toBeNull();
    expect(extractFencedIdea(`${'`'.repeat(4)}markdown\nsin cierre\n${'`'.repeat(3)}\n`)).toBeNull();
  });
});

describe('idea-input fase 2 — flags (2.6)', () => {
  it('--idea-stdin e --idea-editor son booleanos y no se tragan el siguiente argumento', () => {
    expect(parseArgs(['init', '--idea-stdin', '--yes'])).toEqual({ positionals: ['init'], flags: { 'idea-stdin': true, yes: true } });
    expect(parseArgs(['init', '--idea-stdin', 'x'])).toEqual({ positionals: ['init', 'x'], flags: { 'idea-stdin': true } });
    expect(parseArgs(['init', '--idea-editor', 'y']).flags).toEqual({ 'idea-editor': true });
  });

  it('--discord-token-stdin también es booleano (añadido a 2.6)', () => {
    expect(parseArgs(['init', '--discord-token-stdin', '--yes'])).toEqual({
      positionals: ['init'],
      flags: { 'discord-token-stdin': true, yes: true },
    });
    expect(parseArgs(['init', '--discord-token-stdin', 'x'])).toEqual({
      positionals: ['init', 'x'],
      flags: { 'discord-token-stdin': true },
    });
  });

  it('--idea-file toma valor, también con = para rutas que empiezan por --', () => {
    expect(parseArgs(['init', '--idea-file', 'idea.md', '--yes']).flags).toEqual({ 'idea-file': 'idea.md', yes: true });
    expect(parseArgs(['init', '--idea-file=--raro.md']).flags).toEqual({ 'idea-file': '--raro.md' });
  });

  it('--idea-file sin ruta sale con 2', async () => {
    await rejection(resolveIdeaFromFlags(parseArgs(['init', '--idea-file']).flags, { cwd: os.tmpdir() }));
  });
});

describe('idea-input fase 2 — precedencia (2.7)', () => {
  it('--idea-file gana a --idea-stdin, no consume la entrada y una línea lo dice', async () => {
    const dir = await ideaDir();
    await fs.writeFile(path.join(dir, 'idea.md'), 'idea del archivo');
    const stdin = fakeStdin(['idea de la tubería']);
    const result = await resolveIdeaFromFlags({ 'idea-file': 'idea.md', 'idea-stdin': true }, { cwd: dir, stdin });
    expect(result.outcome).toEqual({ kind: 'idea', text: 'idea del archivo', source: 'file', note: 'archivo idea.md' });
    expect(result.notice).toBe('idea: se usa --idea-file; se ignora --idea-stdin');
    expect(stdin.consumed).toBe(false);
  });

  it('orden completo file > stdin > editor y sin flags no hay fuente', () => {
    expect(selectIdeaSource({ 'idea-editor': true, 'idea-stdin': true }).flag).toBe('idea-stdin');
    expect(selectIdeaSource({ 'idea-editor': true, 'idea-file': 'a', 'idea-stdin': true })).toEqual({
      flag: 'idea-file',
      ignored: ['idea-stdin', 'idea-editor'],
      notice: 'idea: se usa --idea-file; se ignora --idea-stdin y --idea-editor',
    });
    expect(selectIdeaSource({ yes: true })).toEqual({ flag: null, ignored: [], notice: null });
  });
});

// ───────────────────────────── Fase 3 — editor externo ─────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeEditorOptions {
  root: string;
  tmpdir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  onPath?: string[];
  isTTY?: boolean;
  /** Lo que hace el editor con el archivo; devuelve el código de salida y si hubo Ctrl+C. */
  run?: (file: string) => Promise<{ code?: number | null; interrupted?: boolean }>;
  /** Respuesta a la confirmación (y efecto, p. ej. escribir el archivo «después»). */
  confirm?: (file: string) => Promise<boolean | null>;
}

function fakeEditorHost(options: FakeEditorOptions): { host: EditorHost; spawned: string[][]; confirms: string[] } {
  const spawned: string[][] = [];
  const confirms: string[] = [];
  let lastFile = '';
  const host: EditorHost = {
    platform: options.platform ?? 'linux',
    env: options.env ?? {},
    root: options.root,
    isTTY: options.isTTY ?? true,
    tmpdir: options.tmpdir,
    onPath: async (command) => (options.onPath ?? []).includes(command),
    spawn: async (command, args) => {
      spawned.push([command, ...args]);
      lastFile = args[args.length - 1];
      const result = options.run ? await options.run(lastFile) : {};
      return { code: result.code === undefined ? 0 : result.code, interrupted: result.interrupted ?? false };
    },
    confirmClosed: async (message) => {
      confirms.push(message);
      return options.confirm ? options.confirm(lastFile) : true;
    },
  };
  return { host, spawned, confirms };
}

async function leftovers(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => name.startsWith('ai-hub-idea-'));
}

describe('idea-input fase 3 — resolución del editor (3.1)', () => {
  const base = { root: os.tmpdir(), tmpdir: os.tmpdir() };

  it('$VISUAL > $EDITOR > code --wait > notepad (Windows) o vi (POSIX)', async () => {
    const cases: Array<[Partial<FakeEditorOptions>, { command: string; args: string[]; gui: boolean; origin: string }]> = [
      [{ env: { VISUAL: 'nvim', EDITOR: 'nano' } }, { command: 'nvim', args: [], gui: false, origin: 'VISUAL' }],
      [{ env: { EDITOR: 'nano -w' } }, { command: 'nano', args: ['-w'], gui: false, origin: 'EDITOR' }],
      [{ platform: 'win32', onPath: ['code'] }, { command: 'code', args: ['--wait'], gui: false, origin: 'fallback' }],
      [{ platform: 'win32' }, { command: 'notepad', args: [], gui: true, origin: 'fallback' }],
      [{ platform: 'linux', onPath: ['code'] }, { command: 'code', args: ['--wait'], gui: false, origin: 'fallback' }],
      [{ platform: 'linux' }, { command: 'vi', args: [], gui: false, origin: 'fallback' }],
    ];
    for (const [options, expected] of cases) {
      expect(await resolveEditor(fakeEditorHost({ ...base, ...options }).host)).toEqual(expected);
    }
  });

  it('separa comillas y reconoce la lista GUI (notepad++, sublime_text, code sin --wait)', () => {
    expect(splitCommandLine('"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst -nosession')).toEqual([
      'C:\\Program Files\\Notepad++\\notepad++.exe',
      '-multiInst',
      '-nosession',
    ]);
    expect(splitCommandLine("code --wait 'mi carpeta'")).toEqual(['code', '--wait', 'mi carpeta']);
    expect(isGuiEditor('C:\\Program Files\\Notepad++\\notepad++.exe', [])).toBe(true);
    expect(isGuiEditor('sublime_text.exe', [])).toBe(true);
    expect(isGuiEditor('code', [])).toBe(true);
    expect(isGuiEditor('code', ['--wait'])).toBe(false);
    expect(isGuiEditor('code-insiders', ['-w'])).toBe(false);
    expect(isGuiEditor('nano', [])).toBe(false);
    expect(isGuiEditor('vim', [])).toBe(false);
  });
});

describe('idea-input fase 3 — espera y confirmación (3.2, D7)', () => {
  it('un editor que escribe tras 500 ms y sale: se lee lo escrito, sin pregunta', async () => {
    const tmp = await ideaDir();
    const fake = fakeEditorHost({
      root: await ideaDir(),
      tmpdir: tmp,
      env: { EDITOR: 'mi-editor' },
      run: async (file) => {
        await sleep(500);
        await fs.writeFile(file, 'idea escrita tras la espera\r\n');
        return { code: 0 };
      },
    });
    expect(await ideaFromEditor(fake.host, DEFAULT_MAX_IDEA)).toEqual({
      kind: 'idea',
      text: 'idea escrita tras la espera',
      source: 'editor',
      note: 'tu editor',
    });
    expect(fake.confirms).toEqual([]);
  });

  it('Notepad que sale al instante sin cambios: pregunta y lee solo tras la confirmación', async () => {
    const fake = fakeEditorHost({
      root: await ideaDir(),
      tmpdir: await ideaDir(),
      platform: 'win32',
      env: { EDITOR: 'notepad' },
      run: async () => ({ code: 0 }),
      confirm: async (file) => {
        await fs.writeFile(file, 'escrito en la ventana que seguía abierta');
        return true;
      },
    });
    const result = await ideaFromEditor(fake.host, DEFAULT_MAX_IDEA);
    expect(fake.confirms).toEqual([EDITOR_CONFIRM]);
    expect(result).toMatchObject({ kind: 'idea', text: 'escrito en la ventana que seguía abierta' });
  });

  it('nano que sale en 1 s sin guardar: sin pregunta y se salta el paso', async () => {
    const fake = fakeEditorHost({
      root: await ideaDir(),
      tmpdir: await ideaDir(),
      env: { EDITOR: 'nano' },
      run: async () => {
        await sleep(1000);
        return { code: 0 };
      },
    });
    expect(await ideaFromEditor(fake.host, DEFAULT_MAX_IDEA)).toEqual({ kind: 'skip', source: 'editor' });
    expect(fake.confirms).toEqual([]);
  });

  it('code --wait se lee directo; code sin --wait y sin cambios pregunta', async () => {
    const waiting = fakeEditorHost({
      root: await ideaDir(),
      tmpdir: await ideaDir(),
      env: { EDITOR: 'code --wait' },
      run: async (file) => {
        await fs.writeFile(file, 'desde vscode');
        return { code: 0 };
      },
    });
    expect(await ideaFromEditor(waiting.host, DEFAULT_MAX_IDEA)).toMatchObject({ kind: 'idea', text: 'desde vscode' });
    expect(waiting.confirms).toEqual([]);
    expect(waiting.spawned[0].slice(0, 2)).toEqual(['code', '--wait']);

    const noWait = fakeEditorHost({ root: await ideaDir(), tmpdir: await ideaDir(), env: { EDITOR: 'code' } });
    expect(await ideaFromEditor(noWait.host, DEFAULT_MAX_IDEA)).toEqual({ kind: 'skip', source: 'editor' });
    expect(noWait.confirms).toEqual([EDITOR_CONFIRM]);
  });

  it('Esc en la confirmación cancela', async () => {
    const fake = fakeEditorHost({
      root: await ideaDir(),
      tmpdir: await ideaDir(),
      env: { EDITOR: 'notepad' },
      confirm: async () => null,
    });
    await expect(ideaFromEditor(fake.host, DEFAULT_MAX_IDEA)).rejects.toBeInstanceOf(IdeaCancelled);
  });
});

describe('idea-input fase 3 — temporal fuera del repositorio (3.3)', () => {
  it('se borra al terminar bien, al fallar y al cancelar; el root no cambia', async () => {
    const root = await ideaDir();
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    const tmp = await ideaDir();
    const before = await fs.readdir(root);
    const ok = fakeEditorHost({ root, tmpdir: tmp, env: { EDITOR: 'ed' }, run: async (file) => (await fs.writeFile(file, 'x'), {}) });
    await ideaFromEditor(ok.host, DEFAULT_MAX_IDEA);
    expect(await leftovers(tmp)).toEqual([]);

    const failing = fakeEditorHost({ root, tmpdir: tmp, env: { EDITOR: 'ed' }, run: async () => ({ code: 1 }) });
    const error = await rejection(ideaFromEditor(failing.host, DEFAULT_MAX_IDEA));
    expect(error.message).toContain('código 1');
    expect(await leftovers(tmp)).toEqual([]);

    const cancelled = fakeEditorHost({ root, tmpdir: tmp, env: { EDITOR: 'ed' }, run: async () => ({ interrupted: true }) });
    await expect(ideaFromEditor(cancelled.host, DEFAULT_MAX_IDEA)).rejects.toBeInstanceOf(IdeaCancelled);
    expect(await leftovers(tmp)).toEqual([]);
    expect(await fs.readdir(root)).toEqual(before);
    for (const fake of [ok, failing, cancelled]) {
      for (const args of fake.spawned) {
        expect(path.relative(root, args[args.length - 1]).startsWith('..')).toBe(true);
      }
    }
  });

  it('un temporal que cae dentro del root sale con 2 sin lanzar el editor', async () => {
    const root = await ideaDir();
    const inside = path.join(root, 'tmp');
    await fs.mkdir(inside);
    const fake = fakeEditorHost({ root, tmpdir: inside, env: { EDITOR: 'ed' } });
    const error = await rejection(ideaFromEditor(fake.host, DEFAULT_MAX_IDEA));
    expect(error.message).toContain('dentro del repositorio');
    expect(fake.spawned).toEqual([]);
    expect(await leftovers(inside)).toEqual([]);
  });
});

describe('idea-input fase 3 — sin terminal (3.4, R13)', () => {
  it('--idea-editor sin TTY sale con 2 nombrando las alternativas y no lanza nada', async () => {
    const fake = fakeEditorHost({ root: await ideaDir(), tmpdir: await ideaDir(), isTTY: false, env: { EDITOR: 'ed' } });
    const error = await rejection(
      resolveIdeaFromFlags({ 'idea-editor': true }, { cwd: os.tmpdir(), editor: (max) => ideaFromEditor(fake.host, max) }),
    );
    expect(error.message).toContain('--idea-file');
    expect(error.message).toContain('--idea-stdin');
    expect(fake.spawned).toEqual([]);
  });
});

// ─────────────────────────── Fase 4 — entrada multilínea ───────────────────────────

/** Alimenta trozos como el envoltorio: un terminador seguido de más bytes era contenido. */
function drive(reader: IdeaReader, chunks: string[]): ReaderSignal {
  let signal: ReaderSignal = { type: 'continue' };
  for (const chunk of chunks) {
    if (signal.type === 'terminate') {
      reader.revokeTerminator();
    }
    signal = reader.feed(chunk);
  }
  return signal;
}

/** Trozos de tamaño pseudoaleatorio determinista (1..97), para partir marcadores y caracteres. */
function shred(text: string, seed = 7): string[] {
  const chunks: string[] = [];
  let state = seed;
  for (let index = 0; index < text.length; ) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const size = 1 + (state % 97);
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  return chunks;
}

describe('idea-input fase 4 — máquina del lector (4.1)', () => {
  const read = (chunks: string[], max = DEFAULT_MAX_IDEA): { signal: ReaderSignal; result: ReturnType<IdeaReader['result']> } => {
    const reader = createIdeaReader(max);
    const signal = drive(reader, chunks);
    return { signal, result: reader.result() };
  };

  it('Enter añade una línea; Ctrl+D y la línea "." terminan', () => {
    expect(read(['uno\rdos', '\x04'])).toEqual({ signal: { type: 'terminate' }, result: { kind: 'text', text: 'uno\ndos' } });
    expect(read(['uno\r', 'dos\r', '.\r'])).toEqual({ signal: { type: 'terminate' }, result: { kind: 'text', text: 'uno\ndos' } });
    expect(read(['a\r\nb\x04']).result).toEqual({ kind: 'text', text: 'a\nb' });
  });

  it('con la entrada vacía, Ctrl+D o "." saltan el paso', () => {
    expect(read(['\x04'])).toEqual({ signal: { type: 'terminate' }, result: { kind: 'skip' } });
    expect(read(['.\r'])).toEqual({ signal: { type: 'terminate' }, result: { kind: 'skip' } });
  });

  it('dentro de un bracketed paste ni "." ni los saltos terminan', () => {
    const paste = `${BRACKETED_START}a\r.\r\r\nb${BRACKETED_END}`;
    expect(read([paste, '\x04']).result).toEqual({ kind: 'text', text: 'a\n.\n\nb' });
  });

  it('el pegado de 2000 líneas sobrevive a trozos arbitrarios, incluidos los marcadores partidos', () => {
    const idea = makeIdeaFixture({ lines: 2000 });
    const paste = `${BRACKETED_START}${asTerminalPaste(idea)}${BRACKETED_END}`;
    expect(read([...shred(paste), '\x04']).result).toEqual({ kind: 'text', text: idea });
    expect(read([...shred(paste, 99), '\x04']).result).toEqual({ kind: 'text', text: idea });
  });

  it('Backspace solo borra en la línea en curso; las secuencias CSI/SS3 se descartan', () => {
    expect(read(['abc\x7f\x7fx\x04']).result).toEqual({ kind: 'text', text: 'ax' });
    expect(read(['a\r\x7f\x7fb\x04']).result).toEqual({ kind: 'text', text: 'a\nb' });
    expect(read(['ñ\x7fo\x04']).result).toEqual({ kind: 'text', text: 'o' });
    expect(read(['a\x1b[Ab\x1b[3~c\x1bOPd\x04']).result).toEqual({ kind: 'text', text: 'abcd' });
  });

  it('Esc suelto queda pendiente y cancela; Ctrl+C cancela; Ctrl+E pide el editor', () => {
    const reader = createIdeaReader(DEFAULT_MAX_IDEA);
    expect(reader.feed('hola\x1b')).toEqual({ type: 'escape-pending' });
    expect(reader.resolveEscape()).toEqual({ type: 'cancel' });
    expect(createIdeaReader(DEFAULT_MAX_IDEA).feed('a\x03b')).toEqual({ type: 'cancel' });
    expect(createIdeaReader(DEFAULT_MAX_IDEA).feed('a\x05')).toEqual({ type: 'editor' });
    const arrow = createIdeaReader(DEFAULT_MAX_IDEA);
    expect(arrow.feed('\x1b')).toEqual({ type: 'escape-pending' });
    expect(arrow.feed('[Dx\x04')).toEqual({ type: 'terminate' });
    expect(arrow.result()).toEqual({ kind: 'text', text: 'x' });
  });

  it('sin marcadores, un terminador con bytes detrás en el mismo trozo es contenido (D10)', () => {
    expect(read(['uno\r.\rdos\r', '\x04']).result).toEqual({ kind: 'text', text: 'uno\n.\ndos' });
    expect(read(['uno\r.\r', 'dos', '\x04']).result).toEqual({ kind: 'text', text: 'uno\n.\ndos' });
  });

  it('por encima del límite marca desbordamiento y no conserva el texto', () => {
    const reader = createIdeaReader(1024);
    drive(reader, [`${BRACKETED_START}${'x'.repeat(2048)}${BRACKETED_END}`]);
    expect(reader.stats().overflow).toBe(true);
    expect(reader.result()).toMatchObject({ kind: 'overflow' });
  });
});

interface SpyInput extends FakeTty {
  rawCalls: boolean[];
}

function spyInput(): SpyInput {
  const input = fakeInput() as SpyInput;
  input.rawCalls = [];
  input.setRawMode = (mode: boolean) => {
    input.rawCalls.push(mode);
    return input;
  };
  return input;
}

async function writeChunks(input: FakeTty, chunks: string[], gapMs = 0): Promise<void> {
  for (const chunk of chunks) {
    input.write(chunk);
    await (gapMs > 0 ? sleep(gapMs) : tick());
  }
}

describe('idea-input fase 4 — lector sobre la TTY (4.2)', () => {
  it('activa raw mode y bracketed paste, muestra una sola línea de ayuda y restaura al terminar', async () => {
    const input = spyInput();
    const screen = sink();
    const pending = readIdeaFromTerminal(input, screen.out, { message: '¿Idea?', maxBytes: DEFAULT_MAX_IDEA });
    await writeChunks(input, ['hola', '\x04']);
    expect(await pending).toEqual({ kind: 'idea', text: 'hola', source: 'paste', note: 'pegado en el asistente' });
    expect(input.rawCalls).toEqual([true, false]);
    const text = screen.text();
    expect(text.indexOf(BRACKETED_ON)).toBeGreaterThanOrEqual(0);
    expect(text.lastIndexOf(BRACKETED_OFF)).toBeGreaterThan(text.indexOf(BRACKETED_ON));
    expect(text.split('\n').filter((line) => line.includes(IDEA_HELP))).toHaveLength(1);
    expect(IDEA_HELP).toContain('vacío = saltar · Esc cancela todo');
    expect(input.listenerCount('data')).toBe(0);
  });

  it('Ctrl+C y Esc cancelan y restauran; una flecha no cancela', async () => {
    for (const keys of [['ab', '\x03'], ['ab', '\x1b']]) {
      const input = spyInput();
      const screen = sink();
      const pending = readIdeaFromTerminal(input, screen.out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
      await writeChunks(input, keys);
      expect(await pending).toBeNull();
      expect(input.rawCalls.at(-1)).toBe(false);
      expect(screen.text()).toContain(BRACKETED_OFF);
    }
    const input = spyInput();
    const pending = readIdeaFromTerminal(input, sink().out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
    await writeChunks(input, ['\x1b[A', 'x', '\x04']);
    expect(await pending).toMatchObject({ kind: 'idea', text: 'x' });
  });

  it('una excepción en mitad del pegado restaura la terminal igualmente', async () => {
    const input = spyInput();
    let writes = 0;
    const out = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as Sink['out'];
    const failing = {
      columns: 80,
      write: (chunk: string): boolean => {
        writes += 1;
        if (writes === 4) {
          throw new Error('fallo inyectado al renderizar');
        }
        return out.write(chunk);
      },
    };
    const pending = readIdeaFromTerminal(input, failing, { message: 'm', maxBytes: DEFAULT_MAX_IDEA, renderMs: 0 });
    const paste = `${BRACKETED_START}${asTerminalPaste(makeIdeaFixture({ lines: 200 }))}${BRACKETED_END}`;
    void writeChunks(input, shred(paste));
    await expect(pending).rejects.toThrow('fallo inyectado');
    expect(input.rawCalls.at(-1)).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('Ctrl+E restaura la terminal antes de abrir el editor y devuelve su resultado', async () => {
    const input = spyInput();
    let rawAtEditor: boolean | undefined;
    const pending = readIdeaFromTerminal(input, sink().out, {
      message: 'm',
      maxBytes: DEFAULT_MAX_IDEA,
      editor: async () => {
        rawAtEditor = input.rawCalls.at(-1);
        return { kind: 'idea', text: 'desde el editor', source: 'editor', note: 'tu editor' };
      },
    });
    await writeChunks(input, ['algo', '\x05']);
    expect(await pending).toEqual({ kind: 'idea', text: 'desde el editor', source: 'editor', note: 'tu editor' });
    expect(rawAtEditor).toBe(false);
  });
});

describe('idea-input fase 4 — render acotado (4.3)', () => {
  it('pegar 1 MiB escribe menos de 64 KiB en la terminal y el contador da los totales reales', async () => {
    const idea = makeIdeaFixture({ bytes: 1024 * 1024 });
    const paste = `${BRACKETED_START}${asTerminalPaste(idea)}${BRACKETED_END}`;
    const input = spyInput();
    const screen = sink();
    const pending = readIdeaFromTerminal(input, screen.out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
    const chunks: string[] = [];
    for (let index = 0; index < paste.length; index += 65_536) {
      chunks.push(paste.slice(index, index + 65_536));
    }
    await writeChunks(input, [...chunks, '\x04']);
    const result = await pending;
    expect(result).toEqual({ kind: 'idea', text: idea, source: 'paste', note: 'pegado en el asistente' });
    expect(screen.bytes()).toBeLessThan(64 * 1024);
    const lines = idea.split('\n').length;
    const chars = [...idea].length;
    expect(screen.text()).toContain(`${lines} líneas · ${chars} caracteres`);
  }, 30_000);
});

describe('idea-input fase 4 — terminales sin bracketed paste (4.4, D10)', () => {
  it('un "." en mitad de un pegado sin marcadores es contenido y no queda ningún byte sin leer', async () => {
    const input = spyInput();
    const pending = readIdeaFromTerminal(input, sink().out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
    await writeChunks(input, ['uno\r.\rdos\r'], 0);
    await writeChunks(input, ['tres\r.\r', 'cuatro'], 5);
    await sleep(100);
    input.write('\x04');
    expect(await pending).toMatchObject({ kind: 'idea', text: 'uno\n.\ndos\ntres\n.\ncuatro' });
    expect(unreadBytes(input)).toBe(0);
  });
});

describe('idea-input fase 4 — desbordamiento en el lector (4.5, D4)', () => {
  it('consume el resto del pegado, informa del límite y vuelve a preguntar', async () => {
    const input = spyInput();
    const screen = sink();
    const pending = readIdeaFromTerminal(input, screen.out, { message: 'm', maxBytes: 1024 });
    await writeChunks(input, shred(`${BRACKETED_START}${IDEA_SENTINEL}${'x'.repeat(2048)}${BRACKETED_END}`));
    await sleep(100);
    input.write('ok\x04');
    expect(await pending).toMatchObject({ kind: 'idea', text: 'ok' });
    expect(screen.text()).toContain('AI_HUB_MAX_IDEA');
    expect(screen.text()).not.toContain(IDEA_SENTINEL);
    expect(unreadBytes(input)).toBe(0);
  });
});

describe('idea-input fase 4 — integración con el confirm del plan (4.6, 4.9 nivel 1)', () => {
  it('un pegado de 2000 líneas no contesta la confirmación siguiente (contraste con 1.2)', async () => {
    const idea = makeIdeaFixture({ lines: 2000 });
    const input = spyInput();
    const screen = sink();
    const pending = readIdeaFromTerminal(input, screen.out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
    await writeChunks(input, [...shred(`${BRACKETED_START}${asTerminalPaste(idea)}${BRACKETED_END}`), '\x04']);
    expect(await pending).toMatchObject({ kind: 'idea', text: idea });
    const answer = await Promise.race([
      p.confirm({ message: '¿Aplicamos este plan?', input, output: screen.out }),
      timeout(1500, 'sin-respuesta' as const),
    ]);
    expect(answer).toBe('sin-respuesta');
    input.write('\x03');
    await tick();
    expect(unreadBytes(input)).toBe(0);
  });

  it('Ctrl+C en mitad de un pegado cancela, consume el resto del pegado y restaura', async () => {
    const paste = `${BRACKETED_START}${asTerminalPaste(makeIdeaFixture({ lines: 400 }))}${BRACKETED_END}`;
    const half = Math.floor(paste.length / 2);
    const input = spyInput();
    const pending = readIdeaFromTerminal(input, sink().out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
    await writeChunks(input, [paste.slice(0, half), '\x03', ...shred(paste.slice(half))]);
    expect(await pending).toBeNull();
    expect(input.rawCalls.at(-1)).toBe(false);
    expect(unreadBytes(input)).toBe(0);
  });

  it('Ctrl+C con el pegado aún llegando en trozos con pausas de 50 ms: no queda ningún byte sin leer (4.9, R2, R15)', { timeout: 20_000 }, async () => {
    const paste = `${BRACKETED_START}${asTerminalPaste(makeIdeaFixture({ lines: 400 }))}${BRACKETED_END}`;
    const half = Math.floor(paste.length / 2);
    const kib = (text: string): string[] => Array.from({ length: Math.ceil(text.length / 1024) }, (_, i) => text.slice(i * 1024, (i + 1) * 1024));
    const input = spyInput();
    const screen = sink();
    const pending = readIdeaFromTerminal(input, screen.out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA });
    await writeChunks(input, kib(paste.slice(0, half)));
    input.write('\x03');
    await writeChunks(input, kib(paste.slice(half)), 50);
    expect(await pending).toBeNull();
    expect(unreadBytes(input)).toBe(0);
    expect(screen.text()).not.toContain('quedan bytes del pegado en la terminal');
  });

  it('si el pegado cancelado no termina antes del tope, avisa en pantalla y sale igual (tope de 5 s)', { timeout: 20_000 }, async () => {
    const input = spyInput();
    const screen = sink();
    const pending = readIdeaFromTerminal(input, screen.out, { message: 'm', maxBytes: DEFAULT_MAX_IDEA, drainCapMs: 400 });
    await writeChunks(input, [`${BRACKETED_START}primera parte\r`, '\x03']);
    const started = Date.now();
    let writing = true;
    const endless = (async () => {
      while (writing) {
        input.write('más texto del pegado que no termina\r');
        await sleep(50);
      }
    })();
    expect(await pending).toBeNull();
    writing = false;
    await endless;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(screen.text()).toContain('quedan bytes del pegado en la terminal');
    expect(input.rawCalls.at(-1)).toBe(false);
  });
});

// ─────────────────────────── Fase 5 — semilla y pre-prompt ───────────────────────────

function seedCtx(root: string, out: string[] = []): CliContext {
  return { cwd: root, root, source: null, io: { out: (line) => out.push(line), err: (line) => out.push(line) }, exec: fakeRunner().run };
}

const seedFile = (root: string): string => path.join(root, 'backlog', 'seed.md');
const ideaInSeed = (seed: string): string | null => {
  const section = seed.split('\n## Idea\n')[1];
  return section === undefined ? null : extractFencedIdea(section);
};

describe('idea-input fase 5 — semilla: fence, procedencia, colisión y migración (5.1)', () => {
  const idea = `## Motor CRDT\n\n${'`'.repeat(4)}md\n${'`'.repeat(3)}\nx\n${'`'.repeat(3)}\n${'`'.repeat(4)}\n${IDEA_SENTINEL}`;

  it('nuevo → escrito con fence, fecha y fuente; la idea se extrae exacta', async () => {
    const root = await ideaDir();
    const lines = await writeBacklogSeed(seedCtx(root), idea, 'archivo idea.md', new Date('2026-11-10T12:00:00Z'));
    // init-fiabilidad (SEED-01): IDEA.md se escribe junto al seed, en el mismo escritor.
    expect(lines).toEqual(['backlog: seed.md escrito', 'backlog: pre-prompt.md escrito', 'backlog: ejecuta backlog/pre-prompt.md en tu agente', 'backlog: IDEA.md escrito (fuente: backlog/seed.md)']);
    const seed = await fs.readFile(seedFile(root), 'utf8');
    expect(seed).toContain('el 2026-11-10 desde archivo idea.md');
    expect(seed.match(/^## Idea$/gm)).toHaveLength(1);
    const fenceLine = seed.split('\n').findIndex((line) => /^`{3,}markdown$/.test(line));
    expect(fenceLine).toBeGreaterThan(seed.split('\n').indexOf('## Idea'));
    expect(seed.split('\n').indexOf('## Motor CRDT')).toBeGreaterThan(fenceLine);
    expect(seed.split('\n')[fenceLine]).toBe(`${'`'.repeat(5)}markdown`);
    expect(ideaInSeed(seed)).toBe(idea);
    expect(lines.join('\n')).not.toContain(IDEA_SENTINEL);
  });

  it('misma idea otro día → idéntico byte a byte y "sin cambios"', async () => {
    const root = await ideaDir();
    await writeBacklogSeed(seedCtx(root), idea, 'archivo idea.md', new Date('2026-11-10T12:00:00Z'));
    const before = await fs.readFile(seedFile(root));
    const lines = await writeBacklogSeed(seedCtx(root), idea, 'archivo idea.md', new Date('2026-12-01T12:00:00Z'));
    expect(lines[0]).toBe('backlog: seed.md sin cambios');
    expect(await fs.readFile(seedFile(root))).toEqual(before);
  });

  it('con fence y editado → idéntico y colisión (salida sin error)', async () => {
    const root = await ideaDir();
    await writeBacklogSeed(seedCtx(root), idea, 'tu editor');
    const edited = (await fs.readFile(seedFile(root), 'utf8')).replace(IDEA_SENTINEL, 'texto que cambió la persona');
    await fs.writeFile(seedFile(root), edited);
    const lines = await writeBacklogSeed(seedCtx(root), idea, 'tu editor');
    expect(lines[0]).toBe('backlog: seed.md existe y difiere; no se sobrescribió');
    expect(await fs.readFile(seedFile(root), 'utf8')).toBe(edited);
  });

  it('seeds reales de 0.13.0 con la misma idea → migran al formato con fence (también la que empieza por ##)', async () => {
    for (const name of ['seed-normal', 'seed-heading']) {
      const root = await ideaDir();
      await fs.mkdir(path.join(root, 'backlog'));
      await fs.copyFile(path.join(FIXTURES, `${name}.md`), seedFile(root));
      const legacyIdea = await fs.readFile(path.join(FIXTURES, `${name}.idea.txt`), 'utf8');
      const lines = await writeBacklogSeed(seedCtx(root), legacyIdea, 'pegado en el asistente');
      expect(lines[0]).toBe('backlog: seed.md migrado al formato con fence');
      expect(ideaInSeed(await fs.readFile(seedFile(root), 'utf8'))).toBe(legacyIdea);
    }
  });

  it('seed de 0.13.0 editado, con una sección añadida o con otra idea → idéntico y colisión', async () => {
    const legacy = await fs.readFile(path.join(FIXTURES, 'seed-normal.md'), 'utf8');
    const legacyIdea = await fs.readFile(path.join(FIXTURES, 'seed-normal.idea.txt'), 'utf8');
    const cases: Array<[string, string]> = [
      [legacy.replace('veterinarias', 'dentales'), legacyIdea],
      [`${legacy}\n## Notas\n\nañadidas por la persona\n`, legacyIdea],
      [legacy, 'otra idea distinta'],
    ];
    for (const [content, newIdea] of cases) {
      expect(classifySeed(content, newIdea)).toBe('collision');
      const root = await ideaDir();
      await fs.mkdir(path.join(root, 'backlog'));
      await fs.writeFile(seedFile(root), content);
      const lines = await writeBacklogSeed(seedCtx(root), newIdea, 'archivo idea.md');
      expect(lines[0]).toBe('backlog: seed.md existe y difiere; no se sobrescribió');
      expect(await fs.readFile(seedFile(root), 'utf8')).toBe(content);
    }
  });

  it('renderSeed y classifySeed son coherentes: un seed recién escrito se clasifica "sin cambios"', () => {
    expect(classifySeed(renderSeed(idea, 'entrada estándar'), idea)).toBe('unchanged');
    expect(classifySeed(renderSeed(idea, 'entrada estándar'), `${idea} más`)).toBe('collision');
  });
});

describe('idea-input fase 5 — pre-prompt con tres vías sobre .scaffold.json (5.2, D13)', () => {
  const NEW_TEMPLATE = `${PRE_PROMPT}\n<!-- plantilla nueva simulada -->\n`;
  const prePromptFile = (root: string): string => path.join(root, 'backlog', 'pre-prompt.md');

  it('PRE_PROMPT_HISTORY tiene la plantilla actual y la histórica de 0.7.0–0.10.0', async () => {
    const legacy = await fs.readFile(fileURLToPath(new URL('./fixtures/idea-0.7.0/pre-prompt.md', import.meta.url)));
    const recorded = (await fs.readFile(fileURLToPath(new URL('./fixtures/idea-0.7.0/pre-prompt.sha256', import.meta.url)), 'utf8')).trim();
    expect(sha(legacy)).toBe(recorded);
    expect(PRE_PROMPT_HISTORY).toContain(sha(PRE_PROMPT));
    expect(PRE_PROMPT_HISTORY).toContain(recorded);
    expect(new Set(PRE_PROMPT_HISTORY).size).toBe(2);
  });

  it('un pre-prompt de 0.7.0 sin editar y sin registrar se actualiza a la plantilla actual', async () => {
    const root = await ideaDir();
    await fs.mkdir(path.join(root, 'backlog'));
    await fs.copyFile(fileURLToPath(new URL('./fixtures/idea-0.7.0/pre-prompt.md', import.meta.url)), prePromptFile(root));
    expect(await refreshTemplateFile(root, 'backlog/pre-prompt.md', PRE_PROMPT, 'engine:backlog/pre-prompt.md', PRE_PROMPT_HISTORY)).toBe('updated');
    expect(await fs.readFile(prePromptFile(root), 'utf8')).toBe(PRE_PROMPT);
  });

  it('un pre-prompt de 0.13.0 sin editar y sin registrar se actualiza y queda registrado', async () => {
    const root = await ideaDir();
    await fs.mkdir(path.join(root, 'backlog'));
    await fs.copyFile(path.join(FIXTURES, 'pre-prompt.md'), prePromptFile(root));
    expect((await readScaffold(root)).files['backlog/pre-prompt.md']).toBeUndefined();
    const state = await refreshTemplateFile(root, 'backlog/pre-prompt.md', NEW_TEMPLATE, 'engine:backlog/pre-prompt.md', PRE_PROMPT_HISTORY);
    expect(state).toBe('updated');
    expect(await fs.readFile(prePromptFile(root), 'utf8')).toBe(NEW_TEMPLATE);
    expect((await readScaffold(root)).files['backlog/pre-prompt.md']).toEqual({ sha256: sha(NEW_TEMPLATE), source: 'engine:backlog/pre-prompt.md' });
  });

  it('un pre-prompt editado no se toca (colisión); uno intacto e igual se conserva', async () => {
    const root = await ideaDir();
    await fs.mkdir(path.join(root, 'backlog'));
    await fs.writeFile(prePromptFile(root), `${PRE_PROMPT}\nnota de la persona\n`);
    expect(await refreshTemplateFile(root, 'backlog/pre-prompt.md', NEW_TEMPLATE, 'engine:backlog/pre-prompt.md', PRE_PROMPT_HISTORY)).toBe('collision');
    expect(await fs.readFile(prePromptFile(root), 'utf8')).toBe(`${PRE_PROMPT}\nnota de la persona\n`);

    const intact = await ideaDir();
    expect(await refreshTemplateFile(intact, 'backlog/pre-prompt.md', PRE_PROMPT, 'engine:backlog/pre-prompt.md', PRE_PROMPT_HISTORY)).toBe('written');
    expect(await refreshTemplateFile(intact, 'backlog/pre-prompt.md', PRE_PROMPT, 'engine:backlog/pre-prompt.md', PRE_PROMPT_HISTORY)).toBe('kept');
    expect(await refreshTemplateFile(intact, 'backlog/pre-prompt.md', NEW_TEMPLATE, 'engine:backlog/pre-prompt.md', PRE_PROMPT_HISTORY)).toBe('updated');
  });
});

describe('idea-input fase 5 — documentación (5.7, D8)', () => {
  const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));
  const read = (relative: string): Promise<string> => fs.readFile(path.join(CORE_DIR, relative), 'utf8');

  it('core/README.md documenta las cuatro fuentes, los terminadores, el límite y conhost', async () => {
    const readme = await read('README.md');
    expect(readme).toContain('### Idea del proyecto');
    for (const needle of ['--idea-file', '--idea-stdin', '--idea-editor', 'AI_HUB_MAX_IDEA', 'Ctrl+E', 'Ctrl+D', 'bracketed paste', 'conhost']) {
      expect(readme).toContain(needle);
    }
    expect(readme).toContain('para textos de más de ~64 KiB usa **Ctrl+E** o `--idea-file`');
    expect(readme).toContain('El límite de 4 MiB es de memoria, no de pegado');
  });

  it('SECURITY.md recoge la vulnerabilidad desde 0.7.0, su mitigación y la superficie nueva', async () => {
    const security = await read('SECURITY.md');
    expect(security).toContain('## Known vulnerabilities');
    expect(security).toContain('(since 0.7.0)');
    expect(security).toContain('0.7.0–0.13.0');
    expect(security).toContain('type the idea by hand');
    expect(security).toContain('Bracketed paste is enabled');
    expect(security).toContain('for texts above ~64 KiB use Ctrl+E or `--idea-file`');
    expect(security).toContain('the 4 MiB limit is a memory limit, not a paste limit');
    expect(security).toContain('**Residual risk after the fix (cancelling a paste mid-way).**');
    expect(security).toContain('`quedan bytes del pegado en la terminal`');
  });

  it('el README del taller y el CHANGELOG llevan el aviso y el arreglo', async () => {
    const workshop = await read('../README.md');
    const changelog = await read('../CHANGELOG.md');
    expect(workshop).toContain('Aviso de seguridad (0.7.0–0.13.0)');
    expect(changelog).toMatch(/^## (?:\d+\.\d+\.\d+ — idea-input|Sin publicar — idea-input)/m);
    expect(changelog).toContain('**Mitigación en versiones anteriores:**');
  });
});
