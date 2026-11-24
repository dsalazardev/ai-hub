import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runEnroll, PROFILE } from '../src/control/enroll.js';
import { HermesNotFoundError, HermesVersionError, hermesCandidates, hermesHome, resolveHermes, type ResolverHost } from '../src/control/hermes.js';
import type { ProcessRunner, RunResult } from '../src/speckit/runner.js';
import { harness, type Harness } from './control-harness.js';

/** hermes-control, fase 4: resolver de Hermes y enroll con un falso del CLI de Hermes. */

const WEBHOOK_SECRET_SENTINEL = 'AIHUB_WEBHOOK_SECRET_SENTINEL_31f0';
const BOT_TOKEN_SENTINEL = 'AIHUB_BOT_TOKEN_SENTINEL_7a2d';

// ── Resolver (4.6): hosts sintéticos por plataforma, sin tocar el disco ────────────────────────────────

interface FakeBinaries {
  files: Record<string, string>;
  calls: Array<{ command: string; args: string[] }>;
  notExecutable?: Set<string>;
  versionFails?: Set<string>;
}

function fakeHost(platform: NodeJS.Platform, env: Record<string, string>, home: string, binaries: FakeBinaries): ResolverHost {
  const exec: ProcessRunner = async (command, args) => {
    binaries.calls.push({ command, args });
    const target = /cmd\.exe$/i.test(command) ? args[3] : command;
    if (binaries.versionFails?.has(target)) {
      return { status: 1, stdout: '', stderr: 'version query failed' };
    }
    const version = binaries.files[target];
    return version ? { status: 0, stdout: `Hermes Agent v${version} (2026.9.24) · stable`, stderr: '' } : { status: null, stdout: '', stderr: '', error: 'ENOENT' };
  };
  return {
    platform,
    env,
    home,
    cwd: home,
    exec,
    exists: async (file) => file in binaries.files,
    ...(binaries.notExecutable ? { executable: async (file: string) => !binaries.notExecutable?.has(file) } : {}),
  } as ResolverHost;
}

describe('fase 4 — resolver de Hermes (4.6)', () => {
  it('an explicit path wins over the PATH and is exclusive', async () => {
    const bins: FakeBinaries = { files: { '/opt/hermes/bin/hermes': '0.23.0', '/usr/bin/hermes': '0.24.1' }, calls: [] };
    const host = fakeHost('linux', { PATH: '/usr/bin' }, '/home/u', bins);
    const cli = await resolveHermes(host, '/opt/hermes/bin/hermes');
    expect(cli).toMatchObject({ path: '/opt/hermes/bin/hermes', version: '0.23.0' });
    expect(hermesCandidates(host, '/opt/missing/hermes')).toEqual(['/opt/missing/hermes']);
    await expect(resolveHermes(host, '/opt/missing/hermes')).rejects.toBeInstanceOf(HermesNotFoundError);
  });

  it('HERMES_BIN goes before the PATH', async () => {
    const bins: FakeBinaries = { files: { '/srv/hermes': '0.23.0', '/usr/bin/hermes': '0.24.1' }, calls: [] };
    const cli = await resolveHermes(fakeHost('linux', { PATH: '/usr/bin', HERMES_BIN: '/srv/hermes' }, '/home/u', bins));
    expect(cli.path).toBe('/srv/hermes');
  });

  it('finds pipx installs outside the PATH on Linux and Windows', async () => {
    const linux = await resolveHermes(fakeHost('linux', { PATH: '/usr/bin' }, '/home/u', { files: { '/home/u/.local/bin/hermes': '0.23.0' }, calls: [] }));
    expect(linux.path).toBe('/home/u/.local/bin/hermes');
    const windows = await resolveHermes(
      fakeHost('win32', { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' }, 'C:\\Users\\u', { files: { 'C:\\Users\\u\\.local\\bin\\hermes.exe': '0.23.0' }, calls: [] }),
    );
    expect(windows.path).toBe('C:\\Users\\u\\.local\\bin\\hermes.exe');
  });

  it('finds the native installer under %LOCALAPPDATA%\\hermes\\bin on Windows', async () => {
    const env = { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const cli = await resolveHermes(fakeHost('win32', env, 'C:\\Users\\u', { files: { 'C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe': '0.23.0' }, calls: [] }));
    expect(cli.path).toBe('C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe');
  });

  it('finds the native installer agent directory on Windows', async () => {
    const env = { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const agent = 'C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\.hermes\\bin\\hermes.exe';
    const cli = await resolveHermes(fakeHost('win32', env, 'C:\\Users\\u', { files: { [agent]: '0.23.0' }, calls: [] }));
    expect(cli.path).toBe(agent);
  });

  it('never includes Windows locations on POSIX', () => {
    const host = fakeHost('linux', { PATH: '' }, '/home/u', { files: {}, calls: [] });
    const candidates = hermesCandidates(host);
    expect(candidates.some((item) => /[A-Za-z]:\\|\\\\/.test(item))).toBe(false);
  });

  it('reports a present candidate as not executable instead of missing', async () => {
    const bins: FakeBinaries = { files: { '/usr/bin/hermes': '0.23.0' }, calls: [], notExecutable: new Set(['/usr/bin/hermes']) };
    const error = (await resolveHermes(fakeHost('linux', { PATH: '/usr/bin' }, '/home/u', bins)).catch((caught: unknown) => caught)) as HermesNotFoundError;
    expect(error).toBeInstanceOf(HermesNotFoundError);
    expect(error.message).toContain('/usr/bin/hermes');
    expect(error.message).toContain('presente pero no ejecutable');
  });

  it('reports a failed version query with its exit code', async () => {
    const bins: FakeBinaries = { files: { '/usr/bin/hermes': '0.23.0' }, calls: [], versionFails: new Set(['/usr/bin/hermes']) };
    const error = (await resolveHermes(fakeHost('linux', { PATH: '/usr/bin' }, '/home/u', bins)).catch((caught: unknown) => caught)) as HermesNotFoundError;
    expect(error.message).toContain('/usr/bin/hermes');
    expect(error.message).toContain('--version falló (exit 1)');
  });

  it('accepts the npm shim hermes.cmd on Windows and runs it through cmd.exe', async () => {
    const bins: FakeBinaries = { files: { 'C:\\npm\\hermes.cmd': '0.23.0' }, calls: [] };
    const cli = await resolveHermes(fakeHost('win32', { PATH: 'C:\\npm', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'C:\\Users\\u', bins));
    expect(cli.path).toBe('C:\\npm\\hermes.cmd');
    expect(bins.calls[0]).toEqual({ command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'C:\\npm\\hermes.cmd', '--version'] });
  });

  it('refuses a version below the minimum naming both', async () => {
    const host = fakeHost('linux', { PATH: '/usr/bin' }, '/home/u', { files: { '/usr/bin/hermes': '0.22.9' }, calls: [] });
    const error = await resolveHermes(host).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesVersionError);
    expect((error as Error).message).toContain('0.22.9');
    expect((error as Error).message).toContain('0.23.0');
  });

  it('lists every candidate path tried when nothing resolves', async () => {
    const host = fakeHost('win32', { PATH: 'C:\\Windows;C:\\tools', LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R', USERPROFILE: 'C:\\U' }, 'C:\\U', { files: {}, calls: [] });
    const error = (await resolveHermes(host).catch((caught: unknown) => caught)) as HermesNotFoundError;
    expect(error).toBeInstanceOf(HermesNotFoundError);
    expect(error.tried).toEqual(hermesCandidates(host));
    for (const expected of ['C:\\Windows\\hermes.exe', 'C:\\tools\\hermes.cmd', 'C:\\tools\\hermes.bat', 'C:\\L\\hermes\\bin\\hermes.exe', 'C:\\L\\hermes\\hermes-agent\\.hermes\\bin\\hermes.exe', 'C:\\U\\.local\\bin\\hermes.exe', 'C:\\R\\Python\\Scripts\\hermes.exe', 'C:\\R\\npm\\hermes.cmd']) {
      expect(error.message).toContain(expected);
    }
  });
});

// ── Enroll (4.2, 4.3, 4.7, 4.8): disco real en un temporal, CLI de Hermes falso ────────────────────────

interface FakeHermesState {
  listening?: boolean;
  calls: string[][];
  routes: Set<string>;
  crons: Set<string>;
}

let h: Harness;
let hermesBin: string;
let host: ResolverHost;
let state: FakeHermesState;
let profileDir: string;

function fakeHermes(home: string): ProcessRunner {
  return async (_command, args): Promise<RunResult> => {
    state.calls.push(args);
    const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
    if (args[0] === '--version') {
      return ok('Hermes Agent v0.23.0 (2026.9.24) · stable');
    }
    if (args[0] === 'profile' && args[1] === 'create') {
      await fs.mkdir(path.join(home, 'profiles', args[2]), { recursive: true });
      return ok(`Profile ${args[2]} created`);
    }
    // webhook-operativo: gateway dedicado en marcha; el reinicio carga el bloque y el puerto pasa a escuchar.
    const rest = args[0] === '-p' ? args.slice(2) : args;
    if (rest[0] === 'gateway' && rest[1] === 'status') {
      return ok('running');
    }
    if (rest[0] === 'gateway' && rest[1] === 'restart') {
      state.listening = true;
      return ok();
    }
    const sub = args.slice(2);
    if (sub[0] === 'webhook' && sub[1] === 'list') {
      return ok([...state.routes].map((route) => `  ◆ ${route}\n    URL:     http://localhost:8644/webhooks/${route}`).join('\n'));
    }
    if (sub[0] === 'webhook' && sub[1] === 'subscribe') {
      state.routes.add(sub[2]);
      return ok(`  Created ${sub[2]}\n  Secret: ${WEBHOOK_SECRET_SENTINEL}\n`);
    }
    if (sub[0] === 'cron' && sub[1] === 'list') {
      return ok([...state.crons].map((name) => `  ${name}  every 15m  active`).join('\n'));
    }
    if (sub[0] === 'cron' && sub[1] === 'create') {
      state.crons.add(sub[sub.indexOf('--name') + 1]);
      return ok('Created job');
    }
    return { status: 2, stdout: '', stderr: 'unknown command' };
  };
}

beforeEach(async () => {
  h = await harness();
  await h.consumer();
  const sandbox = path.join(h.root, 'sandbox');
  const windows = process.platform === 'win32';
  const env = windows ? { PATH: '', LOCALAPPDATA: sandbox } : { PATH: '' };
  const home = windows ? path.join(sandbox, 'home') : sandbox;
  host = { platform: process.platform, env, home, cwd: h.root, exec: async () => ({ status: 0, stdout: '', stderr: '' }), exists: (file) => fs.access(file).then(() => true, () => false) };
  const hermesRoot = hermesHome(host);
  hermesBin = path.join(sandbox, 'bin', windows ? 'hermes.exe' : 'hermes');
  await fs.mkdir(path.dirname(hermesBin), { recursive: true });
  await fs.writeFile(hermesBin, 'fake');
  state = { calls: [], routes: new Set(), crons: new Set() };
  host = { ...host, exec: fakeHermes(hermesRoot), probeWebhook: async () => (state.listening ? 'listening' : 'refused'), webhookWaitMs: 0 };
  profileDir = path.join(hermesRoot, 'profiles', PROFILE);
});

afterEach(async () => {
  await h.dispose();
});

const creating = (calls: string[][]): string[][] =>
  calls.filter((args) => (args[0] === 'profile' && args[1] === 'create') || args.includes('subscribe') || (args.includes('cron') && args.includes('create')));

describe('fase 4 — control enroll (4.2, 4.3)', () => {
  it('--dry-run prints the plan, Discord as the only destination, and changes nothing', async () => {
    const outcome = await runEnroll(h.root, { mode: 'dry-run', hermes: hermesBin, host });
    expect(outcome.code).toBe(0);
    const text = outcome.lines.join('\n');
    for (const expected of [`Hermes 0.23.0 · ${hermesBin}`, `[crear]    perfil: hermes profile create ${PROFILE} --no-skills`, 'skill:', 'control-poll.sh', 'gitlab-route.sh', 'webhook: ai-hub-gitlab → discord', 'cron: ai-hub-control-poll', 'GitLab (Settings > Webhooks del proyecto):', path.join(profileDir, '.env')]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).not.toMatch(/telegram|slack|signal|whatsapp/i);
    expect(creating(state.calls)).toEqual([]);
    await expect(fs.access(profileDir)).rejects.toThrow();
  });

  it('--yes creates only what is missing, never passes --secret, and a second run creates nothing', async () => {
    const first = await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host });
    expect(first.code).toBe(0);
    expect(creating(state.calls).map((args) => args.slice(0, 5).join(' '))).toEqual([
      `profile create ${PROFILE} --no-skills`,
      `-p ${PROFILE} cron create every 15m`,
      `-p ${PROFILE} webhook subscribe ai-hub-gitlab`,
    ]);
    expect(state.calls.flat()).not.toContain('--secret');
    const subscribe = state.calls.find((args) => args.includes('subscribe')) ?? [];
    expect(subscribe).toEqual(expect.arrayContaining(['--events', 'Issue Hook,Merge Request Hook', '--deliver', 'discord', '--deliver-only', '--script', 'gitlab-route.sh']));
    const skill = await fs.readFile(path.join(profileDir, 'skills', 'ai-hub-control', 'SKILL.md'), 'utf8');
    expect(skill).toContain(`cd '${h.root.replace(/\\/g, '/')}'`);
    expect(await fs.readFile(path.join(profileDir, 'scripts', 'control-poll.sh'), 'utf8')).not.toContain('__AI_HUB_REPO__');
    expect(first.lines.join('\n')).not.toContain(WEBHOOK_SECRET_SENTINEL);
    state.calls = [];
    const second = await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host });
    expect(second.code).toBe(0);
    expect(creating(state.calls)).toEqual([]);
    // webhook-operativo: seis etapas, la plataforma, la ruta y la escucha verificada por GET /health.
    expect(second.lines.filter((line) => line.startsWith('[presente]'))).toHaveLength(9);
  });
});

describe('fase 4 — perfil y credenciales de Discord (4.7, 4.8)', () => {
  async function profileEnv(values: Record<string, string>, dir = profileDir): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.env'), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  }

  it('refuses a profile that shares its bot token with another profile, without printing it', async () => {
    await profileEnv({ DISCORD_BOT_TOKEN: BOT_TOKEN_SENTINEL });
    await profileEnv({ DISCORD_BOT_TOKEN: BOT_TOKEN_SENTINEL }, path.join(path.dirname(profileDir), 'personal'));
    const outcome = await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join('\n')).toContain('colisión de token de bot');
    expect(outcome.lines.join('\n')).toContain('"personal"');
    expect(outcome.lines.join('\n')).not.toContain(BOT_TOKEN_SENTINEL);
    expect(creating(state.calls)).toEqual([]);
  });

  it('--check reports the three keys by presence only', async () => {
    await profileEnv({ DISCORD_BOT_TOKEN: BOT_TOKEN_SENTINEL, DISCORD_ALLOWED_USERS: '123456789012345678', DISCORD_ALLOWED_CHANNELS: '987654321098765432' });
    const outcome = await runEnroll(h.root, { mode: 'check', hermes: hermesBin, host });
    // El perfil de este fixture solo tiene .env: el check completo lo declara incompleto, pero las claves se leen.
    expect(outcome.code).toBe(1);
    const text = outcome.lines.join('\n');
    for (const key of ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS']) {
      expect(text).toMatch(new RegExp(`\\[OK\\] +${key}: presente`));
    }
    // Los ids no son secretos y el check informa del canal; el token jamás se imprime.
    expect(text).not.toContain(BOT_TOKEN_SENTINEL);
    expect(creating(state.calls)).toEqual([]);
  });

  it('--check names a missing key with the README step that obtains it', async () => {
    await profileEnv({ DISCORD_BOT_TOKEN: BOT_TOKEN_SENTINEL, DISCORD_ALLOWED_USERS: '123456789012345678' });
    const outcome = await runEnroll(h.root, { mode: 'check', hermes: hermesBin, host });
    expect(outcome.code).toBe(1);
    const text = outcome.lines.join('\n');
    expect(text).toContain('[FAIL] DISCORD_ALLOWED_CHANNELS: falta en');
    expect(text).toContain('core/README.md › Provisión de Discord');
    expect(text).not.toContain(BOT_TOKEN_SENTINEL);
  });
});

describe('scripts gestionados y job configurado (4.25, 4.26, R-011, R-013)', () => {
  const pollFile = (): string => path.join(profileDir, 'scripts', 'control-poll.sh');

  it('un script gestionado antiguo: --check lo informa, --yes lo sustituye con copia y --check pasa después', async () => {
    expect((await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host })).code).toBe(0);
    const old = '#!/bin/sh\n# ai-hub-managed: control-poll.sh v=1\nnpx --no-install ai-hub control decide --online\n';
    await fs.writeFile(pollFile(), old);
    const before = await runEnroll(h.root, { mode: 'check', hermes: hermesBin, host });
    expect(before.lines.join('\n')).toContain('control-poll.sh desactualizado');
    const updated = await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host });
    expect(updated.lines.join('\n')).toContain('desactualizado: se sustituye con copia previa');
    expect(await fs.readFile(pollFile(), 'utf8')).toContain('exec npx --no-install ai-hub control poll');
    expect(await fs.readFile(`${pollFile()}.pre-ai-hub`, 'utf8')).toBe(old);
    const after = await runEnroll(h.root, { mode: 'check', hermes: hermesBin, host });
    expect(after.lines.join('\n')).not.toContain('desactualizado');
  });

  it('un script sin marca es de la persona: queda intacto y se informa como no gestionado', async () => {
    expect((await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host })).code).toBe(0);
    const mine = '#!/bin/sh\n# mi poll\nnpx --no-install ai-hub control poll --probe\n';
    await fs.writeFile(pollFile(), mine);
    const again = await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host });
    expect(again.lines.join('\n')).toContain('no gestionado: sin marca de AI-Hub; se deja intacto');
    expect(await fs.readFile(pollFile(), 'utf8')).toBe(mine);
    await expect(fs.access(`${pollFile()}.pre-ai-hub`)).rejects.toThrow();
    const check = await runEnroll(h.root, { mode: 'check', hermes: hermesBin, host });
    expect(check.lines.join('\n')).toContain('control-poll.sh no gestionado');
  });

  it('el job del poll toma su nombre de manifest.control.pollJob', async () => {
    const manifest = path.join(h.root, 'manifest.yaml');
    await fs.writeFile(manifest, (await fs.readFile(manifest, 'utf8')).replace(/^control:\n/m, 'control:\n  pollJob: mi-poll-de-control\n'));
    expect((await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host })).code).toBe(0);
    const create = state.calls.find((args) => args.includes('cron') && args.includes('create')) ?? [];
    expect(create[create.indexOf('--name') + 1]).toBe('mi-poll-de-control');
    expect([...state.crons]).toEqual(['mi-poll-de-control']);
  });
});

describe('skill gestionada (4.15, R-007)', () => {
  it('una instalación con la skill antigua recibe la que transporta las cuatro palabras, con copia previa', async () => {
    expect((await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host })).code).toBe(0);
    const skill = path.join(profileDir, 'skills', 'ai-hub-control', 'SKILL.md');
    const old = '---\nname: ai-hub-control\n---\n<!-- ai-hub-managed: SKILL.md v=1 -->\nKeep only the first three words for `aprobar`.\n';
    await fs.writeFile(skill, old);
    expect((await runEnroll(h.root, { mode: 'check', hermes: hermesBin, host })).lines.join('\n')).toContain('desactualizada');
    await runEnroll(h.root, { mode: 'yes', hermes: hermesBin, host });
    expect(await fs.readFile(skill, 'utf8')).toContain('must reach AI-Hub as four arguments');
    expect(await fs.readFile(`${skill}.pre-ai-hub`, 'utf8')).toBe(old);
  });
});

describe('versión mínima verificada de cron pause|resume (4.25, 2.5)', () => {
  it('desde 0.23.4 se usa; por debajo, no (el poll se queda en el aviso manual)', async () => {
    const { MIN_HERMES_CRON_PAUSE, supportsCronPause } = await import('../src/control/hermes.js');
    expect(MIN_HERMES_CRON_PAUSE).toBe('0.23.4');
    expect(supportsCronPause('0.23.4')).toBe(true);
    expect(supportsCronPause('0.24.0')).toBe(true);
    expect(supportsCronPause('0.23.3')).toBe(false);
    expect(supportsCronPause('0.23.0')).toBe(false);
  });
});
