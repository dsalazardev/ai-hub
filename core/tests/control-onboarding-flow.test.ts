import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from '../src/cli/args.js';
import { cmdInit } from '../src/cli/onboarding.js';
import { offerControlStep } from '../src/control/onboard-step.js';
import { parseDotenv } from '../src/env/dotenv.js';
import { loadManifestContext } from '../src/manifest/manifest.js';
import {
  APPROVER,
  BOT_TOKEN,
  CHANNEL,
  OTHER_TOKEN,
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
    expect(result.notes.join('\n')).toContain('El bot no ve ese canal');
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
    expect((await loadManifestContext(h.root)).manifest.control).toEqual({ approvers: [APPROVER], ttlHours: 24, expire: 'block', pollMinutes: 15 });
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
  it('refuses a token already used by another profile, naming it and printing nothing secret', async () => {
    const other = path.join(hermes.home, 'profiles', 'personal');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, '.env'), `DISCORD_BOT_TOKEN=${BOT_TOKEN}\n`);
    const result = await step(ACCEPT);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('el bot del perfil "personal"');
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
    expect(manifest.control).toEqual({ approvers: [APPROVER], ttlHours: 24, expire: 'block', pollMinutes: 15 });
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
    const run = async (name: string, control: Array<string | boolean | null>) => {
      // Mismo nombre de carpeta en los dos: el nombre del proyecto (que sale de la carpeta) entra en el plan.
      const dir = path.join(h.root, 'plans', name, 'consumer');
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
  }, { timeout: 300_000 });
});

describe('fase 4 — enroll, gateway y resumen (4.1, 4.2, 4.4)', () => {
  it('runs the enrolment and ends with a gateway restart and exactly five summary lines', async () => {
    const result = await step(ACCEPT);
    expect(result.code, result.text).toBe(0);
    const writes = creating(hermes.calls).map((args) => args.join(' '));
    expect(writes.some((line) => line.includes('webhook subscribe ai-hub-gitlab'))).toBe(true);
    expect(writes.some((line) => line.includes('cron create'))).toBe(true);
    expect(writes.at(-1)).toBe('gateway restart');
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
  it('writes IDEA.md with the idea, the date and the seed link only when absent', async () => {
    const result = await step(ACCEPT, 'Una fábrica de facturas recurrentes');
    expect(result.code, result.text).toBe(0);
    const idea = await fs.readFile(path.join(h.root, 'IDEA.md'), 'utf8');
    expect(idea).toContain('Una fábrica de facturas recurrentes');
    expect(idea).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(idea).toContain('[backlog/seed.md](backlog/seed.md)');
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
    expect(result.out.at(-1)).toBe('control: comprueba con ai-hub control enroll --check');
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
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('--allow-unvalidated');
    expect(await filesContaining(hermes.home, BOT_TOKEN)).toEqual([]);
    const allowed = await init([...connect, '--allow-unvalidated']);
    expect(allowed.code, allowed.text).toBe(0);
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
    expect(security).toContain('The only credential the package writes');
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

  it('el paso interactivo escribe IDEA.md con un fence más largo que la racha interna', async () => {
    expect((await step(ACCEPT, markdownIdea)).code).toBe(0);
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
    expect(sink.out.at(-1)).toBe('control: comprueba con ai-hub control enroll --check');
    expect(sink.out).toContain('backlog: seed.md escrito');
    expect(fencedIdea(await fs.readFile(path.join(h.root, 'IDEA.md'), 'utf8'))).toBe(markdownIdea);
    expect(fencedIdea(await fs.readFile(path.join(h.root, 'backlog', 'seed.md'), 'utf8'))).toBe(markdownIdea);
    expect(text).not.toContain(BOT_TOKEN);
    await fs.rm(ideaPath, { force: true });
  });
});
