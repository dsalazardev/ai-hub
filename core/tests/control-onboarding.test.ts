import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LATER_LINE, offerControlStep } from '../src/control/onboard-step.js';
import { APPROVER, checkBotToken, resolveChannel, type DiscordFetch } from '../src/control/onboard.js';
import { BOT_TOKEN, CHANNEL, creating, fakeHermes, noHermesHost, scripted, stepContext, treeHash } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/** control-onboarding, fase 1: detección de Hermes, pregunta de entrada y gating (helpers en control-onboarding-fake.ts). */

let h: Harness;

beforeEach(async () => {
  h = await harness();
  await h.consumer({ control: false });
});

afterEach(async () => {
  await h.dispose();
});

describe('fase 1 — detección y pregunta de entrada (1.2, 1.3)', () => {
  it('without Hermes it asks nothing and names control enroll for later', async () => {
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s']);
    const code = await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: noHermesHost(h.root) }), null);
    expect(code).toBe(0);
    expect(script.asked).toEqual([]);
    expect(sink.out).toEqual([LATER_LINE]);
  });

  it('with Hermes 0.23.0 the last question names the version, the own bot and the gateway restart', async () => {
    const hermes = await fakeHermes(h.root);
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['']);
    await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: hermes.host }), null);
    expect(script.asked).toHaveLength(1);
    expect(script.asked[0]).toBe(
      'text:Hermes v0.23.0 detectado. ¿Conectar el plano de control ahora? Crea el perfil hermes-control con TU bot, escribe su .env (token del bot, usuarios y canales permitidos y, si faltan, WEBHOOK_ENABLED y WEBHOOK_PORT), su skill, sus scripts y el bloque gestionado de SOUL.md, crea la ruta del webhook y el cron, y reinicia el gateway de Hermes si está instalado. (escribe "s" para conectar; vacío = saltar)',
    );
  });

  it('an older Hermes is not offered and the message names both versions', async () => {
    const hermes = await fakeHermes(h.root, '0.22.9');
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s']);
    await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: hermes.host }), null);
    expect(script.asked).toEqual([]);
    expect(sink.out.join('\n')).toContain('0.22.9');
    expect(sink.out.join('\n')).toContain('0.23.0');
  });

  it.each([
    ['empty answer', ['']],
    ['cancel at the entry question', [null]],
  ])('%s: zero writes in the repository and the Hermes home', async (_label, replies) => {
    const hermes = await fakeHermes(h.root);
    await fs.mkdir(hermes.home, { recursive: true });
    const before = [await treeHash(h.root), await treeHash(hermes.home)];
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await offerControlStep(scripted(replies).prompts, stepContext(h, sink, { controlHost: hermes.host }), 'una idea');
    expect(code).toBe(0);
    expect(sink.out.join('\n')).toContain('no se escribió nada');
    expect([await treeHash(h.root), await treeHash(hermes.home)]).toEqual(before);
    expect(creating(hermes.calls)).toEqual([]);
  });
});

describe('fase 1 — sin terminal o con --yes no pregunta (1.4)', () => {
  it('init --yes with a TTY, masked prompts and Hermes installed asks nothing and runs no Hermes command', async () => {
    const hermes = await fakeHermes(h.root);
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s', BOT_TOKEN]);
    const { cmdInit } = await import('../src/cli/onboarding.js');
    const { parseArgs } = await import('../src/cli/args.js');
    const code = await cmdInit(parseArgs(['--preset-only', '--yes']), {
      ...stepContext(h, sink),
      interactive: true,
      assistantPrompts: script.prompts,
      controlHost: hermes.host,
    });
    expect(code).toBe(0);
    expect(script.asked).toEqual([]);
    expect(hermes.calls).toEqual([]);
    expect(sink.out.join('\n')).not.toMatch(/^control:/m);
  });
});

// ── init-fiabilidad 7.1–7.7: clasificación, evidencia, nombres, colisión y diagnósticos ────────────────

const BOT_ID = '111111111111111111';
const OTHER_CHANNEL = '222222222222222222';

interface DiscordApiConfig {
  tokenStatus?: number;
  tokenCode?: number;
  channelStatus?: number;
  channelStatuses?: Record<string, number>;
  channelCodes?: Record<string, number>;
  channelBodyMessage?: string;
  guildStatus?: number;
  guilds?: Array<{ id: string; name: string }>;
  channelsByGuild?: Record<string, Array<{ id: string; name: string; type: number }>>;
  guildChannelStatuses?: Record<string, number>;
}

function discordApi(config: DiscordApiConfig = {}): { fetch: DiscordFetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const guilds = config.guilds ?? [{ id: '555', name: 'Servidor' }];
  const channelsByGuild = config.channelsByGuild ?? { '555': [{ id: CHANNEL, name: 'control', type: 0 }] };
  const fetch: DiscordFetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    expect(url).not.toContain(BOT_TOKEN);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const pathname = url.replace('https://discord.com/api/v10', '');
    if (pathname === '/users/@me') {
      return config.tokenStatus === undefined || config.tokenStatus === 200
        ? json(200, { id: BOT_ID, username: 'ai-hub-control-bot' })
        : json(config.tokenStatus, { code: config.tokenCode ?? 0, message: 'body-must-not-be-printed' });
    }
    if (pathname === '/users/@me/guilds') {
      return config.guildStatus === undefined || config.guildStatus === 200
        ? json(200, guilds)
        : json(config.guildStatus, { code: 0, message: 'body-must-not-be-printed' });
    }
    const guild = /^\/guilds\/(\d+)\/channels$/.exec(pathname);
    if (guild) {
      const status = config.guildChannelStatuses?.[guild[1]];
      return status !== undefined && status !== 200
        ? json(status, { code: 0, message: 'body-must-not-be-printed' })
        : json(200, channelsByGuild[guild[1]] ?? []);
    }
    const channel = /^\/channels\/(\d+)$/.exec(pathname);
    if (channel) {
      const status = config.channelStatuses?.[channel[1]] ?? config.channelStatus ?? (channelsByGuild['555']?.some((item) => item.id === channel[1]) ? 200 : 404);
      const found = Object.values(channelsByGuild).flat().find((item) => item.id === channel[1]);
      return status === 200 && found
        ? json(200, found)
        : json(status, { code: config.channelCodes?.[channel[1]] ?? 0, message: config.channelBodyMessage ?? 'body-must-not-be-printed' });
    }
    return json(404, { code: 0, message: 'body-must-not-be-printed' });
  };
  return { fetch, urls, headers };
}

const CONTROL_ACCEPT = ['s', BOT_TOKEN, CHANNEL, APPROVER, '', ''];

async function discordStep(replies: Array<string | boolean | null>, api: { fetch: DiscordFetch }) {
  const sink = { out: [] as string[], err: [] as string[] };
  const script = scripted(replies);
  const code = await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: (await fakeHermes(h.root)).host, discordFetch: api.fetch }), null);
  return { code, out: sink.out, err: sink.err, notes: script.notes, asked: script.asked, text: [...sink.out, ...sink.err, ...script.notes, ...script.asked].join('\n') };
}

describe('init-fiabilidad 7.2–7.4 — estado HTTP, clase y evidencia independiente', () => {
  it.each([
    [401, 'rejected', 'token-rejected'],
    [403, 'rejected', 'token-rejected'],
    [429, 'unreachable', 'rate-limited'],
    [503, 'unreachable', 'temporary'],
  ] as const)('token HTTP %s is classified as %s/%s', async (status, kind, classification) => {
    const check = await checkBotToken(discordApi({ tokenStatus: status }).fetch, BOT_TOKEN);
    expect(check.kind).toBe(kind);
    expect(check).toMatchObject({ failure: { operation: 'token', status, classification } });
  });

  it.each([
    [403, 'access-refused'],
    [404, 'not-visible'],
    [429, 'rate-limited'],
    [503, 'temporary'],
  ] as const)('channel HTTP %s keeps its class %s', async (status, classification) => {
    const channel = await resolveChannel(discordApi({ channelStatus: status }).fetch, BOT_TOKEN, CHANNEL);
    expect(channel.kind).toBe('not-visible');
    expect(channel).toMatchObject({ failure: { operation: 'channel', status, classification } });
  });

  it('a 403 plus an empty server list proves the bot is in no server', async () => {
    const api = discordApi({ channelStatus: 403, guilds: [] });
    const channel = await resolveChannel(api.fetch, BOT_TOKEN, CHANNEL);
    expect(channel).toMatchObject({ kind: 'not-visible', evidence: 'no-server' });
    const result = await discordStep(['s', BOT_TOKEN, CHANNEL, null], api);
    expect(result.notes.join('\n')).toContain('no está en ningún servidor');
  });

  it('a 403 whose server list answers 429 stays at the status level and names the failed list', async () => {
    const api = discordApi({ channelStatus: 403, guildStatus: 429 });
    const channel = await resolveChannel(api.fetch, BOT_TOKEN, CHANNEL);
    expect(channel).toMatchObject({ kind: 'not-visible', evidence: 'none', serverListStatus: 429 });
    const result = await discordStep(['s', BOT_TOKEN, CHANNEL, null], api);
    expect(result.notes.join('\n')).toContain('lista de servidores no se pudo leer (HTTP 429)');
  });

  it('a 404 whose id is in the server list identifies a server id', async () => {
    const serverId = '777777777777777777';
    const api = discordApi({ guilds: [{ id: serverId, name: 'Servidor' }], channelsByGuild: { [serverId]: [] } });
    const channel = await resolveChannel(api.fetch, BOT_TOKEN, serverId);
    expect(channel).toMatchObject({ kind: 'not-visible', evidence: 'server' });
  });

  it('a 404 with the bot id identifies the bot user id', async () => {
    const api = discordApi({ channelStatuses: { [BOT_ID]: 404 }, guilds: [] });
    const result = await discordStep(['s', BOT_TOKEN, BOT_ID, null], api);
    expect(result.notes.join('\n')).toContain('id de usuario del bot');
  });

  it('an unknown 404 claims only that no channel is visible', async () => {
    const api = discordApi({ channelStatus: 404 });
    const result = await discordStep(['s', BOT_TOKEN, CHANNEL, null], api);
    expect(result.notes.join('\n')).toContain('Ningún canal con ese id es visible');
    expect(result.notes.join('\n')).not.toContain('no existe');
  });
});

describe('init-fiabilidad 7.5 — nombres, ambigüedad y tipos', () => {
  it('trims, accepts one # and compares case-insensitively', async () => {
    const api = discordApi({ channelsByGuild: { '555': [{ id: CHANNEL, name: 'leon-builder', type: 0 }] } });
    const result = await discordStep(['s', BOT_TOKEN, ' #Leon-Builder ', APPROVER, '', ''], api);
    expect(result.code, result.text).toBe(0);
    expect(result.notes.join('\n')).toContain(`Canal: ${CHANNEL} (#leon-builder)`);
  });

  it('lists both servers and the id when the same name exists twice', async () => {
    const api = discordApi({
      guilds: [{ id: '555', name: 'A' }, { id: '777', name: 'B' }],
      channelsByGuild: {
        '555': [{ id: CHANNEL, name: 'control', type: 0 }],
        '777': [{ id: OTHER_CHANNEL, name: 'control', type: 0 }],
      },
    });
    const result = await discordStep(['s', BOT_TOKEN, 'control', null], api);
    const text = result.notes.join('\n');
    expect(text).toContain(`A / #control (${CHANNEL})`);
    expect(text).toContain(`B / #control (${OTHER_CHANNEL})`);
    expect(text).toContain('id numérico');
  });

  it('reports a voice channel named general as an incompatible type', async () => {
    const api = discordApi({ channelsByGuild: { '555': [{ id: CHANNEL, name: 'general', type: 2 }] } });
    const result = await discordStep(['s', BOT_TOKEN, 'general', null], api);
    expect(result.notes.join('\n')).toContain('incompatible');
    expect(result.notes.join('\n')).toContain('voz');
  });

  it('names a server whose channel list could not be searched and its status', async () => {
    const api = discordApi({
      guilds: [{ id: '555', name: 'A' }, { id: '777', name: 'B' }],
      channelsByGuild: { '555': [], '777': [] },
      guildChannelStatuses: { '555': 403 },
    });
    const result = await discordStep(['s', BOT_TOKEN, 'control', null], api);
    expect(result.notes.join('\n')).toContain('A (HTTP 403)');
  });
});

describe('init-fiabilidad 7.6–7.7 — colisión temprana y diagnósticos acotados', () => {
  it('checks a token collision before asking for the channel', async () => {
    const hermes = await fakeHermes(h.root);
    const other = path.join(hermes.home, 'profiles', 'personal');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, '.env'), `DISCORD_BOT_TOKEN=${BOT_TOKEN}\n`);
    const sink = { out: [] as string[], err: [] as string[] };
    const script = scripted(['s', BOT_TOKEN]);
    const code = await offerControlStep(script.prompts, stepContext(h, sink, { controlHost: hermes.host, discordFetch: discordApi().fetch }), null);
    expect(code).toBe(0);
    expect(script.asked.filter((call) => call.includes('Canal de Discord'))).toEqual([]);
    expect(script.notes.join('\n')).toContain('personal');
    expect(script.notes.join('\n')).not.toContain(BOT_TOKEN);
  });

  it('prints a diagnostic with operation, status, class and code, never the body', async () => {
    const api = discordApi({ channelStatus: 404, channelCodes: { [CHANNEL]: 50035 }, channelBodyMessage: 'AIHUB_DISCORD_BODY_SENTINEL' });
    const result = await discordStep(['s', BOT_TOKEN, CHANNEL, null], api);
    const diagnostic = result.err.find((line) => line.startsWith('discord:'));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain('operation=channel');
    expect(diagnostic).toContain('status=404');
    expect(diagnostic).toContain('class=not-visible');
    expect(diagnostic).toContain('code=50035');
    expect(result.text).not.toContain('AIHUB_DISCORD_BODY_SENTINEL');
    expect(result.text).not.toContain('Authorization');
  });

  it('shows one diagnostic for a 503 and then resolves the retried channel', async () => {
    const api = discordApi();
    let attempts = 0;
    const fetch: DiscordFetch = async (url, init) => {
      if (url.includes(`/channels/${CHANNEL}`) && attempts++ === 0) {
        return { status: 503, json: async () => ({ message: 'body-must-not-be-printed' }) };
      }
      return api.fetch(url, init);
    };
    const result = await discordStep(['s', BOT_TOKEN, CHANNEL, CHANNEL, APPROVER, '', ''], { fetch });
    expect(result.code, result.text).toBe(0);
    const diagnostics = result.err.filter((line) => line.startsWith('discord:'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('status=503');
    expect(diagnostics[0]).toContain('class=temporary');
    expect(result.notes.join('\n')).toContain('Discord falló temporalmente');
    expect(result.notes.join('\n')).toContain(`Canal: ${CHANNEL}`);
  });

  it('never prints the sentinel token or Authorization through 401 and 404', async () => {
    let tokenCalls = 0;
    const api = discordApi({ channelCodes: { [CHANNEL]: 50035 } });
    const fetch: DiscordFetch = async (url, init) => {
      if (url.endsWith('/users/@me') && tokenCalls++ === 0) {
        return { status: 401, json: async () => ({ code: 0, message: `bad ${BOT_TOKEN}` }) };
      }
      return api.fetch(url, init);
    };
    const result = await discordStep(['s', BOT_TOKEN, BOT_TOKEN, CHANNEL, null], { fetch });
    expect(result.text).not.toContain(BOT_TOKEN);
    expect(result.text).not.toContain('Authorization');
    expect(result.err.some((line) => line.startsWith('discord:') && line.includes('status=401'))).toBe(true);
  });

  it('a rate-limited token is not offered as "save without validation"', async () => {
    const api = discordApi({ tokenStatus: 429 });
    const result = await discordStep(['s', BOT_TOKEN, null], api);
    expect(result.asked.some((call) => call.startsWith('confirm:') && call.includes('sin validar'))).toBe(false);
    expect(result.notes.join('\n')).toContain('429');
    expect(result.notes.join('\n')).toContain('reintenta');
  });
});
