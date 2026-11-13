import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runEnroll, PROFILE, type EnrollOptions } from '../src/control/enroll.js';
import { checkControlWebhook } from '../src/control/doctor.js';
import { DEFAULT_PROFILE_ENV, WEBHOOK_SECRET_SENTINEL, fakeHermes, treeHash, type FakeHermes } from './control-onboarding-fake.js';
import { harness, type Harness } from './control-harness.js';

/**
 * webhook-operativo: la plataforma se habilita en el `config.yaml` del dueño del listener (nunca en el `.env`), se
 * verifica por el puerto y, cuando el dueño es otro perfil, solo con un consentimiento que lo nombra.
 */

let h: Harness;
let hermes: FakeHermes;

beforeEach(async () => {
  h = await harness();
  await h.consumer();
  hermes = await fakeHermes(h.root);
});

afterEach(async () => {
  await h.dispose();
});

const OPERATOR_SECRET = 'AIHUB_OPERATOR_WEBHOOK_SECRET_SENTINEL';
const profileDir = () => path.join(hermes.home, 'profiles', PROFILE);
const envFile = () => path.join(profileDir(), '.env');
const profileConfig = () => path.join(profileDir(), 'config.yaml');
const ownerConfig = () => path.join(hermes.home, 'config.yaml');
const read = (file: string) => fs.readFile(file, 'utf8').catch(() => null);
const called = (key: string): string[][] => hermes.calls.filter((args) => args.join(' ').includes(key));
const enroll = (extra: Partial<EnrollOptions> = {}) => runEnroll(h.root, { mode: 'yes', host: hermes.host, ...extra });

async function seedProfile(env = DEFAULT_PROFILE_ENV): Promise<void> {
  await fs.mkdir(profileDir(), { recursive: true });
  await fs.writeFile(envFile(), env);
}

function block(text: string | null): Record<string, unknown> {
  const data = (parseYaml(text ?? '') ?? {}) as { platforms?: { webhook?: Record<string, unknown> } };
  return data.platforms?.webhook ?? {};
}

describe('webhook-operativo 1.4 — the block lives in config.yaml, never in .env', () => {
  it('platform disabled: writes the block, subscribes once, restarts once and leaves the port answering', async () => {
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(block(await read(profileConfig()))).toEqual({ enabled: true, extra: { port: 8644 } });
    const env = (await read(envFile())) ?? '';
    expect(env).not.toContain('WEBHOOK_ENABLED');
    expect(env).not.toContain('WEBHOOK_PORT');
    expect(env).toContain('# Hermes profile credentials');
    expect(called('webhook subscribe')).toHaveLength(1);
    expect(called('gateway restart')).toHaveLength(1);
    expect(await hermes.host.probeWebhook?.(8644)).toBe('listening');
  });

  it('keeps every other key and comment of an existing config.yaml', async () => {
    await seedProfile();
    const original = '# modelo del perfil\nmodel: provider/model\n_config_version: 3\nplatforms:\n  telegram:\n    enabled: false\n';
    await fs.writeFile(profileConfig(), original);
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    const text = (await read(profileConfig())) ?? '';
    expect(text).toContain('# modelo del perfil');
    expect(parseYaml(text)).toEqual({
      model: 'provider/model',
      _config_version: 3,
      platforms: { telegram: { enabled: false }, webhook: { enabled: true, extra: { port: 8644 } } },
    });
  });

  it('platform already enabled on port 9000 with a secret: config.yaml is byte-identical and the route is subscribed', async () => {
    await seedProfile();
    const original = `platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 9000\n      secret: ${OPERATOR_SECRET}\n`;
    await fs.writeFile(profileConfig(), original);
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(await read(profileConfig())).toBe(original);
    expect(called('webhook subscribe')).toHaveLength(1);
    expect(await hermes.host.probeWebhook?.(9000)).toBe('listening');
    expect(outcome.lines.join('\n')).not.toContain(OPERATOR_SECRET);
  });

  it('platforms.webhook.enabled=false is an opt-out: reported with the key, never changed, no subscription', async () => {
    await seedProfile();
    const original = 'platforms:\n  webhook:\n    enabled: false\n';
    await fs.writeFile(profileConfig(), original);
    const outcome = await enroll();
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    expect(outcome.lines.join('\n')).toContain('platforms.webhook.enabled');
    expect(await read(profileConfig())).toBe(original);
    expect(called('webhook subscribe')).toEqual([]);
  });

  it('--dry-run names the block and the port it would write and writes nothing', async () => {
    await seedProfile();
    const before = await treeHash(hermes.home);
    const outcome = await runEnroll(h.root, { mode: 'dry-run', host: hermes.host });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    const text = outcome.lines.join('\n');
    expect(text).toContain('platforms.webhook');
    expect(text).toContain('8644');
    expect(await treeHash(hermes.home)).toBe(before);
    expect([...called('subscribe'), ...called('cron create'), ...called('gateway restart')]).toEqual([]);
  });

  it('an existing route is not subscribed again', async () => {
    await seedProfile();
    hermes.routes.add('ai-hub-gitlab');
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(called('webhook subscribe')).toEqual([]);
  });

  it('a second run is byte-identical: no duplicate key, no subscription, no restart of a healthy gateway', async () => {
    expect((await enroll()).code).toBe(0);
    const config = await read(profileConfig());
    const before = await treeHash(hermes.home);
    hermes.calls.length = 0;
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(await read(profileConfig())).toBe(config);
    expect(await treeHash(hermes.home)).toBe(before);
    expect([...called('subscribe'), ...called('gateway restart')]).toEqual([]);
  });

  it('writes no secret, no INSECURE_NO_AUTH and no extra.host, and never shows the route secret', async () => {
    const outcome = await enroll();
    const text = (await read(profileConfig())) ?? '';
    expect(text).not.toMatch(/secret|INSECURE_NO_AUTH|host/i);
    expect(called('webhook subscribe')[0]).not.toContain('--secret');
    expect(outcome.lines.join('\n')).not.toContain(WEBHOOK_SECRET_SENTINEL);
  });
});

describe('webhook-operativo 1.5 — migration, port, gateway states and order', () => {
  it('migrates WEBHOOK_ENABLED and WEBHOOK_PORT out of .env after a backup, leaving every other line byte-identical', async () => {
    const original = '# Hermes profile credentials\nWEBHOOK_ENABLED=true\nWEBHOOK_PORT=9100\nOTHER_KEY=valor\n';
    await seedProfile(original);
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(block(await read(profileConfig()))).toEqual({ enabled: true, extra: { port: 9100 } });
    expect(await read(`${envFile()}.pre-ai-hub`)).toBe(original);
    expect(await read(envFile())).toBe('# Hermes profile credentials\nOTHER_KEY=valor\n');
    expect(await hermes.host.probeWebhook?.(9100)).toBe('listening');
  });

  it('an operator WEBHOOK_SECRET stays in .env, is reported by presence as the gateway override and is never copied or printed', async () => {
    const original = `# Hermes profile credentials\nWEBHOOK_SECRET=${OPERATOR_SECRET}\n`;
    await seedProfile(original);
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(await read(envFile())).toBe(original);
    expect(await read(profileConfig())).not.toContain(OPERATOR_SECRET);
    expect(block(await read(profileConfig()))).toEqual({ enabled: true, extra: { port: 8644 } });
    expect(hermes.listener.secretFromEnv).toBe(true);
    const text = outcome.lines.join('\n');
    expect(text).toContain('WEBHOOK_SECRET');
    expect(text).toContain('extra.secret');
    expect(text).not.toContain(OPERATOR_SECRET);
  });

  it('a port owned by another process fails before writing the block or the route', async () => {
    await seedProfile();
    hermes.portOccupied = true;
    const outcome = await enroll();
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    expect(outcome.lines.join('\n')).toMatch(/8644.*ocupado/);
    expect(await read(profileConfig())).toBeNull();
    expect(called('webhook subscribe')).toEqual([]);
  });

  // fabrica-verificable §D2: contrato nuevo. Antes, un puerto que no respondía tras el reinicio era `[FAIL]` con la
  // acción de reinicio; ahora, sin evidencia de fallo, el gateway «sigue arrancando» y la etapa queda pendiente.
  it('a listener that still refuses connections at the cap leaves the webhook stage pending, with no [FAIL] and the waiting check', async () => {
    hermes.host.probeWebhook = async () => 'refused';
    const outcome = await enroll();
    const text = outcome.lines.join('\n');
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    expect(outcome.pending).toBe(true);
    expect(outcome.action).toBe('ai-hub control enroll --check --wait');
    expect(text).toContain('[PENDIENTE] webhook: el gateway sigue arrancando');
    expect(text).not.toContain('[FAIL]');
    expect(outcome.unverified).toEqual(['webhook escuchando']);
    expect(outcome.missing).toEqual([]);
    expect(called('gateway restart')).toHaveLength(1);
  });

  it('a gateway that stops while starting fails at gateway with the restart and log action', async () => {
    hermes.host.probeWebhook = async () => 'refused';
    let statuses = 0;
    const exec = hermes.host.exec;
    hermes.host.exec = async (command, args, options) => {
      const rest = args[0] === '-p' ? args.slice(2) : args;
      if (rest[0] === 'gateway' && rest[1] === 'status') {
        statuses += 1;
        if (statuses > 1) {
          hermes.calls.push(args);
          return { status: 1, stdout: '', stderr: 'gateway is not running' };
        }
      }
      return exec(command, args, options);
    };
    const outcome = await enroll();
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('gateway');
    expect(outcome.lines.join('\n')).toContain('[FAIL] gateway: se detuvo mientras arrancaba');
    expect(outcome.action).toContain('gateway restart');
  });

  it.each([
    ['a scalar document', 'solo texto\n'],
    ['a sequence', '- a\n- b\n'],
    ['duplicate keys', 'model: a\nmodel: b\n'],
  ])('fails closed on %s in config.yaml: nothing written, stage named, no generic error', async (_label, original) => {
    await seedProfile();
    await fs.writeFile(profileConfig(), original);
    const outcome = await enroll();
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    expect(await read(profileConfig())).toBe(original);
    expect(called('webhook subscribe')).toEqual([]);
    expect(outcome.lines.join('\n')).not.toContain('Error inesperado');
    expect(outcome.lines.join('\n')).toContain('config.yaml');
  });

  it('without an installed gateway the webhook is not verifiable: exit 0, cron installed, no block and no route', async () => {
    hermes.gatewayInstalled = false;
    const outcome = await enroll();
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect([...hermes.crons]).toEqual(['ai-hub-control-poll']);
    expect(await read(profileConfig())).toBeNull();
    expect(called('webhook subscribe')).toEqual([]);
    const text = outcome.lines.join('\n');
    expect(text).toContain('[NO VERIFICABLE] webhook');
    expect(text).toContain('hermes gateway install');
  });

  it('a stopped gateway is restarted once after announcing it; if it does not come up, exit 1 at gateway with the restart action', async () => {
    hermes.gatewayRunning = false;
    hermes.failOn.set('gateway restart', { stderr: 'unit failed to start' });
    const failed = await enroll();
    expect(failed.code).toBe(1);
    expect(failed.stage).toBe('gateway');
    expect(failed.action).toBe('hermes gateway restart');
    expect(called('gateway restart')).toHaveLength(1);
    hermes.failOn.delete('gateway restart');
    hermes.calls.length = 0;
    const recovered = await enroll();
    expect(recovered.code, recovered.lines.join('\n')).toBe(0);
    expect(hermes.gatewayRunning).toBe(true);
  });

  it('the cron and control-poll.sh are installed before the platform and the route, so a route failure leaves the tick ready', async () => {
    hermes.failOn.set('webhook subscribe', { stderr: 'Error: route refused' });
    const outcome = await enroll();
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-route');
    expect([...hermes.crons]).toEqual(['ai-hub-control-poll']);
    expect(await read(path.join(profileDir(), 'scripts', 'control-poll.sh'))).not.toBeNull();
    expect(outcome.ready).toContain('cron');
    expect(outcome.missing).not.toContain('cron');
  });
});

describe('webhook-operativo 1.5/1.6 — shared listener owner under the default-profile multiplexer', () => {
  const LEGACY_ENV = '# Hermes profile credentials\nWEBHOOK_ENABLED=true\nWEBHOOK_PORT=8644\n';
  const OWNER_CONFIG = '# perfil por defecto\nmodel: provider/model\n';

  beforeEach(async () => {
    hermes.topology = 'multiplex';
    await seedProfile(LEGACY_ENV);
    await fs.writeFile(ownerConfig(), OWNER_CONFIG);
  });

  it('--yes alone leaves the owner config and the profile .env byte-identical, subscribes nothing and reports pendiente with the action', async () => {
    const outcome = await enroll();
    expect(outcome.code).toBe(1);
    expect(outcome.pending).toBe(true);
    expect(outcome.stage).toBe('webhook-platform');
    expect(outcome.action).toBe('ai-hub control enroll --yes --webhook-owner default');
    expect(await read(ownerConfig())).toBe(OWNER_CONFIG);
    expect(await read(envFile())).toBe(LEGACY_ENV);
    expect(await read(profileConfig())).toBeNull();
    expect(called('webhook subscribe')).toEqual([]);
    expect([...hermes.crons]).toEqual(['ai-hub-control-poll']);
  });

  it('--webhook-owner default backs up the owner config, writes the block there, binds the route to the profile and warns before the single restart', async () => {
    const warnings: Array<{ line: string; callsBefore: number }> = [];
    const outcome = await enroll({ webhookOwner: 'default', notify: (line) => warnings.push({ line, callsBefore: hermes.calls.length }) });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(await read(`${ownerConfig()}.pre-ai-hub`)).toBe(OWNER_CONFIG);
    const text = (await read(ownerConfig())) ?? '';
    expect(text).toContain('# perfil por defecto');
    expect(block(text)).toEqual({ enabled: true, extra: { port: 8644 } });
    expect(await read(profileConfig())).toBeNull();
    expect(await read(envFile())).toBe('# Hermes profile credentials\n');
    const subscribe = called('webhook subscribe');
    expect(subscribe).toHaveLength(1);
    expect(subscribe[0][0]).toBe('webhook');
    expect(subscribe[0].slice(subscribe[0].indexOf('--route-profile'), subscribe[0].indexOf('--route-profile') + 2)).toEqual(['--route-profile', PROFILE]);
    expect(hermes.routeBinding.get('ai-hub-gitlab')).toEqual({ store: 'default', profile: PROFILE });
    expect(outcome.lines.join('\n')).toContain(`/p/${PROFILE}/webhooks/ai-hub-gitlab`);
    const restarts = hermes.calls.map((args, index) => ({ args, index })).filter((item) => item.args.join(' ') === 'gateway restart');
    expect(restarts).toHaveLength(1);
    const warning = warnings.find((item) => item.line.includes('default') && item.line.includes('sesiones'));
    expect(warning, JSON.stringify(warnings)).toBeDefined();
    expect(warning!.callsBefore).toBeLessThanOrEqual(restarts[0].index);
    expect(hermes.deliver('ai-hub-gitlab')).toBe(200);
  });

  it('a --webhook-owner that is not the detected owner writes nothing and names both profiles', async () => {
    const before = await treeHash(hermes.home);
    const outcome = await enroll({ webhookOwner: 'otro-perfil' });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    const text = outcome.lines.join('\n');
    expect(text).toContain('otro-perfil');
    expect(text).toContain('default');
    expect(await read(ownerConfig())).toBe(OWNER_CONFIG);
    expect(await read(envFile())).toBe(LEGACY_ENV);
    expect(called('webhook subscribe')).toEqual([]);
    expect(await read(`${ownerConfig()}.pre-ai-hub`)).toBeNull();
    expect(before).not.toBe('');
  });

  it('an unreadable owner config fails closed: no configuration written in either profile, cron kept', async () => {
    const broken = '- esto\n- no es un mapping\n';
    await fs.writeFile(ownerConfig(), broken);
    const outcome = await enroll({ webhookOwner: 'default' });
    expect(outcome.code).toBe(1);
    expect(outcome.stage).toBe('webhook-platform');
    expect(await read(ownerConfig())).toBe(broken);
    expect(await read(envFile())).toBe(LEGACY_ENV);
    expect(await read(profileConfig())).toBeNull();
    expect(outcome.lines.join('\n')).not.toContain('esto');
    expect([...hermes.crons]).toEqual(['ai-hub-control-poll']);
  });

  it('--dry-run and --check describe the shared restart with its warning and exact command, and never restart', async () => {
    const dry = await runEnroll(h.root, { mode: 'dry-run', host: hermes.host, webhookOwner: 'default' });
    const dryText = dry.lines.join('\n');
    expect(dryText).toMatch(/default.*sesiones/);
    expect(dryText).toContain('hermes gateway restart');
    expect(called('gateway restart')).toEqual([]);
    expect((await enroll({ webhookOwner: 'default' })).code).toBe(0);
    hermes.listener = { loaded: false, port: null, secretFromEnv: false };
    hermes.calls.length = 0;
    const check = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    const checkText = check.lines.join('\n');
    expect(check.code).toBe(1);
    expect(checkText).toContain('declarado pero no escucha');
    expect(checkText).toMatch(/default.*sesiones/);
    expect(checkText).toContain('hermes gateway restart');
    expect(called('gateway restart')).toEqual([]);
  });

  it('a rerun with nothing to reload neither restarts nor warns', async () => {
    expect((await enroll({ webhookOwner: 'default' })).code).toBe(0);
    hermes.calls.length = 0;
    const warnings: string[] = [];
    const outcome = await enroll({ notify: (line) => warnings.push(line) });
    expect(outcome.code, outcome.lines.join('\n')).toBe(0);
    expect(called('gateway restart')).toEqual([]);
    expect(warnings).toEqual([]);
    expect(outcome.lines.join('\n')).not.toMatch(/sesiones/);
  });
});

describe('webhook-operativo 1.5 — doctor distinguishes declared from listening', () => {
  const enabled = 'platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 8700\n';

  it('no block anywhere: optional and not configured, without failing', async () => {
    const check = await checkControlWebhook({ home: hermes.home, probe: async () => 'refused' });
    expect(check).toMatchObject({ id: 'control:webhook', ok: true });
    expect(check.detail).toContain('no configurado');
  });

  it('declared but not listening fails, naming the port and the restart', async () => {
    await seedProfile();
    await fs.writeFile(profileConfig(), enabled);
    const check = await checkControlWebhook({ home: hermes.home, probe: async () => 'refused' });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('8700');
    expect(check.detail).toContain('gateway restart');
  });

  it('listening reports the port', async () => {
    await fs.mkdir(hermes.home, { recursive: true });
    await fs.writeFile(ownerConfig(), enabled);
    const check = await checkControlWebhook({ home: hermes.home, probe: async (port) => (port === 8700 ? 'listening' : 'refused') });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('escuchando');
    expect(check.detail).toContain('8700');
  });

  it('a port answered by another process fails as occupied', async () => {
    await fs.mkdir(hermes.home, { recursive: true });
    await fs.writeFile(ownerConfig(), enabled);
    const check = await checkControlWebhook({ home: hermes.home, probe: async () => 'foreign' });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('ocupado');
  });
});

describe('fabrica-verificable 1.7 — doctor y el check nombran el mismo dueño', () => {
  it('a stale enabled block in the control profile does not win: doctor and --check name the default owner and its port', async () => {
    hermes.topology = 'multiplex';
    expect((await enroll({ webhookOwner: 'default' })).code).toBe(0);
    await fs.writeFile(profileConfig(), 'platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 9999\n');
    const withCli = await checkControlWebhook({ home: hermes.home, probe: hermes.host.probeWebhook, cli: { path: 'hermes', version: '0.23.0', run: (args) => hermes.host.exec('hermes', args, { cwd: h.root }) } });
    const withoutCli = await checkControlWebhook({ home: hermes.home, probe: hermes.host.probeWebhook });
    for (const result of [withCli, withoutCli]) {
      expect(result.ok, result.detail).toBe(true);
      expect(result.detail).toContain('127.0.0.1:8644');
      expect(result.detail).toContain('perfil default');
    }
    const check = await runEnroll(h.root, { mode: 'check', host: hermes.host });
    expect(check.lines.join('\n')).toContain('escuchando en 127.0.0.1:8644');
    expect(check.lines.join('\n')).toContain('listener: dueño "default"');
  });
});
