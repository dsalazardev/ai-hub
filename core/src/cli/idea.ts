import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * idea-input: captura de la idea del proyecto. Cuatro fuentes con un único contrato: archivo, entrada estándar,
 * editor de la persona y entrada multilínea del asistente. La idea nunca entra al plan, al lock, al manifiesto, a
 * `runs` ni a ningún mensaje: los errores nombran la fuente, el tamaño o la ruta, jamás el texto (design D12).
 */

/** Límite por defecto (design D4): 4 MiB de UTF-8 tras normalizar. Se ajusta con `AI_HUB_MAX_IDEA` (bytes). */
export const DEFAULT_MAX_IDEA = 4 * 1024 * 1024;
export const MAX_IDEA_ENV = 'AI_HUB_MAX_IDEA';

export type IdeaSourceKind = 'file' | 'stdin' | 'editor' | 'paste';

/** Resultado de una fuente: una idea normalizada o «saltar» (vacío). */
export type IdeaOutcome =
  | { kind: 'idea'; text: string; source: IdeaSourceKind; note: string }
  | { kind: 'skip'; source: IdeaSourceKind };

/** Error de una fuente: init sale con 2 antes de escribir nada. El mensaje nunca contiene la idea. */
export class IdeaInputError extends Error {
  readonly exitCode = 2;
}

/** Límite efectivo; un valor de `AI_HUB_MAX_IDEA` que no es un entero positivo es un error que nombra la variable. */
export function maxIdeaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_IDEA_ENV];
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_IDEA;
  }
  if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) <= 0 || !Number.isSafeInteger(Number(raw.trim()))) {
    throw new IdeaInputError(`${MAX_IDEA_ENV} debe ser un entero positivo de bytes (valor recibido no válido)`);
  }
  return Number(raw.trim());
}

/** Error de límite: nombra la variable y sugiere `--idea-file`. Nunca trunca. */
export function overLimit(bytes: number, max: number, origin: string): IdeaInputError {
  return new IdeaInputError(
    `${origin}: la idea ocupa ${bytes} bytes y el límite es ${max} (ajústalo con ${MAX_IDEA_ENV}); ` +
      'no se truncó ni se escribió nada. Para textos largos usa --idea-file <ruta>',
  );
}

const DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Normalización única de las cuatro fuentes (design D6): fuera el BOM inicial, CRLF y CR → LF, fuera los saltos
 * finales. Nada más se toca. Rechaza el byte NUL y el UTF-8 inválido. Idempotente.
 */
export function normalizeIdea(raw: Buffer | string, origin: string): string {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    if (raw.includes(0)) {
      throw new IdeaInputError(`${origin}: contenido binario (byte NUL); la idea debe ser texto UTF-8`);
    }
    try {
      text = DECODER.decode(raw);
    } catch {
      throw new IdeaInputError(`${origin}: no es UTF-8 válido; guarda la idea como texto UTF-8`);
    }
  }
  if (text.includes('\0')) {
    throw new IdeaInputError(`${origin}: contenido binario (byte NUL); la idea debe ser texto UTF-8`);
  }
  if (text.startsWith('﻿')) {
    text = text.slice(1);
  }
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/** Vacío o solo espacios equivale a saltar el paso. */
export function isBlankIdea(text: string): boolean {
  return text.trim() === '';
}

function outcome(text: string, source: IdeaSourceKind, note: string, max: number, origin: string): IdeaOutcome {
  if (isBlankIdea(text)) {
    return { kind: 'skip', source };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > max) {
    throw overLimit(bytes, max, origin);
  }
  return { kind: 'idea', text, source, note };
}

/**
 * Tope de lectura en bruto: la normalización puede encoger el texto (CRLF → LF, BOM), así que se leen como mucho
 * `2·max + 3` bytes; un archivo mayor ya excede el límite tras normalizar y se rechaza sin cargarlo en memoria.
 */
function rawCap(max: number): number {
  return 2 * max + 3;
}

/** `--idea-file <ruta>`: relativa a `cwd`. Ruta inexistente, directorio, binario o UTF-8 inválido → 2. */
export async function ideaFromFile(file: string, options: { cwd: string; maxBytes: number }): Promise<IdeaOutcome> {
  const absolute = path.resolve(options.cwd, file);
  const origin = `--idea-file ${file}`;
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new IdeaInputError(`${origin}: la ruta no existe o no se puede leer`);
  }
  if (stat.isDirectory()) {
    throw new IdeaInputError(`${origin}: es un directorio; indica un archivo de texto`);
  }
  if (!stat.isFile()) {
    throw new IdeaInputError(`${origin}: no es un archivo regular`);
  }
  if (stat.size > rawCap(options.maxBytes)) {
    throw overLimit(stat.size, options.maxBytes, origin);
  }
  const raw = await fs.readFile(absolute);
  const text = normalizeIdea(raw, origin);
  return outcome(text, 'file', `archivo ${path.basename(absolute)}`, options.maxBytes, origin);
}

/** Entrada estándar inyectable: `isTTY` y los trozos hasta EOF. */
export interface IdeaStdin {
  isTTY: boolean;
  chunks(): AsyncIterable<Buffer | string>;
}

export function processIdeaStdin(): IdeaStdin {
  return { isTTY: process.stdin.isTTY === true, chunks: () => process.stdin };
}

export const STDIN_PIPE_HELP =
  '--idea-stdin lee la idea de una tubería y la entrada estándar es una terminal. Ejemplos: ' +
  '`cat idea.md | npx ai-hub init --yes --idea-stdin` (bash) o ' +
  '`Get-Content idea.md -Raw | npx ai-hub init --yes --idea-stdin` (PowerShell); o usa --idea-file idea.md';

/** `--idea-stdin`: hasta EOF con la misma normalización y límite; sin tubería (TTY) → 2. */
export async function ideaFromStdin(stdin: IdeaStdin, options: { maxBytes: number }): Promise<IdeaOutcome> {
  if (stdin.isTTY) {
    throw new IdeaInputError(STDIN_PIPE_HELP);
  }
  const cap = rawCap(options.maxBytes);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin.chunks()) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buffer.length;
    if (size > cap) {
      throw overLimit(size, options.maxBytes, '--idea-stdin');
    }
    parts.push(buffer);
  }
  const text = normalizeIdea(Buffer.concat(parts), '--idea-stdin');
  return outcome(text, 'stdin', 'entrada estándar', options.maxBytes, '--idea-stdin');
}

/** La racha más larga de backticks seguidos en el texto. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

/**
 * Fence dinámico (design D6): N = max(3, racha más larga + 1). CommonMark solo cierra un fence de backticks con
 * una racha de al menos N, así que la idea nunca lo cierra. Exactamente un LF antes del cierre.
 */
export function fenceIdea(idea: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(idea) + 1));
  return `${fence}markdown\n${idea}\n${fence}`;
}

/**
 * Extrae la idea de un bloque con fence: busca la primera línea de apertura (≥ 3 backticks + `markdown`) y su
 * cierre con la misma longitud exacta y nada detrás. `null` si no hay un bloque bien formado.
 */
export function extractFencedIdea(markdown: string): string | null {
  const lines = markdown.split('\n');
  const open = lines.findIndex((line) => /^`{3,}markdown$/.test(line));
  if (open < 0) {
    return null;
  }
  const fence = /^(`+)/.exec(lines[open])?.[1] ?? '';
  const close = lines.findIndex((line, index) => index > open && line === fence);
  if (close < 0) {
    return null;
  }
  return lines.slice(open + 1, close).join('\n');
}

/** Flags de idea de `init`, en orden de precedencia (design D3, R8). */
export const IDEA_FLAGS = ['idea-file', 'idea-stdin', 'idea-editor'] as const;
type IdeaFlag = (typeof IDEA_FLAGS)[number];


/**
 * Elige una sola fuente: `--idea-file` > `--idea-stdin` > `--idea-editor`. Con más de una, una línea nombra la
 * usada y las ignoradas. Nunca se combinan.
 */
export function selectIdeaSource(flags: Record<string, string | boolean>): {
  flag: IdeaFlag | null;
  ignored: IdeaFlag[];
  notice: string | null;
} {
  const given = IDEA_FLAGS.filter((name) => flags[name] !== undefined && flags[name] !== false);
  if (given.length === 0) {
    return { flag: null, ignored: [], notice: null };
  }
  const [flag, ...ignored] = given;
  const notice = ignored.length > 0 ? `idea: se usa --${flag}; se ignora ${ignored.map((name) => `--${name}`).join(' y ')}` : null;
  return { flag, ignored, notice };
}

export interface IdeaDeps {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: IdeaStdin;
  /** Fuente del editor (fase 3): abre el editor de la persona sobre un temporal fuera del repositorio. */
  editor?: (maxBytes: number) => Promise<IdeaOutcome>;
}

/**
 * Resuelve la idea desde los flags de `init`, antes de cualquier escritura. `null` = no se pidió ninguna fuente.
 * Errores → `IdeaInputError` (salida 2). `--idea-stdin` junto a `--discord-token-stdin` → 2 antes de leer (D11).
 */
export async function resolveIdeaFromFlags(
  flags: Record<string, string | boolean>,
  deps: IdeaDeps,
): Promise<{ outcome: IdeaOutcome | null; notice: string | null }> {
  if (flags['idea-stdin'] !== undefined && flags['idea-stdin'] !== false && flags['discord-token-stdin']) {
    throw new IdeaInputError(
      '--idea-stdin y --discord-token-stdin no pueden compartir la entrada estándar: el token es lo único que viaja ' +
        'por ella. Pasa la idea con --idea-file <ruta>; no se escribió nada',
    );
  }
  const { flag, notice } = selectIdeaSource(flags);
  if (flag === null) {
    return { outcome: null, notice: null };
  }
  const maxBytes = maxIdeaBytes(deps.env);
  if (flag === 'idea-file') {
    const value = flags['idea-file'];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new IdeaInputError('--idea-file necesita una ruta: --idea-file <ruta> (o --idea-file=<ruta>)');
    }
    return { outcome: await ideaFromFile(value, { cwd: deps.cwd, maxBytes }), notice };
  }
  if (flag === 'idea-stdin') {
    return { outcome: await ideaFromStdin(deps.stdin ?? processIdeaStdin(), { maxBytes }), notice };
  }
  if (!deps.editor) {
    throw new IdeaInputError('--idea-editor no está disponible en este contexto; usa --idea-file <ruta>');
  }
  return { outcome: await deps.editor(maxBytes), notice };
}

/** Resumen de una línea, sin el texto (design D3/D12): `idea: archivo idea.md, N líneas · M caracteres`. */
export function describeIdea(outcome: IdeaOutcome): string {
  if (outcome.kind === 'skip') {
    return `idea: ${KIND_OF_LABEL[outcome.source]} vacía; se salta el paso`;
  }
  const lines = outcome.text.split('\n').length;
  return `idea: ${outcome.note}, ${lines} líneas · ${[...outcome.text].length} caracteres`;
}

const KIND_OF_LABEL: Record<IdeaSourceKind, string> = {
  file: 'archivo',
  stdin: 'entrada estándar',
  editor: 'editor',
  paste: 'entrada',
};

/** Cancelación de la persona (Ctrl+C, Esc): init imprime el mensaje de cancelación y no escribe nada (R15). */
export class IdeaCancelled extends Error {
  constructor() {
    super('cancelado por la persona');
  }
}

// ───────────────────────────── Editor externo (design D7) ─────────────────────────────

export interface EditorSpawnResult {
  code: number | null;
  /** Ctrl+C mientras el editor estaba abierto. */
  interrupted: boolean;
}

/** Host del editor: inyectable en los tests (plataforma, PATH, lanzamiento y confirmación). */
export interface EditorHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  root: string;
  isTTY: boolean;
  tmpdir: string;
  onPath(command: string): Promise<boolean>;
  spawn(command: string, args: string[]): Promise<EditorSpawnResult>;
  /** «Guarda y cierra…»: `true` = leer el archivo; `null` = cancelar (Esc o Ctrl+C). */
  confirmClosed(message: string): Promise<boolean | null>;
}

export interface ResolvedEditor {
  command: string;
  args: string[];
  gui: boolean;
  origin: 'VISUAL' | 'EDITOR' | 'fallback';
}

/** Separa una línea de comando al estilo shell (comillas simples y dobles), sin expandir nada. */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        parts.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) {
    parts.push(current);
  }
  return parts;
}

/** Nombre base del ejecutable, sin extensión de Windows y en minúsculas. */
export function editorName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

const GUI_EDITORS = new Set(['notepad', 'notepad++', 'sublime_text']);
const CODE_EDITORS = new Set(['code', 'code-insiders']);

/** Lista GUI conocida (D7): Notepad, Notepad++, Sublime Text, o VS Code sin `--wait`/`-w`. */
export function isGuiEditor(command: string, args: readonly string[]): boolean {
  const name = editorName(command);
  if (GUI_EDITORS.has(name)) {
    return true;
  }
  return CODE_EDITORS.has(name) && !args.includes('--wait') && !args.includes('-w');
}

/** `$VISUAL` > `$EDITOR` > `code --wait` si está en el PATH > Notepad (Windows) o `vi` (POSIX). */
export async function resolveEditor(host: EditorHost): Promise<ResolvedEditor> {
  for (const key of ['VISUAL', 'EDITOR'] as const) {
    const value = host.env[key]?.trim();
    if (value) {
      const [command, ...args] = splitCommandLine(value);
      if (command) {
        return { command, args, gui: isGuiEditor(command, args), origin: key };
      }
    }
  }
  if (await host.onPath('code')) {
    return { command: 'code', args: ['--wait'], gui: false, origin: 'fallback' };
  }
  if (host.platform === 'win32') {
    return { command: 'notepad', args: [], gui: true, origin: 'fallback' };
  }
  return { command: 'vi', args: [], gui: false, origin: 'fallback' };
}

export const EDITOR_CONFIRM = 'Guarda y cierra el editor; pulsa Enter para leer el archivo (Esc cancela)';

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Fuente del editor (R7): archivo temporal vacío fuera del repositorio, el editor de la persona y la espera a que
 * salga. Solo si el editor está en la lista GUI **y** salió con el archivo sin cambios se pide confirmación antes de
 * leer (Notepad de Windows 11 vuelve al instante). El temporal se borra en toda salida.
 */
export async function ideaFromEditor(host: EditorHost, maxBytes: number): Promise<IdeaOutcome> {
  if (!host.isTTY) {
    throw new IdeaInputError(
      '--idea-editor necesita una terminal para abrir tu editor; sin terminal usa --idea-file <ruta> o --idea-stdin',
    );
  }
  const editor = await resolveEditor(host);
  const dir = await fs.mkdtemp(path.join(host.tmpdir, 'ai-hub-idea-'));
  try {
    if (insideRoot(host.root, dir)) {
      throw new IdeaInputError('el temporal del editor cae dentro del repositorio; define TMPDIR/TEMP fuera de él o usa --idea-file');
    }
    const file = path.join(dir, 'idea.md');
    await fs.writeFile(file, '');
    const before = await fs.stat(file);
    const result = await host.spawn(editor.command, [...editor.args, file]);
    if (result.interrupted) {
      throw new IdeaCancelled();
    }
    if (result.code !== 0) {
      throw new IdeaInputError(
        `el editor (${editorName(editor.command)}) salió con código ${result.code ?? 'sin código'}; no se escribió nada`,
      );
    }
    if (editor.gui) {
      const after = await fs.stat(file);
      if (after.mtimeMs === before.mtimeMs && after.size === before.size) {
        if ((await host.confirmClosed(EDITOR_CONFIRM)) !== true) {
          throw new IdeaCancelled();
        }
      }
    }
    const stat = await fs.stat(file);
    if (stat.size > rawCap(maxBytes)) {
      throw overLimit(stat.size, maxBytes, 'editor');
    }
    const text = normalizeIdea(await fs.readFile(file), 'editor');
    return outcome(text, 'editor', 'tu editor', maxBytes, 'editor');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ─────────────────────────── Entrada multilínea (design D1, D2, D10) ───────────────────────────

export const BRACKETED_ON = '\x1b[?2004h';
export const BRACKETED_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Una sola línea de ayuda (D2, confirmada por el propietario). */
export const IDEA_HELP = 'Ctrl+D o "." para terminar · vacío = saltar · Esc cancela todo · Ctrl+E abre tu editor';

/** 4.9: se imprime si una cancelación a mitad de pegado sale del drenado sin ver el fin del pegado. */
export const PASTE_LEFTOVER_WARNING = 'quedan bytes del pegado en la terminal';

export type ReaderSignal =
  | { type: 'continue' }
  /** Terminador candidato al final del trozo: el envoltorio lo confirma con la ventana de silencio (D10). */
  | { type: 'terminate' }
  | { type: 'cancel' }
  | { type: 'editor' }
  /** El trozo terminó en un ESC suelto: el envoltorio espera 50 ms para distinguir Esc de una secuencia. */
  | { type: 'escape-pending' };

export interface ReaderStats {
  lines: number;
  chars: number;
  tail: string[];
  inPaste: boolean;
  sawBracketed: boolean;
  overflow: boolean;
}

export type ReaderResult = { kind: 'text'; text: string } | { kind: 'skip' } | { kind: 'overflow'; bytes: number };

export interface IdeaReader {
  feed(chunk: string): ReaderSignal;
  /** Lo que quedó sin procesar del trozo en el que llegó Ctrl+C (vacío si no hubo cancelación). */
  cancelRest(): string;
  resolveEscape(): ReaderSignal;
  revokeTerminator(): void;
  result(): ReaderResult;
  stats(): ReaderStats;
}

/**
 * Máquina de estados pura del lector (D1): no toca la TTY ni `process`. Ningún salto de línea termina la entrada
 * (R1); solo Ctrl+D o una línea tecleada con solo `.`, y dentro de un bracketed paste ninguno de los dos. Backspace
 * solo en la línea en curso. Las secuencias CSI/SS3 se descartan; Ctrl+C cancela; Ctrl+E pide el editor.
 */
export function createIdeaReader(maxBytes: number): IdeaReader {
  const lines: string[] = [];
  let current = '';
  let chars = 0;
  let bytes = 0;
  let overflow = false;
  let inPaste = false;
  let sawBracketed = false;
  let escape: string | null = null;
  let lastCR = false;
  let candidate: 'eof' | 'dot' | null = null;
  let rest = '';

  const append = (char: string): void => {
    const size = Buffer.byteLength(char, 'utf8');
    bytes += size;
    if (overflow || bytes > maxBytes) {
      overflow = true;
      return;
    }
    current += char;
    chars += 1;
  };
  const newline = (): void => {
    bytes += 1;
    if (overflow || bytes > maxBytes) {
      overflow = true;
      return;
    }
    lines.push(current);
    current = '';
    chars += 1;
  };
  const revoke = (): void => {
    if (candidate === 'dot') {
      newline();
    }
    candidate = null;
  };
  const handleEscape = (char: string): void => {
    escape = `${escape ?? ''}${char}`;
    if (escape === PASTE_START) {
      inPaste = true;
      sawBracketed = true;
      escape = null;
      return;
    }
    if (escape === PASTE_END) {
      inPaste = false;
      escape = null;
      return;
    }
    if (escape.length === 2) {
      if (char !== '[' && char !== 'O') {
        escape = null; // Alt+tecla: se descarta
      }
      return;
    }
    if (escape.startsWith('\x1bO')) {
      escape = null; // SS3 (F1–F4, flechas en modo aplicación)
      return;
    }
    const code = char.charCodeAt(0);
    if ((code >= 0x40 && code <= 0x7e) || escape.length > 32) {
      escape = null; // fin de CSI (flechas, Supr…): sin efecto
    }
  };

  const feed = (chunk: string): ReaderSignal => {
    let offset = 0;
    for (const char of chunk) {
      offset += char.length;
      if (candidate !== null) {
        revoke(); // llegaron bytes detrás del terminador en el mismo trozo: era contenido (D10)
      }
      if (escape !== null) {
        handleEscape(char);
        continue;
      }
      if (char === '\x1b') {
        escape = char;
        continue;
      }
      if (char === '\x03') {
        // 4.9: lo que queda del trozo tras Ctrl+C no se procesa, pero puede traer el fin del pegado; el drenado
        // de la cancelación empieza por ese resto.
        rest = chunk.slice(offset);
        if (inPaste && rest.includes(PASTE_END)) {
          inPaste = false;
        }
        return { type: 'cancel' };
      }
      if (inPaste) {
        if (char === '\r') {
          newline();
          lastCR = true;
          continue;
        }
        if (char === '\n') {
          if (!lastCR) {
            newline();
          }
          lastCR = false;
          continue;
        }
        lastCR = false;
        if (char === '\t' || char.charCodeAt(0) >= 0x20) {
          append(char);
        }
        continue;
      }
      if (char === '\n' && lastCR) {
        lastCR = false;
        continue;
      }
      lastCR = char === '\r';
      if (char === '\r' || char === '\n') {
        if (current === '.' && !overflow) {
          candidate = 'dot';
        } else {
          newline();
        }
        continue;
      }
      if (char === '\x04') {
        candidate = 'eof';
        continue;
      }
      if (char === '\x05') {
        return { type: 'editor' };
      }
      if (char === '\x7f' || char === '\b') {
        if (current.length > 0 && !overflow) {
          const removed = [...current].pop() ?? '';
          current = current.slice(0, current.length - removed.length);
          chars -= 1;
          bytes -= Buffer.byteLength(removed, 'utf8');
        }
        continue;
      }
      if (char === '\t' || char.charCodeAt(0) >= 0x20) {
        append(char);
      }
    }
    if (escape === '\x1b') {
      return { type: 'escape-pending' };
    }
    return candidate !== null ? { type: 'terminate' } : { type: 'continue' };
  };

  return {
    feed,
    cancelRest: () => rest,
    resolveEscape: () => {
      escape = null;
      return { type: 'cancel' };
    },
    revokeTerminator: revoke,
    result: () => {
      if (overflow) {
        return { kind: 'overflow', bytes };
      }
      const parts = candidate === 'dot' ? lines : [...lines, current];
      const text = parts.join('\n').replace(/\n+$/, '');
      return isBlankIdea(text) ? { kind: 'skip' } : { kind: 'text', text };
    },
    stats: () => {
      const all = [...lines.slice(-3), current];
      return { lines: lines.length + 1, chars, tail: all.slice(-3), inPaste, sawBracketed, overflow };
    },
  };
}

/** Streams del lector: en producción `process.stdin`/`process.stdout`; en los tests, falsos. */
export interface TerminalInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface TerminalOutput {
  write(chunk: string): unknown;
  columns?: number;
}

export interface ReadIdeaOptions {
  message: string;
  maxBytes: number;
  /** Ctrl+E: abre el editor; su resultado sustituye lo escrito y la entrada termina. */
  editor?: () => Promise<IdeaOutcome>;
  quietMs?: number;
  escapeMs?: number;
  renderMs?: number;
  /** Tope del drenado final, por si la entrada no se calla nunca (5 s). */
  drainCapMs?: number;
  /** Silencio que da por cerrado un pegado abierto tras cancelar, si no llega `\x1b[201~` (1 s). */
  pasteQuietMs?: number;
}

function displayLine(line: string, width: number): string {
  const clean = line.replace(/[\x00-\x1f\x7f]/g, ' ');
  const points = [...clean];
  return points.length > width ? `${points.slice(0, Math.max(1, width - 1)).join('')}…` : clean;
}

/**
 * Lector de la idea sobre una TTY (D1, R1–R3, R15): raw mode y bracketed paste activados, restaurados en toda
 * salida (terminador, Ctrl+C, Esc, editor o excepción), render acotado (contador + últimas 3 líneas) y drenado
 * de la entrada antes de devolver, para que ningún byte llegue al prompt siguiente ni al shell. `null` = cancelar.
 */
export async function readIdeaFromTerminal(
  input: TerminalInput,
  output: TerminalOutput,
  options: ReadIdeaOptions,
): Promise<IdeaOutcome | null> {
  const quietMs = options.quietMs ?? 30;
  const escapeMs = options.escapeMs ?? 50;
  const renderMs = options.renderMs ?? 50;
  const drainCapMs = options.drainCapMs ?? 5_000;
  const pasteQuietMs = options.pasteQuietMs ?? 1_000;
  const width = Math.max(20, (output.columns ?? 80) - 4);
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  const onData = (data: Buffer | string): void => {
    queue.push(typeof data === 'string' ? data : data.toString('utf8'));
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  /** Siguiente trozo, o `null` si en `timeoutMs` no llega nada. */
  const next = (timeoutMs?: number): Promise<string | null> => {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift() ?? null);
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      wake = () => {
        clearTimeout(timer);
        resolve(queue.shift() ?? null);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          wake = null;
          resolve(null);
        }, timeoutMs);
      }
    });
  };
  let attached = false;
  const restore = (): void => {
    if (!attached) {
      return;
    }
    attached = false;
    // Cada paso por separado: un fallo al escribir no puede dejar la terminal en raw mode.
    try {
      output.write(BRACKETED_OFF);
    } catch {
      // la salida falló; el resto de la restauración sigue
    }
    try {
      input.setRawMode?.(false);
    } finally {
      input.removeListener('data', onData);
      input.pause?.();
    }
  };
  /**
   * Drenado antes de devolver (D10). Sin pegado abierto: hasta una ventana de silencio corta (`quietMs`).
   * Con un bracketed paste abierto (cancelación a mitad, 4.9): sigue consumiendo hasta `\x1b[201~` —aunque el terminal
   * lo entregue con pausas— con una ventana de silencio larga (`pasteQuietMs`) y un tope (`drainCapMs`, 5 s). Si sale
   * sin ver la marca, avisa en pantalla y sale igual: un pegado de 1 MiB cancelado a mitad tardaría ~70 s en
   * drenarse en Windows, y bloquear a la persona tanto no es aceptable. `seed` es el resto del trozo de la cancelación.
   */
  const drain = async (untilPasteEnds: boolean, seed = ''): Promise<void> => {
    const deadline = Date.now() + drainCapMs;
    if (untilPasteEnds) {
      let tail = seed.slice(-(PASTE_END.length - 1));
      let closed = false;
      while (!closed) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        const chunk = await next(Math.min(pasteQuietMs, remaining));
        if (chunk === null) {
          break;
        }
        const joined = tail + chunk;
        closed = joined.includes(PASTE_END);
        tail = joined.slice(-(PASTE_END.length - 1));
      }
      if (!closed) {
        try {
          output.write(`│  ${PASTE_LEFTOVER_WARNING}\n`);
        } catch {
          // la salida falló; la restauración sigue en el finally
        }
        return;
      }
    }
    while (Date.now() < deadline) {
      if ((await next(quietMs)) === null) {
        return;
      }
    }
  };

  let rendered = false;
  let lastRender = 0;
  let trailing: NodeJS.Timeout | undefined;
  const render = (reader: IdeaReader, force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastRender < renderMs) {
      // Throttle con render diferido: el último trozo de un pegado se muestra aunque no llegue otra tecla.
      trailing ??= setTimeout(() => {
        trailing = undefined;
        if (attached) {
          render(reader, true);
        }
      }, renderMs - (now - lastRender));
      return;
    }
    clearTimeout(trailing);
    trailing = undefined;
    lastRender = now;
    const stats = reader.stats();
    const warning = !stats.sawBracketed && stats.lines > 20 ? ' · pegado sin protección: usa Ctrl+E o --idea-file' : '';
    const tail = [...stats.tail];
    while (tail.length < 3) {
      tail.unshift('');
    }
    const block = [`│  ${stats.lines} líneas · ${stats.chars} caracteres${warning}`, ...tail.map((line) => `│  ${displayLine(line, width)}`)];
    output.write(`${rendered ? '\x1b[4F\x1b[J' : ''}${block.join('\n')}\n`);
    rendered = true;
  };

  process.once('exit', restore);
  input.setEncoding?.('utf8');
  input.setRawMode?.(true);
  input.on('data', onData);
  attached = true;
  input.resume?.();
  output.write(BRACKETED_ON);
  output.write(`◆  ${options.message}\n│  ${IDEA_HELP}\n`);
  try {
    let reader = createIdeaReader(options.maxBytes);
    render(reader, true);
    for (;;) {
      const chunk = await next();
      if (chunk === null) {
        continue;
      }
      let signal = reader.feed(chunk);
      for (;;) {
        if (signal.type === 'escape-pending') {
          const more = await next(escapeMs);
          signal = more === null ? reader.resolveEscape() : reader.feed(more);
          continue;
        }
        if (signal.type === 'terminate') {
          const more = await next(quietMs);
          if (more === null) {
            break;
          }
          reader.revokeTerminator();
          signal = reader.feed(more);
          continue;
        }
        break;
      }
      if (signal.type === 'cancel') {
        await drain(reader.stats().inPaste, reader.cancelRest());
        return null;
      }
      if (signal.type === 'editor') {
        if (!options.editor) {
          continue;
        }
        restore();
        try {
          return await options.editor();
        } catch (error) {
          if (error instanceof IdeaCancelled) {
            return null;
          }
          throw error;
        }
      }
      if (reader.stats().overflow && !reader.stats().inPaste && signal.type !== 'terminate') {
        await drain(false);
        const result = reader.result();
        output.write(
          `│  ${overLimit(result.kind === 'overflow' ? result.bytes : options.maxBytes + 1, options.maxBytes, 'entrada').message}\n`,
        );
        reader = createIdeaReader(options.maxBytes);
        rendered = false;
        render(reader, true);
        continue;
      }
      if (signal.type === 'terminate') {
        await drain(false);
        const result = reader.result();
        if (result.kind === 'overflow') {
          output.write(`│  ${overLimit(result.bytes, options.maxBytes, 'entrada').message}\n`);
          reader = createIdeaReader(options.maxBytes);
          rendered = false;
          render(reader, true);
          continue;
        }
        render(reader, true);
        if (result.kind === 'skip') {
          return { kind: 'skip', source: 'paste' };
        }
        return outcome(normalizeIdea(result.text, 'entrada'), 'paste', 'pegado en el asistente', options.maxBytes, 'entrada');
      }
      render(reader, false);
    }
  } finally {
    clearTimeout(trailing);
    restore();
    process.removeListener('exit', restore);
  }
}


// ─────────────────────────────── Host real del editor ───────────────────────────────

async function onSystemPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (await fs.access(candidate).then(() => true, () => false)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Una tecla en raw mode: Enter = leer, Esc o Ctrl+C = cancelar. */
function waitForEnter(message: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(`│  ${message}\n`);
    input.setRawMode?.(true);
    input.resume();
    const onData = (data: Buffer): void => {
      const key = data.toString('utf8');
      if (key.includes('\r') || key.includes('\n') || key.includes('\x1b') || key.includes('\x03')) {
        input.removeListener('data', onData);
        input.setRawMode?.(false);
        input.pause();
        resolve(key.includes('\r') || key.includes('\n') ? true : null);
      }
    };
    input.on('data', onData);
  });
}

/**
 * Host real: `spawn` sin shell y con `stdio: 'inherit'`; en Windows, un `.cmd`/`.bat` (VS Code es `code.cmd`) se
 * lanza con `cmd.exe /d /c`. Ctrl+C mientras el editor está abierto marca la cancelación en lugar de matar init.
 */
export function realEditorHost(root: string): EditorHost {
  const platform = process.platform;
  const env = process.env;
  return {
    platform,
    env,
    root,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    tmpdir: os.tmpdir(),
    onPath: async (command) => (await onSystemPath(command, env, platform)) !== null,
    spawn: async (command, args) => {
      let file = command;
      let argv = args;
      if (platform === 'win32') {
        const resolved = /[\/]/.test(command) ? command : await onSystemPath(command, env, platform);
        if (resolved !== null && /\.(cmd|bat)$/i.test(resolved)) {
          file = 'cmd.exe';
          argv = ['/d', '/c', /[\/]/.test(command) ? resolved : command, ...args];
        }
      }
      let interrupted = false;
      const onSigint = (): void => {
        interrupted = true;
      };
      process.on('SIGINT', onSigint);
      try {
        return await new Promise<EditorSpawnResult>((resolve) => {
          const child = spawn(file, argv, { stdio: 'inherit', windowsHide: false });
          child.on('error', () => resolve({ code: 127, interrupted }));
          child.on('exit', (code) => resolve({ code, interrupted }));
        });
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    },
    confirmClosed: waitForEnter,
  };
}
