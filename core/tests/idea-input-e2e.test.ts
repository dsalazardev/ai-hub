import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import type { AssistantPrompts } from '../src/cli/assistant.js';
import { extractFencedIdea, type EditorHost, type IdeaStdin } from '../src/cli/idea.js';
import { cmdInit } from '../src/cli/onboarding.js';
import { createContext, runCli } from '../src/cli/run.js';
import type { CliContext } from '../src/cli/types.js';
import { IDEA_SENTINEL, makeIdeaFixture } from './idea-fixtures.js';
import { fakeRunner } from './speckit-fake.js';

/**
 * idea-input, fase 5 de punta a punta (proyecto integration: cada caso hace un `init` real con Spec Kit falso).
 * 5.2 no destrucción, 5.4 contrato (hash y centinela en las cuatro fuentes), 5.5 extremo a extremo, 5.6 regresión.
 */

let base: string;
let roots: string[];

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-idea-e2e-'));
  roots = [];
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function consumer(name: string): Promise<string> {
  const root = path.join(base, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }, null, 2)}\n`,
  );
  roots.push(root);
  return root;
}

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

async function init(root: string, argv: string[], extra: Partial<CliContext> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = await createContext(root, { out: (line) => out.push(line), err: (line) => err.push(line) }, fakeRunner().run);
  const code = await cmdInit(parseArgs(argv), { ...ctx, ...extra });
  return { code, out, err, text: [...out, ...err].join('\n') };
}

async function tree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files.set(path.relative(root, file).split(path.sep).join('/'), sha(await fs.readFile(file)));
    }
  }
  return files;
}

async function filesWith(root: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      if ((await fs.readFile(file, 'utf8').catch(() => '')).includes(needle)) {
        found.push(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  }
  return found.sort();
}

function planHash(run: Run): string {
  const json = run.out.find((line) => line.trimStart().startsWith('{'));
  return (JSON.parse(json ?? '{}') as { hash?: string }).hash ?? '';
}

const seedOf = async (root: string): Promise<string> => fs.readFile(path.join(root, 'backlog', 'seed.md'), 'utf8');
const ideaOf = (seed: string): string | null => extractFencedIdea(seed.split('\n## Idea\n')[1] ?? '');
const withoutNote = (seed: string): string => seed.replace(/^> Registrada por .*$/m, '> Registrada por FUENTE');

function pipe(text: string): IdeaStdin {
  return {
    isTTY: false,
    chunks: () =>
      (async function* () {
        for (let index = 0; index < text.length; index += 65_536) {
          yield text.slice(index, index + 65_536);
        }
      })(),
  };
}

function editorWriting(root: string, text: string): EditorHost {
  return {
    platform: process.platform,
    env: { EDITOR: 'mi-editor --wait' },
    root,
    isTTY: true,
    tmpdir: os.tmpdir(),
    onPath: async () => false,
    spawn: async (_command, args) => {
      await fs.writeFile(args[args.length - 1], text);
      return { code: 0, interrupted: false };
    },
    confirmClosed: async () => true,
  };
}

function pastingPrompts(text: string): AssistantPrompts {
  const replies: unknown[] = [['claude'], 'full', ['py', 'sh', 'ps'], 'sh'];
  let index = 0;
  const next = (): unknown => (index < replies.length ? replies[index++] : null);
  return {
    intro: () => undefined,
    note: () => undefined,
    multiselect: async () => next() as string[],
    select: async () => next() as string,
    text: async () => null,
    confirm: async () => true,
    longText: async () => ({ kind: 'idea', text, source: 'paste', note: 'pegado en el asistente' }),
  };
}

const PRESET = ['--preset-only', '--targets', 'claude', '--scripts', 'py,sh,ps', '--script', 'sh'];

describe('idea-input 5.4 — el plan no cambia con la idea', () => {
  it('init --dry-run da el mismo hash sin idea y con --idea-file de 1 MiB; la línea idea: va a stderr', async () => {
    const root = await consumer('hash');
    const ideaPath = path.join(base, 'idea.md');
    await fs.writeFile(ideaPath, makeIdeaFixture({ bytes: 1024 * 1024 }));
    const plain = await init(root, [...PRESET, '--dry-run']);
    const withIdea = await init(root, [...PRESET, '--dry-run', '--idea-file', ideaPath]);
    expect(plain.code).toBe(0);
    expect(withIdea.code).toBe(0);
    expect(planHash(withIdea)).toBe(planHash(plain));
    expect(planHash(plain)).toMatch(/^[0-9a-f]{64}$/);
    expect(withIdea.out.join('\n')).not.toContain('idea:');
    expect(withIdea.err.join('\n')).toMatch(/^idea: archivo idea\.md, \d+ líneas · \d+ caracteres$/m);
    expect(withIdea.text).not.toContain(IDEA_SENTINEL);
    expect(await fs.readdir(root)).toEqual(['package.json']);
  }, 120_000);
});

describe('idea-input 5.4/5.5 — las cuatro fuentes dan la misma semilla y el centinela no sale de ella', () => {
  it('archivo, entrada estándar, editor y pegado: seed.md idéntico salvo la nota y centinela solo en backlog/seed.md', async () => {
    const idea = makeIdeaFixture({ bytes: 1024 * 1024 });
    const ideaPath = path.join(base, 'idea.md');
    await fs.writeFile(ideaPath, makeIdeaFixture({ bytes: 1024 * 1024, crlf: true, bom: true }));

    const fileRoot = await consumer('file');
    const stdinRoot = await consumer('stdin');
    const editorRoot = await consumer('editor');
    const pasteRoot = await consumer('paste');
    const runs: Array<[string, Run]> = [
      [fileRoot, await init(fileRoot, [...PRESET, '--yes', '--idea-file', ideaPath])],
      [stdinRoot, await init(stdinRoot, [...PRESET, '--yes', '--idea-stdin'], { ideaStdin: pipe(idea) })],
      [editorRoot, await init(editorRoot, [...PRESET, '--yes', '--idea-editor'], { editorHost: editorWriting(editorRoot, idea) })],
    ];
    const pasteOut: string[] = [];
    const pasteErr: string[] = [];
    const pasteCode = await runCli(['init'], {
      cwd: pasteRoot,
      io: { out: (line) => pasteOut.push(line), err: (line) => pasteErr.push(line) },
      exec: fakeRunner().run,
      interactive: true,
      assistantPrompts: pastingPrompts(idea),
    });
    runs.push([pasteRoot, { code: pasteCode, out: pasteOut, err: pasteErr, text: [...pasteOut, ...pasteErr].join('\n') }]);

    const seeds: string[] = [];
    for (const [root, run] of runs) {
      expect(run.code, run.text.slice(-2000)).toBe(0);
      expect(run.text).not.toContain(IDEA_SENTINEL);
      expect(run.out).toContain('backlog: seed.md escrito');
      expect(await filesWith(root, IDEA_SENTINEL)).toEqual(['backlog/seed.md']);
      const seed = await seedOf(root);
      expect(ideaOf(seed)).toBe(idea);
      seeds.push(withoutNote(seed));
    }
    expect(new Set(seeds).size).toBe(1);
    expect(await seedOf(fileRoot)).toContain('desde archivo idea.md');
    expect(await seedOf(stdinRoot)).toContain('desde entrada estándar');
    expect(await seedOf(editorRoot)).toContain('desde tu editor');
    expect(await seedOf(pasteRoot)).toContain('desde pegado en el asistente');
  }, 300_000);
});

describe('idea-input 5.5 — una fuente inválida para antes de aplicar', () => {
  it('--idea-file binario: salida 2 y ni el arnés ni el backlog se escriben', async () => {
    const root = await consumer('binary');
    const binary = path.join(base, 'idea.bin');
    await fs.writeFile(binary, Buffer.from([0x23, 0x20, 0x00, 0x01]));
    const before = await tree(root);
    const run = await init(root, [...PRESET, '--yes', '--idea-file', binary]);
    expect(run.code).toBe(2);
    expect(run.text).toContain(binary);
    expect(await tree(root)).toEqual(before);
  }, 120_000);
});

describe('idea-input 5.6 — regresión sin idea', () => {
  it('init --yes sin flags de idea no imprime líneas de idea ni crea backlog/', async () => {
    const root = await consumer('plain');
    const run = await init(root, [...PRESET, '--yes']);
    expect(run.code, run.text.slice(-2000)).toBe(0);
    expect(run.text).not.toMatch(/^(idea|backlog):/m);
    await expect(fs.access(path.join(root, 'backlog'))).rejects.toThrow();
  }, 120_000);
});

describe('idea-input 5.2 — no destrucción del backlog', () => {
  it('uninstall de una skill, un sync que retira destinos y purge --yes dejan backlog/ intacto', async () => {
    const root = await consumer('keep');
    const ideaPath = path.join(base, 'idea.md');
    await fs.writeFile(ideaPath, 'Una idea que el mantenimiento no debe tocar');
    // Catálogo completo: el perfil preset-only no materializa skills en .ai-hub/skills.
    const run = await init(root, ['--full', '--targets', 'claude', '--scripts', 'py,sh,ps', '--script', 'sh', '--yes', '--idea-file', ideaPath]);
    expect(run.code, run.text.slice(-2000)).toBe(0);
    const scaffold = JSON.parse(await fs.readFile(path.join(root, '.ai-hub', '.scaffold.json'), 'utf8')) as {
      files: Record<string, unknown>;
    };
    expect(scaffold.files['backlog/pre-prompt.md']).toBeDefined();
    const backlog = async (): Promise<string[]> =>
      Promise.all(['seed.md', 'pre-prompt.md'].map(async (name) => sha(await fs.readFile(path.join(root, 'backlog', name)))));
    const before = await backlog();
    const skills = await fs.readdir(path.join(root, '.ai-hub', 'skills'));
    expect(skills.length).toBeGreaterThan(0);
    const quiet = { io: { out: () => undefined, err: () => undefined }, exec: fakeRunner().run, cwd: root };
    // uninstall retira la skill del manifiesto y su sync borra los destinos que quedaron obsoletos.
    expect(await runCli(['uninstall', 'skill', skills[0]], quiet)).toBe(0);
    await expect(fs.access(path.join(root, '.ai-hub', 'skills', skills[0]))).rejects.toThrow();
    expect(await backlog()).toEqual(before);
    expect(await runCli(['sync'], quiet)).toBe(0);
    expect(await backlog()).toEqual(before);
    expect(await runCli(['purge', '--yes'], quiet)).toBe(0);
    expect(await backlog()).toEqual(before);
  }, 240_000);
});
