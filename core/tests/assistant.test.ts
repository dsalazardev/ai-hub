import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cmdInit } from '../src/cli/onboarding.js';
import { prepareInit } from '../src/cli/onboarding.js';
import { sha256 } from '../src/sync/lock.js';
import { createContext, runCli } from '../src/cli/run.js';
import { parseArgs } from '../src/cli/args.js';
import {
  isInteractiveRequest,
  answersToFlags,
  collectAnswers,
  type AssistantPrompts,
  type AssistantAnswers,
} from '../src/cli/assistant.js';
import { TOOL_IDS } from '../src/sync/targets.js';
import { loadEngine } from '../src/engine/engine.js';
import type { ProcessRunner } from '../src/speckit/runner.js';
import { fakeRunner } from './speckit-fake.js';
import type { CliContext, CliIO } from '../src/cli/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Módulos del asistente: el determinismo offline (R4) se prueba sobre su fuente. */
const MODULES = ['assistant.ts', 'assistant-clack.ts', 'preprompt.ts'].map((name) =>
  path.join(__dirname, '..', 'src', 'cli', name),
);

const FORBIDDEN: Array<[RegExp, string]> = [
  [/node:net\b/, 'node:net'],
  [/node:http\b/, 'node:http'],
  [/node:https\b/, 'node:https'],
  [/node:tls\b/, 'node:tls'],
  [/node:dgram\b/, 'node:dgram'],
  [/\bfetch\s*\(/, 'fetch()'],
];

describe('pureza del asistente (R4: determinista y offline)', () => {
  it('los módulos del asistente no importan ni usan ninguna API de red', async () => {
    for (const file of MODULES) {
      const source = await fs.readFile(file, 'utf8');
      for (const [pattern, api] of FORBIDDEN) {
        expect(source, `${path.basename(file)} no debe usar ${api}`).not.toMatch(pattern);
      }
    }
  });
});

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-assistant-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

/**
 * Prompts scriptados (design D13): las respuestas se consumen en orden; una respuesta
 * ausente o `null` cancela el prompt, como Ctrl+C en la TUI real. `calls` registra cada
 * prompt con sus opciones y preselección, para afirmar cómo se abrió cada paso.
 */
interface PromptCall {
  kind: 'multiselect' | 'select' | 'text' | 'confirm';
  message: string;
  initial?: unknown;
  options?: string[];
}

function scriptedPrompts(
  replies: unknown[],
): { prompts: AssistantPrompts; started: () => boolean; messages: string[]; calls: PromptCall[] } {
  let index = 0;
  let intro = false;
  const messages: string[] = [];
  const calls: PromptCall[] = [];
  const next = (): unknown => (index < replies.length ? replies[index++] : null);
  const prompts: AssistantPrompts = {
    intro: () => {
      intro = true;
    },
    note: (message) => {
      messages.push(message);
    },
    multiselect: async (message, options, initial) => {
      calls.push({ kind: 'multiselect', message, initial, options: options.map((o) => o.value) });
      const reply = next();
      return Array.isArray(reply) ? (reply as string[]) : null;
    },
    select: async (message, options, initial) => {
      calls.push({ kind: 'select', message, initial, options: options.map((o) => o.value) });
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
    text: async (message) => {
      calls.push({ kind: 'text', message });
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
    confirm: async (message) => {
      calls.push({ kind: 'confirm', message });
      return next() === true;
    },
  };
  return { prompts, started: () => intro, messages, calls };
}

async function assistantCtx(
  prompts: AssistantPrompts,
  interactive = true,
  exec: ProcessRunner = fakeRunner().run,
): Promise<{ ctx: CliContext; out: string[]; err: string[] }> {
  const sink = capture();
  const base = await createContext(root, sink.io, exec);
  const ctx: CliContext = { ...base, interactive, assistantPrompts: prompts };
  return { ctx, out: sink.out, err: sink.err };
}

async function seedConsumer(): Promise<void> {
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }, null, 2)}\n`,
    'utf8',
  );
}

/** Runner que responde `--version` con éxito para las herramientas "instaladas". */
function toolRunner(installed: string[]): ProcessRunner {
  const base = fakeRunner().run;
  return async (command, args, options) => {
    if (args[0] === '--version' && installed.includes(command)) {
      return { status: 0, stdout: `${command} 1.0.0\n`, stderr: '' };
    }
    return base(command, args, options);
  };
}

describe('gating del asistente (R2, D3)', () => {
  it('arranca con TTY y sin flags; cancelar en el primer paso no escribe nada', async () => {
    await seedConsumer();
    const { prompts, started } = scriptedPrompts([null]);
    const { ctx, out } = await assistantCtx(prompts);
    const code = await cmdInit(parseArgs([]), ctx);
    expect(started()).toBe(true);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await expect(fs.access(path.join(root, 'manifest.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(root, '.ai-hubrc.json'))).rejects.toThrow();
  });

  it('no arranca con TTY y cualquier flag: el flujo actual corre intacto', async () => {
    await seedConsumer();
    const { prompts, started } = scriptedPrompts([]);
    const { ctx, out } = await assistantCtx(prompts);
    const code = await cmdInit(parseArgs(['--preset', 'python', '--dry-run']), ctx);
    expect(started()).toBe(false);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('"preset": "python"');
  });

  it('no arranca en el checkout del motor aunque haya TTY y sin flags', async () => {
    await fs.mkdir(path.join(root, 'core', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'core', 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await fs.writeFile(path.join(root, 'core', 'src', 'paths.ts'), 'export {};\n', 'utf8');
    const { prompts, started } = scriptedPrompts([]);
    const { ctx } = await assistantCtx(prompts);
    const code = await cmdInit(parseArgs([]), ctx);
    expect(started()).toBe(false);
    expect(code).toBe(0);
  });
});

describe('isInteractiveRequest (D3)', () => {
  it('TTY y sin flags pide el asistente', async () => {
    const { ctx } = await assistantCtx(scriptedPrompts([]).prompts);
    expect(isInteractiveRequest(parseArgs([]), ctx)).toBe(true);
  });

  it('cualquier flag desactiva el asistente aunque haya TTY', async () => {
    const { ctx } = await assistantCtx(scriptedPrompts([]).prompts);
    expect(isInteractiveRequest(parseArgs(['--dry-run']), ctx)).toBe(false);
    expect(isInteractiveRequest(parseArgs(['--yes']), ctx)).toBe(false);
    expect(isInteractiveRequest(parseArgs(['--no-speckit']), ctx)).toBe(false);
  });

  it('sin TTY el asistente nunca arranca', async () => {
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    expect(isInteractiveRequest(parseArgs([]), ctx)).toBe(false);
  });
});

describe('mismo hash por los dos caminos (R1, D4)', () => {
  it('full: prompts inyectados y argv equivalente producen el mismo plan y sha256', async () => {
    await seedConsumer();
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers: AssistantAnswers = {
      targets: ['claude', 'opencode'],
      preset: null,
      profile: 'full',
      excludes: [],
      scripts: ['sh', 'ps', 'py'],
      script: 'sh',
      // D6: la idea no es flag; no debe perturbar el plan body ni el hash.
      idea: 'Una idea de demo que no debe entrar al plan',
    };
    const argvArgs = parseArgs(['--yes', '--targets', 'claude,opencode', '--full', '--script', 'sh']);
    const byAssistant = await prepareInit(answersToFlags(answers), ctx);
    const byArgv = await prepareInit(argvArgs, ctx);
    const bodyAssistant = byAssistant.planBodyFor(null);
    const bodyArgv = byArgv.planBodyFor(null);
    expect(bodyAssistant).toEqual(bodyArgv);
    const hashAssistant = sha256(JSON.stringify(bodyAssistant));
    const hashArgv = sha256(JSON.stringify(bodyArgv));
    expect(hashAssistant).toBe(hashArgv);
    expect(hashAssistant).toMatch(/^[0-9a-f]{64}$/);
  });

  it('custom con excludes y script: mismo plan y sha256 por ambos caminos', async () => {
    await seedConsumer();
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers: AssistantAnswers = {
      targets: ['claude'],
      preset: 'python',
      profile: 'custom',
      excludes: ['ads', 'analytics'],
      scripts: ['sh', 'ps', 'py'],
      script: 'sh',
      idea: null,
    };
    const argvArgs = parseArgs([
      '--yes',
      '--targets',
      'claude',
      '--preset',
      'python',
      '--exclude',
      'ads,analytics',
      '--script',
      'sh',
    ]);
    const byAssistant = await prepareInit(answersToFlags(answers), ctx);
    const byArgv = await prepareInit(argvArgs, ctx);
    const bodyAssistant = byAssistant.planBodyFor(null);
    const bodyArgv = byArgv.planBodyFor(null);
    expect(bodyAssistant).toEqual(bodyArgv);
    expect(sha256(JSON.stringify(bodyAssistant))).toBe(sha256(JSON.stringify(bodyArgv)));
  });
});

describe('colector pasos 1-4 (D12)', () => {
  it('targets: preselección por detección y selección → --targets', async () => {
    await seedConsumer();
    const { prompts, calls } = scriptedPrompts([['claude', 'opencode'], 'full', ['py', 'sh', 'ps'], 'sh']);
    const sink = capture();
    const ctx = await createContext(root, sink.io, toolRunner(['claude', 'opencode']));
    const answers = await collectAnswers(prompts, ctx);
    expect(answers, 'el colector no debe cancelar').not.toBeNull();
    expect(answers?.targets).toEqual(['claude', 'opencode']);
    expect(answersToFlags(answers as AssistantAnswers).flags.targets).toBe('claude,opencode');
    const targetsCall = calls.find((call) => call.kind === 'multiselect');
    expect(targetsCall?.options).toEqual([...TOOL_IDS]);
    expect(targetsCall?.initial).toEqual(['claude', 'opencode']);
  });

  it('sin empate: preset detectado, sin flag --preset', async () => {
    await seedConsumer();
    const { prompts, messages } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh']);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.preset).toBeNull();
    const flags = answersToFlags(answers as AssistantAnswers).flags;
    expect('preset' in flags).toBe(false);
    expect(messages.some((message) => message.includes('Preset detectado: generic-ts'))).toBe(true);
  });

  it('empate de preset → elección explícita entre los empatados, sin adivinar', async () => {
    // package.json sin typescript + requirements.txt: generic-ts y python empatan a 2.
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"demo"}\n', 'utf8');
    await fs.writeFile(path.join(root, 'requirements.txt'), 'pytest\n', 'utf8');
    const { prompts, calls } = scriptedPrompts([['claude'], 'python', 'full', ['py', 'sh', 'ps'], 'sh']);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.preset).toBe('python');
    expect(answersToFlags(answers as AssistantAnswers).flags.preset).toBe('python');
    const presetCall = calls.find((call) => call.kind === 'select');
    expect(presetCall?.options).toEqual(['generic-ts', 'python']);
  });

  it('custom → excludes guiados → --exclude; input inválido re-pregunta', async () => {
    await seedConsumer();
    const { prompts, messages, calls } = scriptedPrompts([
      ['claude'],
      'custom',
      'rule:core',
      'ads,analytics',
      ['py', 'sh', 'ps'],
      'sh',
    ]);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.profile).toBe('custom');
    expect(answers?.excludes).toEqual(['ads', 'analytics']);
    expect(answersToFlags(answers as AssistantAnswers).flags.exclude).toBe('ads,analytics');
    expect(messages.some((message) => message.includes('regla base'))).toBe(true);
    expect(calls.filter((call) => call.kind === 'text')).toHaveLength(2);
  });

  it('script → --script explícito; initial del activo = default del engine; opciones = elegidos', async () => {
    await seedConsumer();
    const { prompts, calls, messages } = scriptedPrompts([['claude'], 'preset-only', ['sh', 'ps'], 'ps']);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const engine = await loadEngine();
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.scripts).toEqual(['sh', 'ps']);
    expect(answers?.script).toBe('ps');
    const flags = answersToFlags(answers as AssistantAnswers).flags;
    expect(flags.script).toBe('ps');
    expect(flags.scripts).toBe('sh,ps');
    const activeCall = calls.filter((call) => call.kind === 'select').at(-1);
    expect(activeCall?.options).toEqual(['sh', 'ps']);
    expect(activeCall?.initial).toBe(engine.speckit.script);
    expect(messages.some((message) => message.includes('sh se ejecutará con'))).toBe(true);
  });
});

describe('paso de scripts: conjunto y activo (script-choice 5.1, 5.2)', () => {
  it('colecta el conjunto con multiselect y el activo con select sólo cuando elige más de uno', async () => {
    await seedConsumer();
    const { prompts, calls } = scriptedPrompts([['claude'], 'full', ['py', 'sh'], 'sh']);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers, 'el colector no debe cancelar').not.toBeNull();
    expect(answers?.scripts).toEqual(['py', 'sh']);
    expect(answers?.script).toBe('sh');
    const setCall = calls.find((call) => call.kind === 'multiselect' && call.message.includes('script'));
    expect(setCall?.options).toEqual(['py', 'sh', 'ps']);
    expect(setCall?.initial).toEqual(['py', 'sh', 'ps']);
    const activeCall = calls.filter((call) => call.kind === 'select').at(-1);
    expect(activeCall?.options).toEqual(['py', 'sh']);
    expect(activeCall?.initial).toBe('sh');
    const flags = answersToFlags(answers as AssistantAnswers).flags;
    expect(flags.scripts).toBe('py,sh');
    expect(flags.script).toBe('sh');
  });

  it('{py} solo: sin pregunta del activo; flags --scripts py --script py', async () => {
    await seedConsumer();
    const { prompts, calls, messages } = scriptedPrompts([['claude'], 'full', ['py']]);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.scripts).toEqual(['py']);
    expect(answers?.script).toBe('py');
    expect(calls.filter((call) => call.kind === 'select' && call.message.includes('activo'))).toHaveLength(0);
    expect(messages.some((message) => message.includes('py se ejecutará con'))).toBe(true);
    const flags = answersToFlags(answers as AssistantAnswers).flags;
    expect(flags.scripts).toBe('py');
    expect(flags.script).toBe('py');
  });

  it('los tres: sólo --script, sin --scripts', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'ps']);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.scripts).toEqual(['py', 'sh', 'ps']);
    expect(answers?.script).toBe('ps');
    const flags = answersToFlags(answers as AssistantAnswers).flags;
    expect(flags.script).toBe('ps');
    expect('scripts' in flags).toBe(false);
  });

  it('cero seleccionado no deja continuar: re-pregunta', async () => {
    await seedConsumer();
    const { prompts, calls, messages } = scriptedPrompts([['claude'], 'full', [], ['py']]);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const answers = await collectAnswers(prompts, ctx);
    expect(answers?.scripts).toEqual(['py']);
    const setCalls = calls.filter((call) => call.kind === 'multiselect' && call.message.includes('script'));
    expect(setCalls).toHaveLength(2);
    expect(messages.some((message) => message.includes('cero no deja continuar'))).toBe(true);
  });
});

describe('mismo hash con conjunto nuevo (script-choice 5.3)', () => {
  it('scripts py,sh + activo sh: asistente y flags producen el mismo plan body y sha256', async () => {
    // Directorio de nombre fijo: el project id (y el hash) sale del basename.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hash-set-'));
    const dir = path.join(base, 'consumer');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }, null, 2)}\n`,
      'utf8',
    );
    try {
      const sink = capture();
      const ctx = await createContext(dir, sink.io, fakeRunner().run);
      const answers: AssistantAnswers = {
        targets: ['claude'],
        preset: null,
        profile: 'full',
        excludes: [],
        scripts: ['py', 'sh'],
        script: 'sh',
        idea: null,
      };
      const argvArgs = parseArgs([
        '--yes',
        '--targets',
        'claude',
        '--full',
        '--scripts',
        'py,sh',
        '--script',
        'sh',
      ]);
      const byAssistant = await prepareInit(answersToFlags(answers), ctx);
      const byArgv = await prepareInit(argvArgs, ctx);
      const bodyAssistant = byAssistant.planBodyFor(null);
      const bodyArgv = byArgv.planBodyFor(null);
      expect(bodyAssistant).toEqual(bodyArgv);
      const hashAssistant = sha256(JSON.stringify(bodyAssistant));
      const hashArgv = sha256(JSON.stringify(bodyArgv));
      expect(hashAssistant).toBe(hashArgv);
      expect(hashAssistant).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('verificación de herramientas (R3, D7)', () => {
  it('herramienta faltante: nombra la herramienta, cómo instalarla y loguearse; no rompe; ningún prompt pide credenciales', async () => {
    await seedConsumer();
    // Ninguna herramienta instalada: fakeRunner responde notFound a cada probe.
    const { prompts, messages, calls } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '']);
    const { ctx } = await assistantCtx(prompts);
    const code = await cmdInit(parseArgs([]), ctx);
    expect(code).toBe(0);
    const joined = messages.join('\n');
    expect(joined).toContain('Claude Code no está instalado');
    expect(joined).toContain('npm install -g @anthropic-ai/claude-code');
    expect(joined.toLowerCase()).toContain('login');
    const asks = calls.map((call) => call.message).join('\n');
    expect(asks).not.toMatch(/(api[_-]?key|token|contraseña|password|secret)/i);
  });

  it('preflight de Spec Kit fallido: exit 2 antes de escribir, igual que hoy (D8)', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh']);
    const { ctx, err } = await assistantCtx(prompts, true, fakeRunner({ missing: ['uvx'] }).run);
    const code = await cmdInit(parseArgs([]), ctx);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('preflight');
    await expect(fs.access(path.join(root, 'manifest.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(root, '.ai-hubrc.json'))).rejects.toThrow();
  });
});

/** Patrones de credenciales reales; ninguna salida ni archivo del asistente debe contenerlos. */
const SECRET_PATTERNS =
  /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const SECRET_ASK =
  /((introduce|escribe|pega|dame)\s+(tu|la|el|una)\s+(api[_-]?key|key|token|contraseña|password|credencial)|(api[_-]?key|token|contraseña|password)\s*[::])/i;

describe('cero secretos (R3)', () => {
  it('recorrido completo: ningún prompt pide credenciales y ningún archivo escrito contiene una', async () => {
    await seedConsumer();
    const { prompts, messages, calls } = scriptedPrompts([
      ['claude', 'copilot'],
      'custom',
      'ads',
      ['py', 'sh', 'ps'],
      'sh',
      '',
    ]);
    const { ctx } = await assistantCtx(prompts);
    const code = await cmdInit(parseArgs([]), ctx);
    expect(code).toBe(0);
    const transcript = [...messages, ...calls.map((call) => call.message)].join('\n');
    expect(transcript).not.toMatch(SECRET_ASK);
    expect(transcript).not.toMatch(SECRET_PATTERNS);
    // Ningún archivo escrito contiene una credencial. Hoy el recorrido no escribe
    // (el paso plan es 5.2); cuando escriba, este mismo escaneo cubre la escritura real.
    for (const artifact of ['manifest.yaml', '.ai-hubrc.json', '.ai-hub', '.gitignore', 'backlog']) {
      await expect(
        fs.access(path.join(root, artifact)),
        `el asistente no debe escribir ${artifact} en este estado intermedio`,
      ).rejects.toThrow();
    }
    const entries = await fs.readdir(root, { recursive: true });
    for (const rel of entries) {
      const file = path.join(root, rel);
      if (!(await fs.stat(file)).isFile()) {
        continue;
      }
      const content = await fs.readFile(file, 'utf8').catch(() => '');
      expect(content, `${file} no debe contener credenciales`).not.toMatch(SECRET_PATTERNS);
    }
  });
});

describe('cancelabilidad (R5, D5)', () => {
  async function assertNothingWritten(): Promise<void> {
    for (const artifact of ['manifest.yaml', '.ai-hubrc.json', '.ai-hub', '.gitignore', 'backlog']) {
      await expect(fs.access(path.join(root, artifact))).rejects.toThrow();
    }
  }

  it('cancelar en el paso targets: 0 archivos', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('cancelar en el paso perfil: 0 archivos', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('cancelar en el paso excludes (custom): 0 archivos', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'custom', null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('cancelar en el multiselect del conjunto: 0 archivos (script-choice 5.4)', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('cancelar en el select del activo: 0 archivos (script-choice 5.4)', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh'], null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('cancelar en el paso idea: 0 archivos', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('cancelar en la confirmación final: el plan se imprimió, el confirm se pidió, 0 archivos', async () => {
    await seedConsumer();
    const { prompts, calls } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', null]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    expect(out.join('\n')).toContain('"command": "init"');
    expect(calls.some((call) => call.kind === 'confirm')).toBe(true);
    expect(out.join('\n')).toContain('cancelado');
    await assertNothingWritten();
  });

  it('confirmar: aplica el plan por el mismo camino que --yes', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true]);
    const { ctx, out } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    const joined = out.join('\n');
    expect(joined).toContain('"command": "init"');
    expect(joined).toContain('init: generic-ts');
    expect(joined).toMatch(/plan: [0-9a-f]{64}/);
    await expect(fs.access(path.join(root, 'manifest.yaml'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.ai-hubrc.json'))).resolves.toBeUndefined();
  }, 60_000);
});

describe('aplicación equivalente: asistente vs flags (R1)', () => {
  it('el mismo input por ambos caminos deja el mismo disco; segunda corrida idempotente', async () => {
    // Dos consumers con el MISMO basename: el project id (y el hash del plan) sale del basename.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-equiv-'));
    const dirA = path.join(base, 'a', 'consumer');
    const dirB = path.join(base, 'b', 'consumer');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    const pkg = `${JSON.stringify({ name: 'demo', devDependencies: { typescript: '^5.0.0' } }, null, 2)}\n`;
    await fs.writeFile(path.join(dirA, 'package.json'), pkg, 'utf8');
    await fs.writeFile(path.join(dirB, 'package.json'), pkg, 'utf8');

    // A: asistente scriptado (targets claude, full, script sh, confirmar).
    const sinkA = capture();
    const ctxA = await createContext(dirA, sinkA.io, fakeRunner().run);
    const promptsA = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true]).prompts;
    const codeA = await cmdInit(parseArgs([]), {
      ...ctxA,
      interactive: true,
      assistantPrompts: promptsA,
    });
    expect(codeA).toBe(0);

    // B: flags equivalentes con --yes.
    const sinkB = capture();
    const ctxB = await createContext(dirB, sinkB.io, fakeRunner().run);
    const codeB = await cmdInit(
      parseArgs(['--yes', '--targets', 'claude', '--full', '--script', 'sh']),
      ctxB,
    );
    expect(codeB).toBe(0);

    // El hash del plan aplicado es el mismo por ambos caminos.
    const hashA = /plan: ([0-9a-f]{64})/.exec(sinkA.out.join('\n'))?.[1];
    const hashB = /plan: ([0-9a-f]{64})/.exec(sinkB.out.join('\n'))?.[1];
    expect(hashA, 'el asistente debe imprimir el hash del plan aplicado').toBeDefined();
    expect(hashA).toBe(hashB);

    // El disco queda igual: manifest, rc y lock byte a byte; árbol de nombres completo.
    const read = async (dir: string, rel: string): Promise<string> =>
      fs.readFile(path.join(dir, rel), 'utf8');
    for (const rel of ['manifest.yaml', '.ai-hubrc.json', 'sync.lock.json']) {
      expect(await read(dirA, rel), `${rel} debe ser idéntico`).toBe(await read(dirB, rel));
    }
    const tree = async (dir: string): Promise<string[]> =>
      (await fs.readdir(dir, { recursive: true })).sort();
    expect(await tree(dirA)).toEqual(await tree(dirB));

    // Segunda corrida del asistente sobre A: idempotente (lock estable).
    const lockBefore = await read(dirA, 'sync.lock.json');
    const sinkA2 = capture();
    const ctxA2 = await createContext(dirA, sinkA2.io, fakeRunner().run);
    const promptsA2 = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true]).prompts;
    expect(await cmdInit(parseArgs([]), { ...ctxA2, interactive: true, assistantPrompts: promptsA2 })).toBe(0);
    expect(await read(dirA, 'sync.lock.json')).toBe(lockBefore);

    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 180_000);
});

describe('semilla y pre-prompt (D6, D9, D10)', () => {
  it('con idea: seed.md lleva la idea textual, la fecha y el apuntador; pre-prompt.md es la plantilla bilingüe', async () => {
    await seedConsumer();
    const idea = 'Un panel de control para visualizar métricas de despliegue';
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', idea, true]);
    const { ctx } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    const seed = await fs.readFile(path.join(root, 'backlog', 'seed.md'), 'utf8');
    expect(seed, 'la idea debe ser textual').toContain(idea);
    expect(seed, 'la semilla lleva la fecha').toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(seed, 'la semilla apunta al pre-prompt').toContain('pre-prompt.md');
    const prePrompt = await fs.readFile(path.join(root, 'backlog', 'pre-prompt.md'), 'utf8');
    expect(prePrompt).toContain('/speckit.constitution');
    expect(prePrompt).toContain('/speckit-assess-intake');
    expect(prePrompt).toMatch(/## Español/);
    expect(prePrompt).toMatch(/## English/);
  }, 60_000);

  it('sin idea (paso saltado): el apply ocurre y backlog/ no existe', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true]);
    const { ctx } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    await expect(fs.access(path.join(root, 'manifest.yaml'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'backlog'))).rejects.toThrow();
  }, 60_000);
});

describe('invisibilidad para el arnés (D9)', () => {
  it('sync no lockea backlog/, .gitignore no lo ignora, y la idea no cambia el hash', async () => {
    await seedConsumer();
    const { prompts } = scriptedPrompts([['claude'], 'full', ['py', 'sh', 'ps'], 'sh', 'Idea invisible al hash', true]);
    const { ctx } = await assistantCtx(prompts);
    expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
    // (a) el lock no conoce backlog/: no es un destino de sync.
    const lock = await fs.readFile(path.join(root, 'sync.lock.json'), 'utf8');
    expect(lock).not.toContain('backlog');
    // (b) el .gitignore del proyecto no lo ignora: la semilla es versionable.
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).not.toContain('backlog');
    // (c) la idea no entra al plan body (D6): hash con y sin idea idéntico.
    const sink = capture();
    const ctx2 = await createContext(root, sink.io, fakeRunner().run);
    const base: AssistantAnswers = {
      targets: ['claude'],
      preset: null,
      profile: 'full',
      excludes: [],
      scripts: ['sh', 'ps', 'py'],
      script: 'sh',
      idea: null,
    };
    const withIdea = await prepareInit(answersToFlags({ ...base, idea: 'Idea invisible al hash' }), ctx2);
    const withoutIdea = await prepareInit(answersToFlags(base), ctx2);
    expect(sha256(JSON.stringify(withIdea.planBodyFor(null)))).toBe(
      sha256(JSON.stringify(withoutIdea.planBodyFor(null))),
    );
  }, 60_000);
});

describe('doctor y backlog (D11)', () => {
  it('sin backlog: doctor 0; con seed.md: línea informativa y sigue en 0 (nunca gate)', async () => {
    await seedConsumer();
    const install = capture();
    expect(
      await runCli(['init', '--yes', '--targets', 'claude', '--full', '--script', 'sh'], {
        cwd: root,
        io: install.io,
        exec: fakeRunner().run,
      }),
    ).toBe(0);
    // (a) sin backlog/: doctor sale 0 y a lo sumo un aviso informativo.
    const withoutBacklog = capture();
    expect(
      await runCli(['doctor'], { cwd: root, io: withoutBacklog.io, exec: fakeRunner().run }),
    ).toBe(0);
    // (b) con backlog/seed.md: la línea informativa aparece y doctor sigue saliendo 0.
    await fs.mkdir(path.join(root, 'backlog'), { recursive: true });
    await fs.writeFile(path.join(root, 'backlog', 'seed.md'), '# Semilla\n\n## Idea\n\nDemo\n', 'utf8');
    const withBacklog = capture();
    expect(
      await runCli(['doctor'], { cwd: root, io: withBacklog.io, exec: fakeRunner().run }),
    ).toBe(0);
    const joined = withBacklog.out.join('\n');
    expect(joined).toContain('semilla presente');
    expect(joined).toMatch(/\[OK\] +backlog:/);
  }, 120_000);
});
