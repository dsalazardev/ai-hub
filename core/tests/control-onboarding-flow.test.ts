import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from '../src/cli/args.js';
import { cmdInit } from '../src/cli/onboarding.js';
import { writeBacklogSeed, type AssistantPrompts } from '../src/cli/assistant.js';
import { offerControlStep } from '../src/control/onboard-step.js';
import { runEnroll } from '../src/control/enroll.js';
import { RETAKE_ACTION } from '../src/cli/integrations.js';
import { parseDotenv } from '../src/env/dotenv.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import {
  APPROVER,
  BOT_TOKEN,
  CHANNEL,
  DEFAULT_PROFILE_ENV,
  DEFAULT_SOUL,
  OTHER_TOKEN,
  SimulatedCrash,
  creating,
  fakeDiscord,
  fakeHermes,
  filesContaining,
  noHermesHost,
  scripted,
  stepContext,
  treeHash,
  type FakeDiscord,
  type FakeHermes,
} from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** control-onboarding, fases 2–5: preguntas obligatorias, validación, escritura, enroll, gateway, idea y no interactivo. */

let h: Harness;
let hermes: FakeHermes;
let discord: FakeDiscord;

beforeEach(async () => {
  h = await harness();
  await h.consumer({ control: false });
  hermes = await fakeHermes(h.root);
  discord = fakeDiscord();
});

afterEach(async () => {
  await h.dispose();
});

const ACCEPT = ['s', BOT_TOKEN, CHANNEL, APPROVER, '', ''];

async function step(replies: Array<string | boolean | null>, idea: string | null = null) {
  const sink = { out: [] as string[], err: [] as string[] };
  const script = scripted(replies);
  const code = await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: hermes.host, discordFetch: discord.fetch }), idea);
  const text = [...sink.out, ...sink.err, ...script.notes, ...script.asked].join('\n');
  return { code, out: sink.out, err: sink.err, notes: script.notes, asked: script.asked, text };
}

const profileEnv = () => path.join(hermes.home, 'profiles', 'hermes-control', '.env');

async function noWrites(): Promise<void> {
  expect(await filesContaining(h.root, BOT_TOKEN)).toEqual([]);
  expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual([]);
  expect(creating(hermes.calls)).toEqual([]);
  expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
}

describe('fase 2 — token obligatorio y enmascarado (2.1)', () => {
  it('asks for the token first through the masked prompt and repeats an empty one', async () => {
    const result = await step(['s', '', BOT_TOKEN, CHANNEL, APPROVER, '', '']);
    expect(result.code, result.text).toBe(0);
    const tokenAsks = result.asked.filter((call) => call.includes('Token del bot de Discord'));
    expect(tokenAsks).toHaveLength(2);
    expect(tokenAsks.every((call) => call.startsWith('password:'))).toBe(true);
    expect(result.asked[1].startsWith('password:')).toBe(true);
    expect(result.notes.join('\n')).toContain('El token es obligatorio');
    expect(result.text).not.toContain(BOT_TOKEN);
  });
});

describe('fase 2 — validación con Discord (2.2)', () => {
  it('a valid token shows the bot name, never the token', async () => {
    const result = await step(ACCEPT);
    expect(result.notes.join('\n')).toContain('bot "ai-hub-control-bot"');
    expect(result.text).not.toContain(BOT_TOKEN);
  });

  it('a 401 token is rejected, never saved, and asked again', async () => {
    discord.tokenStatus = 401;
    const result = await step(['s', BOT_TOKEN, null]);
    expect(result.notes.join('\n')).toContain('Discord rechazó el token (HTTP 401)');
    expect(result.asked.filter((call) => call.startsWith('password:'))).toHaveLength(2);
    await noWrites();
  });

  it('unreachable Discord asks before saving; declining asks for the token again', async () => {
    discord.tokenStatus = 'network';
    const result = await step(['s', BOT_TOKEN, false, null]);
    expect(result.asked.some((call) => call.startsWith('confirm:') && call.includes('sin validar'))).toBe(true);
    expect(result.asked.filter((call) => call.startsWith('password:'))).toHaveLength(2);
    await noWrites();
  });
});

describe('fase 2 — canal, aprobador y valores por defecto (2.3, 2.4)', () => {
  it('an invisible channel id is asked again; a name resolves to its id', async () => {
    const result = await step(['s', BOT_TOKEN, '111111111111111111', '#control', APPROVER, '', '']);
    expect(result.code, result.text).toBe(0);
    expect(result.notes.join('\n')).toContain('Ningún canal con ese id es visible para el bot (HTTP 404)');
    expect(result.notes.join('\n')).toContain(`Canal: ${CHANNEL} (#control)`);
  });

  it('an ambiguous name asks for the numeric id', async () => {
    discord.guildChannels.push({ id: '222222222222222222', name: 'control', type: 0 });
    const result = await step(['s', BOT_TOKEN, 'control', null]);
    expect(result.notes.join('\n')).toContain('Hay 2 canales con ese nombre');
    await noWrites();
  });

  it('a non-numeric approver is asked again; empty TTL and expiry take 24 and block', async () => {
    const result = await step(['s', BOT_TOKEN, CHANNEL, '@persona', APPROVER, '', '']);
    expect(result.code, result.text).toBe(0);
    expect(result.notes.join('\n')).toContain('id numérico de usuario');
    expect((await loadManifestContext(h.root)).manifest.control).toEqual({ approvers: [APPROVER], channelId: CHANNEL, ttlHours: 24, expire: 'block', pollMinutes: 15 });
  });
});

describe('fase 2 — cancelar tras el token (2.5)', () => {
  it('cancelling at the channel leaves no token anywhere and runs no Hermes command that writes', async () => {
    await fs.mkdir(hermes.home, { recursive: true });
    const before = [await treeHash(h.root), await treeHash(hermes.home)];
    const result = await step(['s', BOT_TOKEN, null]);
    expect(result.out.join('\n')).toContain('control: cancelado; no se escribió nada');
    expect([await treeHash(h.root), await treeHash(hermes.home)]).toEqual(before);
    await noWrites();
  });
});

describe('fase 3 — perfil independiente y escritura (3.1–3.4)', () => {
  it('refuses a token already used by another profile before the channel, printing nothing secret', async () => {
    const other = path.join(hermes.home, 'profiles', 'personal');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, '.env'), `DISCORD_BOT_TOKEN=${BOT_TOKEN}\n`);
    const result = await step(['s', BOT_TOKEN, null]);
    expect(result.code).toBe(0);
    expect(result.notes.join('\n')).toContain('perfil "personal"');
    expect(result.asked.filter((call) => call.includes('Canal de Discord'))).toEqual([]);
    expect(result.text).not.toContain(BOT_TOKEN);
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual(['profiles/personal/.env']);
    expect(creating(hermes.calls)).toEqual([]);
  });

  it('creates the profile without cloning and writes only the profile env, keeping other keys', async () => {
    await fs.mkdir(path.dirname(profileEnv()), { recursive: true });
    await fs.writeFile(profileEnv(), 'KEEP_ME=1\n');
    const result = await step(ACCEPT);
    expect(result.code, result.text).toBe(0);
    const env = parseDotenv(await fs.readFile(profileEnv(), 'utf8'));
    expect(Object.keys(env).sort()).toEqual(['DISCORD_ALLOWED_CHANNELS', 'DISCORD_ALLOWED_USERS', 'DISCORD_BOT_TOKEN', 'DISCORD_HOME_CHANNEL', 'KEEP_ME']);
    expect(env.DISCORD_ALLOWED_USERS).toBe(APPROVER);
    expect(env.DISCORD_ALLOWED_CHANNELS).toBe(CHANNEL);
    expect(await filesContaining(h.root, BOT_TOKEN)).toEqual([]);
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual(['profiles/hermes-control/.env']);
    expect(hermes.calls.flat().some((arg) => /^--clone/.test(arg))).toBe(false);
    expect(result.text).not.toContain(BOT_TOKEN);
  });

  // idea-input (desviación 10): 30 s; con la máquina cargada superó los 10 s del proyecto unit (10,9 s).
  it('a fresh profile is created with exactly profile create hermes-control --no-skills', { timeout: 30_000 }, async () => {
    const result = await step(ACCEPT);
    expect(result.code, result.text).toBe(0);
    expect(creating(hermes.calls)[0]).toEqual(['profile', 'create', 'hermes-control', '--no-skills']);
    const manifest = (await loadManifestContext(h.root)).manifest;
    expect(manifest.control).toEqual({ approvers: [APPROVER], channelId: CHANNEL, ttlHours: 24, expire: 'block', pollMinutes: 15 });
    const doctor = await h.cli(['doctor']);
    expect(doctor.out).toMatch(/^\[OK\]\s+control: 1 aprobador\(es\) en Discord/m);
  });

  it('a profile with another bot is not overwritten when reconfiguration is declined', async () => {
    await fs.mkdir(path.dirname(profileEnv()), { recursive: true });
    await fs.writeFile(profileEnv(), `DISCORD_BOT_TOKEN=${OTHER_TOKEN}\n`);
    const before = await fs.readFile(profileEnv(), 'utf8');
    const result = await step([...ACCEPT, false]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('ya tiene otro bot');
    expect(await fs.readFile(profileEnv(), 'utf8')).toBe(before);
    expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
  });
});

describe('fase 3 — el hash del plan no cambia (3.5)', () => {
  it('the same choices give the same plan hash when skipping and when completing the control step', async () => {
    // init-fiabilidad (DEV-02): fuera de h.root, que tiene manifest.yaml; dentro, el asistente preguntaría por la raíz.
    const plans = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plans-'));
    const run = async (name: string, control: Array<string | boolean | null>) => {
      // Mismo nombre de carpeta en los dos: el nombre del proyecto (que sale de la carpeta) entra en el plan.
      const dir = path.join(plans, name, 'consumer');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
      const sink = { out: [] as string[], err: [] as string[] };
      const replies: Array<unknown> = [['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true, '', ...control];
      let index = 0;
      const next = (): unknown => (index < replies.length ? replies[index++] : null);
      const prompts = {
        intro: () => undefined,
        note: () => undefined,
        multiselect: async () => {
          const reply = next();
          return Array.isArray(reply) ? (reply as string[]) : null;
        },
        select: async () => {
          const reply = next();
          return typeof reply === 'string' ? reply : null;
        },
        text: async () => {
          const reply = next();
          return typeof reply === 'string' ? reply : null;
        },
        confirm: async () => next() === true,
        password: async () => {
          const reply = next();
          return typeof reply === 'string' ? reply : null;
        },
      };
      const ctx = { ...stepContext(h, sink), cwd: dir, root: dir, interactive: true, assistantPrompts: prompts, controlHost: hermes.host, discordFetch: discord.fetch };
      expect(await cmdInit(parseArgs([]), ctx)).toBe(0);
      const out = [...sink.out, ...sink.err].join('\n');
      return { hash: /plan: ([0-9a-f]{64})/.exec(out)?.[1], out };
    };
    const skip = await run('skip', ['']);
    const accept = await run('accept', ACCEPT);
    expect(skip.hash).toBeDefined();
    expect(accept.hash).toBe(skip.hash);
    expect(accept.out).toContain('control: perfil hermes-control');
    expect(accept.out).not.toContain(BOT_TOKEN);
    await fs.rm(plans, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, { timeout: 300_000 });
});

describe('fase 4 — enroll, gateway y resumen (4.1, 4.2, 4.4)', () => {
  it('runs the enrolment and ends with a gateway restart and exactly five summary lines', async () => {
    const result = await step(ACCEPT);
    expect(result.code, result.text).toBe(0);
    const writes = creating(hermes.calls).map((args) => args.join(' '));
    expect(writes.some((line) => line.includes('webhook subscribe ai-hub-gitlab'))).toBe(true);
    expect(writes.some((line) => line.includes('cron create'))).toBe(true);
    // webhook-operativo D2: el reinicio va al dueño del listener (aquí el propio perfil, `-p hermes-control`).
    expect(writes.at(-1)).toBe('-p hermes-control gateway restart');
    expect(result.out.slice(-5)).toEqual([
      `control: perfil hermes-control (${path.join(hermes.home, 'profiles', 'hermes-control')})`,
      `control: canal ${CHANNEL} (#control)`,
      `control: aprobador ${APPROVER}`,
      'control: ttl 24 h · expire block',
      'control: comprueba con ai-hub control enroll --check',
    ]);
    expect(result.text).not.toContain(BOT_TOKEN);
  });

  it('without an installed gateway it does not restart and the summary names the command', async () => {
    hermes.gatewayInstalled = false;
    const result = await step(ACCEPT);
    expect(result.code, result.text).toBe(0);
    expect(hermes.calls.some((args) => args[0] === 'gateway' && args[1] === 'restart')).toBe(false);
    expect(result.out.at(-1)).toBe('control: comprueba con ai-hub control enroll --check · inicia el gateway con hermes gateway install');
  });

  it('a failed profile creation stops, names the command, writes no token and keeps the init applied', async () => {
    hermes.fail.add('profile create');
    const result = await step(ACCEPT);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('falló "hermes profile create hermes-control --no-skills"');
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual([]);
    expect(await filesContaining(h.root, BOT_TOKEN)).toEqual([]);
    expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
    await expect(fs.access(path.join(h.root, 'sync.lock.json'))).resolves.toBeUndefined();
  });
});

describe('fase 5 — IDEA.md (4.3)', () => {
  // init-fiabilidad (CO-R1): el paso de control ya no escribe IDEA.md; lo escribe la base junto al seed
  // (backlog-seed › «Init writes IDEA.md next to the seed», probado en idea-input-e2e.test.ts).
  it('the control step alone never writes IDEA.md (CO-R1)', async () => {
    const result = await step(ACCEPT, 'Una fábrica de facturas recurrentes');
    expect(result.code, result.text).toBe(0);
    await expect(fs.access(path.join(h.root, 'IDEA.md'))).rejects.toThrow();
  });

  it('keeps an existing IDEA.md byte-identical and writes nothing without an idea', async () => {
    await fs.writeFile(path.join(h.root, 'IDEA.md'), '# Mía\n');
    await step(ACCEPT, 'otra idea');
    expect(await fs.readFile(path.join(h.root, 'IDEA.md'), 'utf8')).toBe('# Mía\n');
    await fs.rm(path.join(h.root, 'IDEA.md'));
    await step(ACCEPT, null);
    await expect(fs.access(path.join(h.root, 'IDEA.md'))).rejects.toThrow();
  });
});

describe('fase 5 — modo no interactivo explícito (5.1)', () => {
  const connect = ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin'];

  async function init(argv: string[], stdin = `${BOT_TOKEN}\n`) {
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await cmdInit(parseArgs(argv), {
      ...stepContext(h, sink),
      controlHost: hermes.host,
      discordFetch: discord.fetch,
      stdin: async () => stdin,
    });
    return { code, text: [...sink.out, ...sink.err].join('\n'), out: sink.out };
  }

  it('connects without questions with the token from standard input', async () => {
    const result = await init(connect);
    expect(result.code, result.text).toBe(0);
    // init-fiabilidad (DEV-08): el resumen de cinco líneas va justo antes de la línea de estado, que cierra stdout.
    expect(result.out.at(-2)).toBe('control: comprueba con ai-hub control enroll --check');
    expect(result.out.at(-1)).toBe('ai-hub-integration: name=control state=completada stage=- action=-');
    expect(result.text).not.toContain(BOT_TOKEN);
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual(['profiles/hermes-control/.env']);
  });

  it('a token as a flag value exits 2 before writing anything', async () => {
    const before = await treeHash(h.root);
    const result = await init(['--preset-only', '--yes', '--connect-hermes', '--discord-token', 'valor-visible']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('--discord-token-stdin');
    expect(await treeHash(h.root)).toBe(before);
  });

  it('unreachable Discord saves only with --allow-unvalidated', async () => {
    discord.tokenStatus = 'network';
    const refused = await init(connect);
    // init-fiabilidad (P-01): con la base verificada, init sale 0 y la integración queda fallida en la etapa discord.
    expect(refused.code).toBe(0);
    expect(refused.out.at(-1)).toBe('ai-hub-integration: name=control state=fallida stage=discord action=ai-hub init --yes --connect-hermes --discord-channel <id> --approver <id> --discord-token-stdin');
    expect(refused.text).toContain('--allow-unvalidated');
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual([]);
    const allowed = await init([...connect, '--allow-unvalidated']);
    expect(allowed.code, allowed.text).toBe(0);
    expect(allowed.out.at(-1)).toBe('ai-hub-integration: name=control state=no-verificable stage=discord action=ai-hub control enroll --check');
  });
});

describe('fase 5 — idempotencia y regresión sin Hermes (5.2, 5.3)', () => {
  it('a second run with the same answers creates nothing and leaves the profile env identical', async () => {
    expect((await step(ACCEPT)).code).toBe(0);
    const env = await fs.readFile(profileEnv(), 'utf8');
    hermes.calls.length = 0;
    const again = await step(ACCEPT);
    expect(again.code, again.text).toBe(0);
    expect(hermes.calls.some((args) => args[0] === 'profile' && args[1] === 'create')).toBe(false);
    expect(creating(hermes.calls).filter((args) => args.includes('subscribe') || (args.includes('cron') && args.includes('create')))).toEqual([]);
    expect(await fs.readFile(profileEnv(), 'utf8')).toBe(env);
  });

  it('init --yes without Hermes prints no control line and writes no control configuration', async () => {
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await cmdInit(parseArgs(['--preset-only', '--yes']), { ...stepContext(h, sink), controlHost: noHermesHost(h.root) });
    expect(code).toBe(0);
    expect(sink.out.join('\n')).not.toMatch(/^control:/m);
    expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
    await expect(fs.access(path.join(h.root, 'IDEA.md'))).rejects.toThrow();
  });
});

describe('fase 4 — documentación (4.5)', () => {
  it('README and SECURITY describe the control step, the only token the package writes and where', async () => {
    const readme = await fs.readFile(path.resolve(__dirname, '..', 'README.md'), 'utf8');
    const security = await fs.readFile(path.resolve(__dirname, '..', 'SECURITY.md'), 'utf8');
    expect(readme).toContain('### Conectar desde `init`');
    expect(readme).toContain('--discord-token-stdin');
    expect(readme).toContain('solo en el `.env` del perfil `hermes-control`');
    expect(readme).not.toContain('ni escribe tokens');
    // init-fiabilidad (DEV-07): la política lista las dos credenciales que se escriben; ya no dice «the only credential».
    expect(security).toContain('## Credentials the package writes');
    expect(security).not.toMatch(/the only credential the package writes/i);
    expect(security).toContain('`hermes-control`');
    for (const text of [readme, security]) {
      expect(text).not.toMatch(/telegram/i);
    }
  });
});

describe('idea-input 5.3 — IDEA.md con el mismo fence y la idea en --connect-hermes', () => {
  const markdownIdea = `## Encabezado de la idea\n\n${'`'.repeat(4)}md\nfence de cuatro\n${'`'.repeat(4)}\nfin`;

  function fencedIdea(text: string): string | null {
    const lines = text.split('\n');
    const open = lines.findIndex((line) => /^`{3,}markdown$/.test(line));
    if (open < 0) {
      return null;
    }
    const fence = lines[open].replace('markdown', '');
    const close = lines.findIndex((line, index) => index > open && line === fence);
    return close < 0 ? null : lines.slice(open + 1, close).join('\n');
  }

  // init-fiabilidad (CO-R1 → SEED-01): el fence lo garantiza el escritor de la base, no el paso de control.
  it('la base escribe IDEA.md con un fence más largo que la racha interna', async () => {
    const sink = { out: [] as string[], err: [] as string[] };
    await writeBacklogSeed(stepContext(h, sink), markdownIdea, 'una prueba');
    expect(sink.out).toEqual([]);
    const ideaFile = await fs.readFile(path.join(h.root, 'IDEA.md'), 'utf8');
    expect(ideaFile).toContain('[backlog/seed.md](backlog/seed.md)');
    expect(ideaFile.split('\n').find((line) => /^`{3,}markdown$/.test(line))).toBe(`${'`'.repeat(5)}markdown`);
    expect(fencedIdea(ideaFile)).toBe(markdownIdea);
  });

  it('init --yes --idea-file … --connect-hermes --discord-token-stdin lleva la idea del archivo a IDEA.md y a seed.md', async () => {
    const ideaPath = path.join(h.root, '..', `idea-${path.basename(h.root)}.md`);
    await fs.writeFile(ideaPath, markdownIdea);
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await cmdInit(
      parseArgs([
        '--preset-only',
        '--yes',
        '--idea-file',
        ideaPath,
        '--connect-hermes',
        '--discord-channel',
        CHANNEL,
        '--approver',
        APPROVER,
        '--discord-token-stdin',
      ]),
      { ...stepContext(h, sink), controlHost: hermes.host, discordFetch: discord.fetch, stdin: async () => `${BOT_TOKEN}\n` },
    );
    const text = [...sink.out, ...sink.err].join('\n');
    expect(code, text).toBe(0);
    expect(sink.out.at(-2)).toBe('control: comprueba con ai-hub control enroll --check');
    expect(sink.out.at(-1)).toBe('ai-hub-integration: name=control state=completada stage=- action=-');
    expect(sink.out).toContain('backlog: seed.md escrito');
    expect(fencedIdea(await fs.readFile(path.join(h.root, 'IDEA.md'), 'utf8'))).toBe(markdownIdea);
    expect(fencedIdea(await fs.readFile(path.join(h.root, 'backlog', 'seed.md'), 'utf8'))).toBe(markdownIdea);
    expect(text).not.toContain(BOT_TOKEN);
    await fs.rm(ideaPath, { force: true });
  });
});

// ── init-fiabilidad 4.1: aislamiento de integraciones y línea de estado (IO-01, IO-02, DEV-08, CO-M1, CO-M3, CO-07) ──

const STATUS = /^ai-hub-integration: name=(\S+) state=(\S+) stage=(\S+) action=(.*)$/;

function assistantPrompts(replies: unknown[]): AssistantPrompts {
  let index = 0;
  const next = (): unknown => (index < replies.length ? replies[index++] : null);
  return {
    intro: () => undefined,
    note: () => undefined,
    multiselect: async () => {
      const reply = next();
      return Array.isArray(reply) ? (reply as string[]) : null;
    },
    select: async () => {
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
    text: async () => {
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
    confirm: async () => next() === true,
    password: async () => {
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    },
  };
}

/** Asistente completo: destinos, perfil, scripts, activo, idea vacía, confirmar, tracker y control. */
const ASSISTANT = [['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true];

async function assistantInit(tracker: unknown[], control: unknown[]) {
  const sink = { out: [] as string[], err: [] as string[] };
  const ctx = { ...stepContext(h, sink), interactive: true, assistantPrompts: assistantPrompts([...ASSISTANT, ...tracker, ...control]), controlHost: hermes.host, discordFetch: discord.fetch };
  const code = await cmdInit(parseArgs([]), ctx);
  return { code, out: sink.out, err: sink.err, text: [...sink.out, ...sink.err].join('\n') };
}

const CONNECT_FLAGS = ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin'];

async function flagsInit(argv: string[], extra: Record<string, unknown> = {}) {
  const sink = { out: [] as string[], err: [] as string[] };
  const code = await cmdInit(parseArgs(argv), { ...stepContext(h, sink), controlHost: hermes.host, discordFetch: discord.fetch, stdin: async () => `${BOT_TOKEN}\n`, ...extra });
  return { code, out: sink.out, err: sink.err, text: [...sink.out, ...sink.err].join('\n') };
}

describe('init-fiabilidad 4.1 — aislamiento y línea de estado', () => {
  it('simulated webhook failure keeps init at 0 (interactive)', async () => {
    hermes.failOn.set('webhook subscribe', { stderr: 'Error: route refused' });
    const result = await assistantInit([''], ACCEPT);
    expect(result.code, result.text).toBe(0);
    expect(result.text).not.toContain('Error inesperado');
    expect(result.out.at(-1)).toBe('ai-hub-integration: name=control state=fallida stage=webhook-route action=ai-hub control enroll --yes');
    expect(result.err.join('\n')).toContain('control');
  }, 60_000);

  it('simulated webhook failure keeps init at 0 (--yes --connect-hermes) and the status line parses', async () => {
    hermes.failOn.set('webhook subscribe', { stderr: 'Error: route refused' });
    const result = await flagsInit(CONNECT_FLAGS);
    expect(result.code, result.text).toBe(0);
    expect(result.text).not.toContain('Error inesperado');
    const match = STATUS.exec(result.out.at(-1) ?? '');
    expect(match?.slice(1)).toEqual(['control', 'fallida', 'webhook-route', 'ai-hub control enroll --yes']);
  }, 60_000);

  it('unexpected error inside an integration is a state', async () => {
    const exec = hermes.host.exec;
    hermes.host = {
      ...hermes.host,
      exec: async (command, args, options) => {
        if (args.includes('cron') && args.includes('create')) {
          throw new Error('kaboom');
        }
        return exec(command, args, options);
      },
    };
    const result = await flagsInit(CONNECT_FLAGS);
    expect(result.code, result.text).toBe(0);
    expect(result.text).not.toContain('Error inesperado');
    expect(STATUS.exec(result.out.at(-1) ?? '')?.slice(1)).toEqual(['control', 'fallida', 'cron', 'ai-hub control enroll --yes']);
  }, 60_000);

  it('both skipped are no-solicitada', async () => {
    const result = await assistantInit([''], ['']);
    expect(result.code, result.text).toBe(0);
    expect(result.out.slice(-2)).toEqual([
      'ai-hub-integration: name=tracker state=no-solicitada stage=- action=-',
      'ai-hub-integration: name=control state=no-solicitada stage=- action=-',
    ]);
  }, 60_000);

  it('invalid connection args exit 2 before applying', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-args-'));
    await fs.writeFile(path.join(fresh, 'package.json'), JSON.stringify({ name: 'demo' }));
    const sink = { out: [] as string[], err: [] as string[] };
    const ctx = { ...stepContext(h, sink), cwd: fresh, root: fresh, controlHost: hermes.host, discordFetch: discord.fetch, stdin: async () => BOT_TOKEN };
    const code = await cmdInit(parseArgs(['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', 'persona', '--discord-token-stdin']), ctx);
    expect(code).toBe(2);
    expect(await fs.readdir(fresh)).toEqual(['package.json']);
    expect(sink.out.join('\n')).not.toContain('ai-hub-integration:');
    expect(hermes.calls).toEqual([]);
    await fs.rm(fresh, { recursive: true, force: true });
  });

  it('base failure prints no status line', async () => {
    await fs.mkdir(path.join(h.root, 'backlog', 'seed.md'), { recursive: true });
    const ideaPath = path.join(h.root, '..', `idea-base-${path.basename(h.root)}.md`);
    await fs.writeFile(ideaPath, 'una idea\n');
    const result = await flagsInit([...CONNECT_FLAGS, '--idea-file', ideaPath]);
    expect(result.code).not.toBe(0);
    expect(result.text).not.toContain('ai-hub-integration:');
    expect(hermes.calls).toEqual([]);
    await fs.rm(ideaPath, { force: true });
  });

  it('without Hermes equals with Hermes skipped (CO-M3)', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-nohermes-'));
    const runs: Array<{ code: number; tree: string; calls: number }> = [];
    for (const [name, host] of [['sin', noHermesHost(base)], ['con', hermes.host]] as const) {
      const dir = path.join(base, name, 'consumer');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
      const before = hermes.calls.length;
      const sink = { out: [] as string[], err: [] as string[] };
      const code = await cmdInit(parseArgs(['--preset-only', '--no-speckit', '--yes']), { ...stepContext(h, sink), cwd: dir, root: dir, controlHost: host });
      const names = (await fs.readdir(dir, { recursive: true })).map((entry) => String(entry).replace(/\\/g, '/')).filter((entry) => !entry.startsWith('.backups')).sort();
      runs.push({ code, tree: names.join('|'), calls: hermes.calls.length - before });
    }
    expect(runs[0].code).toBe(runs[1].code);
    expect(runs[0].tree).toBe(runs[1].tree);
    expect(runs.map((run) => run.calls)).toEqual([0, 0]);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 60_000);
});

describe('init-fiabilidad 8.5 — identidad antes de escribir la conexión', () => {
  it('a profile created by init gets the managed block and its backup before the profile .env', async () => {
    const stages: string[] = [];
    const result = await flagsInit(CONNECT_FLAGS, {
      onConnectStage: (stage: string) => {
        stages.push(stage);
      },
    });
    expect(result.code, result.text).toBe(0);
    expect(result.out.at(-1)).toBe('ai-hub-integration: name=control state=completada stage=- action=-');
    expect(await fs.readFile(path.join(hermes.home, 'profiles', 'hermes-control', 'SOUL.md'), 'utf8')).toContain('<!-- ai-hub:soul:begin');
    expect(await fs.readFile(path.join(hermes.home, 'profiles', 'hermes-control', 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
    const identity = stages.indexOf('identity-block');
    expect(stages.indexOf('profile')).toBeLessThan(identity);
    expect(identity).toBeLessThan(stages.indexOf('env'));
    expect(stages.indexOf('env')).toBeLessThan(stages.indexOf('manifest'));
    expect((await loadManifestContext(h.root)).manifest.control).toBeDefined();
  }, 60_000);

  it('an existing unmarked SOUL.md without a terminal stays pending and writes neither .env nor manifest.control', async () => {
    const dir = path.join(hermes.home, 'profiles', 'hermes-control');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SOUL.md'), DEFAULT_SOUL);
    await fs.writeFile(path.join(dir, '.env'), DEFAULT_PROFILE_ENV);
    const result = await flagsInit(CONNECT_FLAGS);
    expect(result.code, result.text).toBe(0);
    expect(result.out.at(-1)).toContain('name=control state=pendiente stage=identity action=aparta');
    expect(result.out.at(-1)).toContain('--discord-token-stdin');
    expect(await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe(DEFAULT_SOUL);
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(DEFAULT_PROFILE_ENV);
    expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
  }, 60_000);
});

describe('init-fiabilidad 8.9 — resumen solo tras el check', () => {
  it('gateway not running leaves the step pending and prints no success summary', async () => {
    hermes.gatewayRunning = false;
    // webhook-operativo D-A: con el gateway parado se intenta un reinicio; aquí falla y queda pendiente.
    hermes.failOn.set('gateway restart', { stderr: 'unit failed to start' });
    const result = await flagsInit(CONNECT_FLAGS);
    expect(result.code, result.text).toBe(0);
    expect(result.out.at(-1)).toBe('ai-hub-integration: name=control state=pendiente stage=gateway action=hermes gateway restart');
    expect(result.text).toContain('[FAIL] gateway');
    expect(result.out.join('\n')).not.toContain('control: perfil hermes-control');
    expect(result.text).not.toContain('state=completada');
  }, 60_000);

  it('completeness passing still prints the five-line summary and completada', async () => {
    const result = await flagsInit(CONNECT_FLAGS);
    expect(result.code, result.text).toBe(0);
    expect(result.out.at(-2)).toBe('control: comprueba con ai-hub control enroll --check');
    expect(result.out.at(-1)).toBe('ai-hub-integration: name=control state=completada stage=- action=-');
  }, 60_000);
});

describe('init-fiabilidad 1.3 / 8.5–8.6 — interrupción en cada etapa', () => {
  it.each(['profile', 'identity-before-backup', 'identity-backup', 'identity-block', 'env', 'manifest'])(
    'an interruption after %s leaves the tree as persisted and reports a state',
    async (stage) => {
      const result = await flagsInit(CONNECT_FLAGS, {
        onConnectStage: (done: string) => {
          if (done === stage) {
            throw new SimulatedCrash(done);
          }
        },
      });
      expect(result.code, result.text).toBe(0);
      expect(result.text).not.toContain('Error inesperado');
      expect(STATUS.exec(result.out.at(-1) ?? '')).not.toBeNull();
      const dir = path.join(hermes.home, 'profiles', 'hermes-control');
      const soul = await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8');
      const env = await fs.readFile(path.join(dir, '.env'), 'utf8').catch(() => '');
      const manifest = (await loadManifestContext(h.root)).manifest;
      if (stage === 'profile' || stage === 'identity-before-backup') {
        expect(soul).toBe(DEFAULT_SOUL);
        await expect(fs.access(path.join(dir, 'SOUL.md.pre-ai-hub'))).rejects.toThrow();
      }
      if (stage === 'identity-backup') {
        expect(soul).toBe(DEFAULT_SOUL);
        expect(await fs.readFile(path.join(dir, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
      }
      if (stage === 'identity-block') {
        expect(soul).toContain('<!-- ai-hub:soul:begin');
        expect(await fs.readFile(path.join(dir, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
      }
      if (stage === 'profile' || stage === 'identity-before-backup' || stage === 'identity-backup' || stage === 'identity-block') {
        expect(env).not.toContain('DISCORD_BOT_TOKEN');
        expect(manifest.control).toBeUndefined();
      }
      if (stage === 'env') {
        expect(env).toContain(`DISCORD_BOT_TOKEN=${BOT_TOKEN}`);
        expect(manifest.control).toBeUndefined();
      }
      if (stage === 'manifest') {
        expect(env).toContain(`DISCORD_BOT_TOKEN=${BOT_TOKEN}`);
        expect(manifest.control).toBeDefined();
      }
    },
    60_000,
  );
});

describe('init-fiabilidad 8.7 — adopción interactiva', () => {
  async function existingUnmarked(): Promise<string> {
    const dir = path.join(hermes.home, 'profiles', 'hermes-control');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SOUL.md'), DEFAULT_SOUL);
    await fs.writeFile(path.join(dir, '.env'), DEFAULT_PROFILE_ENV);
    return dir;
  }

  it('adoption accepted names the file and backs it up', async () => {
    const dir = await existingUnmarked();
    const result = await step([...ACCEPT, true]);
    expect(result.code, result.text).toBe(0);
    expect(result.asked.some((call) => call.startsWith('confirm:') && call.includes(path.join(dir, 'SOUL.md')) && call.includes('SOUL.md.pre-ai-hub'))).toBe(true);
    expect(await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8')).toContain('<!-- ai-hub:soul:begin');
    expect(await fs.readFile(path.join(dir, 'SOUL.md.pre-ai-hub'), 'utf8')).toBe(DEFAULT_SOUL);
  }, 60_000);

  it('adoption declined leaves SOUL.md byte-identical and the identity pending', async () => {
    const dir = await existingUnmarked();
    const result = await step([...ACCEPT, false]);
    expect(result.code).toBe(1);
    expect(await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe(DEFAULT_SOUL);
    await expect(fs.access(path.join(dir, 'SOUL.md.pre-ai-hub'))).rejects.toThrow();
    expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
    expect(result.err.join('\n')).toContain('identidad quedó pendiente');
  }, 60_000);

  it('enroll never prompts and reports an unmarked existing identity as pending', async () => {
    const dir = await existingUnmarked();
    await fs.writeFile(path.join(dir, '.env'), `DISCORD_BOT_TOKEN=${BOT_TOKEN}\n`);
    await fs.appendFile(
      path.join(h.root, 'manifest.yaml'),
      `control:\n  approvers:\n    - "${APPROVER}"\n  ttlHours: 24\n  expire: block\n`,
    );
    const outcome = await runEnroll(h.root, { mode: 'yes', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(1);
    expect(outcome.pending, outcome.lines.join('\n')).toBe(true);
    expect(outcome.stage).toBe('identity');
    expect(outcome.action).toContain('aparta');
    expect(outcome.action).toContain('ai-hub control enroll --yes');
    expect(await fs.readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe(DEFAULT_SOUL);
  }, 60_000);
});

describe('init-fiabilidad 4.5 — flags de conexión validados antes del apply (CO-07)', () => {
  it('invalid approver exits 2 before applying, the tree byte-identical', async () => {
    const before = await treeHash(h.root);
    const result = await flagsInit(['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', 'persona', '--discord-token-stdin']);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('Uso: ai-hub init --yes --connect-hermes');
    expect(await treeHash(h.root)).toBe(before);
    expect(hermes.calls).toEqual([]);
  });

  it('missing --discord-token-stdin, bad TTL and unknown expiry exit 2 before applying', async () => {
    const before = await treeHash(h.root);
    for (const argv of [
      ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER],
      ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin', '--ttl-hours', '0'],
      ['--preset-only', '--yes', '--connect-hermes', '--discord-channel', CHANNEL, '--approver', APPROVER, '--discord-token-stdin', '--expire', 'never'],
    ]) {
      expect((await flagsInit(argv)).code).toBe(2);
    }
    expect(await treeHash(h.root)).toBe(before);
  });

  it('token flag before applying (existing guard, still byte-identical)', async () => {
    const before = await treeHash(h.root);
    const result = await flagsInit(['--preset-only', '--yes', '--connect-hermes', '--discord-token', 'abc']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('--discord-token-stdin');
    expect(await treeHash(h.root)).toBe(before);
  });
});

describe('init-fiabilidad 4.7 — sin secretos en el resumen (IO-03)', () => {
  it('no sentinel in status output: tracker and control tokens never reach the summary, warnings or status lines', async () => {
    const TRACKER_SENTINEL = 'AIHUB_TRACKER_SENTINEL_4c7d';
    await fs.rm(path.join(h.root, '.ai-hub', '.env'), { force: true });
    hermes.failOn.set('webhook subscribe', { stderr: `Error: route refused for ${BOT_TOKEN}` });
    const result = await assistantInit(['s', 'https://gitlab.example.invalid', TRACKER_SENTINEL], ACCEPT);
    expect(result.code, result.text).toBe(0);
    expect(result.out.slice(-2)).toEqual([
      'ai-hub-integration: name=tracker state=completada stage=- action=-',
      'ai-hub-integration: name=control state=fallida stage=webhook-route action=ai-hub control enroll --yes',
    ]);
    expect(result.text).not.toContain(TRACKER_SENTINEL);
    expect(result.text).not.toContain(BOT_TOKEN);
  }, 60_000);
});

describe('init-fiabilidad 4.8 — acción según lo persistido (HC-12, HC-13)', () => {
  const enroll = (mode: 'yes' | 'check') => runEnroll(h.root, { mode, host: hermes.host });

  it('failure before manifest.control announces the retake (R4: interrupted after the profile .env)', async () => {
    // 1. Estado exacto de R4: la conexión se interrumpe tras escribir el .env del perfil (nada se completa a mano).
    const crashed = await flagsInit(CONNECT_FLAGS, {
      onConnectStage: (done: string) => {
        if (done === 'env') {
          throw new SimulatedCrash('env');
        }
      },
    });
    expect(crashed.code).toBe(0);
    expect(STATUS.exec(crashed.out.at(-1) ?? '')?.slice(1)).toEqual(['control', 'fallida', 'manifest', RETAKE_ACTION]);
    expect(crashed.err.join('\n')).toContain('aporta de nuevo: token');
    const env = await fs.readFile(profileEnv(), 'utf8');
    expect(parseDotenv(env).DISCORD_BOT_TOKEN).toBe(BOT_TOKEN);
    expect((await loadManifestContext(h.root)).manifest.control).toBeUndefined();
    // 2. enroll --yes no puede retomarla: sale 1, anuncia la misma acción y no escribe nada.
    const before = [await treeHash(h.root), await treeHash(hermes.home)];
    const refused = await enroll('yes');
    expect(refused.code).toBe(1);
    expect(refused.lines.join('\n')).toContain('falta manifest.control');
    expect(refused.lines.join('\n')).toContain(RETAKE_ACTION);
    expect([await treeHash(h.root), await treeHash(hermes.home)]).toEqual(before);
    // 3. La acción anunciada, con el mismo token por stdin: la línea del token no cambia y manifest.control se escribe.
    const tokenLine = env.split('\n').find((line) => line.startsWith('DISCORD_BOT_TOKEN='));
    const retaken = await flagsInit(CONNECT_FLAGS);
    expect(retaken.code, retaken.text).toBe(0);
    expect(retaken.out.at(-1)).toBe('ai-hub-integration: name=control state=completada stage=- action=-');
    expect((await fs.readFile(profileEnv(), 'utf8')).split('\n').find((line) => line.startsWith('DISCORD_BOT_TOKEN='))).toBe(tokenLine);
    expect((await loadManifestContext(h.root)).manifest.control).toBeDefined();
  }, 120_000);

  it('enroll without manifest.control exits 1 with the action (yes and check), never as an unexpected error', async () => {
    for (const mode of ['yes', 'check'] as const) {
      hermes.calls.length = 0;
      const outcome = await enroll(mode);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join('\n')).toContain('la conexión del plano de control no está guardada');
      expect(outcome.lines.join('\n')).toContain(RETAKE_ACTION);
      expect(creating(hermes.calls)).toEqual([]);
    }
  });

  it('route failure announces enroll --yes (R5): the cron already exists, so after removing the fault only the route is created', async () => {
    hermes.failOn.set('webhook subscribe', { stderr: 'Error: route refused' });
    const failed = await flagsInit(CONNECT_FLAGS);
    expect(failed.code).toBe(0);
    expect(STATUS.exec(failed.out.at(-1) ?? '')?.slice(1)).toEqual(['control', 'fallida', 'webhook-route', 'ai-hub control enroll --yes']);
    hermes.failOn.delete('webhook subscribe');
    hermes.calls.length = 0;
    const resumed = await enroll('yes');
    expect(resumed.code, resumed.lines.join('\n')).toBe(0);
    expect(creating(hermes.calls).map((args) => (args[0] === '-p' ? args.slice(2, 4) : args.slice(0, 2)).join(' '))).toEqual(['webhook subscribe', 'gateway restart']);
    hermes.calls.length = 0;
    expect((await enroll('yes')).code).toBe(0);
    expect(creating(hermes.calls)).toEqual([]);
  }, 120_000);
});
