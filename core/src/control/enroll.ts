import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseDotenv } from '../env/dotenv.js';
import { readTemplate } from '../harness/local.js';
import { loadManifestContext } from '../manifest/manifest.js';
import { ControlConfigError, requireSettings } from './decide.js';
import { HermesNotFoundError, HermesVersionError, hermesHome, resolveHermes, type HermesCli, type ResolverHost } from './hermes.js';
import {
  GATEWAY_INSTALL_ACTION,
  GATEWAY_RESTART_ACTION,
  SECRET_OVERRIDE_NOTICE,
  WEBHOOK_PIECES,
  gatewayTopology,
  ownerOf,
  sharedRestartWarning,
  webhookPhase,
  type Topology,
} from './enroll-webhook.js';
import { DEFAULT_WEBHOOK_PORT, probeWebhook, readWebhookBlock } from './webhook-config.js';
import { ensureSoulIdentity, inspectSoulIdentity, setAsideSoulAction, soulNeedsSetAside } from './identity.js';
import { redactedCause } from './redact.js';
import { ENROLL_ACTION, RETAKE_ACTION, RETAKE_PROVIDE } from '../cli/integrations.js';
import type { RunResult } from '../speckit/runner.js';

/**
 * `ai-hub control enroll`: instala en Hermes el lado operativo del plano de control (perfil, skill, scripts,
 * ruta del webhook y cron), siempre opt-in. `--dry-run` imprime el plan sin cambiar nada; `--yes` crea solo
 * lo que falta; `--check` comprueba las credenciales de Discord del perfil por presencia. Nunca imprime ni
 * escribe secretos: ni el token del bot, ni el secreto del webhook (Hermes lo genera y lo guarda él).
 */
export const PROFILE = 'hermes-control';
export const ROUTE = 'ai-hub-gitlab';
export const CRON_NAME = 'ai-hub-control-poll';
export const SKILL_NAME = 'ai-hub-control';
export const DISCORD_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS'] as const;

/** Paso de `core/README.md` › "Provisión de Discord" que obtiene cada clave. */
export const DISCORD_STEPS: Record<(typeof DISCORD_KEYS)[number], string> = {
  DISCORD_BOT_TOKEN: 'core/README.md › Provisión de Discord › pasos 1–3 (app, bot y token)',
  DISCORD_ALLOWED_USERS: 'core/README.md › Provisión de Discord › paso 5 (ids de los aprobadores)',
  DISCORD_ALLOWED_CHANNELS: 'core/README.md › Provisión de Discord › pasos 4 y 5 (invitar el bot e id del canal)',
};

export type EnrollMode = 'dry-run' | 'yes' | 'check';

export interface EnrollOptions {
  mode: EnrollMode;
  hermes?: string;
  host: ResolverHost;
  /** Valores en memoria que tampoco deben salir en una causa (p. ej. el token recién tecleado). */
  secrets?: readonly string[];
  /** `--webhook-owner <perfil>`: consentimiento que nombra al dueño del listener cuando es otro perfil (design §D9). */
  webhookOwner?: string;
  /** Consentimiento interactivo equivalente: la pregunta que nombra al dueño del listener. */
  confirmOwner?: (owner: string) => Promise<boolean>;
  /** Avisos que deben verse antes de la acción que anuncian (el reinicio de un gateway compartido). */
  notify?: (line: string) => void;
}

export interface EnrollOutcome {
  code: number;
  lines: string[];
  /** init-fiabilidad: etapa que falló (ids de design.md §8), lo listo, lo que falta y la causa redactada. */
  stage?: string;
  ready?: string[];
  missing?: string[];
  cause?: string[];
  /** La conexión está guardada (token del perfil + `manifest.control`): decide la acción (HC-12). */
  saved?: boolean;
  action?: string;
  /** Identidad sin adoptar, dueño del listener sin consentir o gateway parado: `pendiente`, no fallo inesperado. */
  pending?: boolean;
  /** El enrolamiento ya reinició el gateway en esta ejecución (no se reinicia otra vez). */
  restarted?: boolean;
  /** Estado final del webhook: escuchando, o no verificable por no haber gateway instalado. */
  webhook?: 'listening' | 'no-verificable';
}

interface Step {
  /** Id de etapa (design.md §8) y nombre corto para «listo/falta». */
  stage: string;
  piece: string;
  label: string;
  present: boolean;
  /** Devuelve el resultado del comando de Hermes que falló, o nada si creó la pieza. */
  create?: () => Promise<RunResult | void>;
}

/** HC-13: sin `manifest.control` la conexión no está guardada; `enroll` no puede retomarla (no escribe tokens). */
export function notSavedLines(root: string): string[] {
  return [
    `[FAIL] la conexión del plano de control no está guardada: falta manifest.control en ${root}; enroll no escribe tokens ni puede retomarla`,
    `Siguiente: ${RETAKE_ACTION} (o ai-hub init en una terminal) · aporta de nuevo: ${RETAKE_PROVIDE.join(', ')}`,
  ];
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function scriptsDir(profileDir: string): string {
  return path.join(profileDir, 'scripts');
}

async function readEnv(file: string): Promise<Record<string, string>> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  return text === null ? {} : parseDotenv(text);
}

/**
 * ¿Otro perfil (o el perfil por defecto) usa el mismo token de bot? Se compara en memoria; ningún valor sale
 * de esta función, solo el nombre del perfil que colisiona.
 */
async function tokenCollision(home: string, profileDir: string): Promise<string | null> {
  const own = (await readEnv(path.join(profileDir, '.env'))).DISCORD_BOT_TOKEN;
  if (!own) {
    return null;
  }
  const others: Array<[string, string]> = [['default', path.join(home, '.env')]];
  const profiles = await fs.readdir(path.join(home, 'profiles'), { withFileTypes: true }).catch(() => []);
  for (const entry of profiles) {
    if (entry.isDirectory() && entry.name !== PROFILE) {
      others.push([entry.name, path.join(home, 'profiles', entry.name, '.env')]);
    }
  }
  for (const [name, file] of others) {
    if ((await readEnv(file)).DISCORD_BOT_TOKEN === own) {
      return name;
    }
  }
  return null;
}

async function render(template: string, repo: string): Promise<string> {
  return (await readTemplate(template)).split('__AI_HUB_REPO__').join(repo.replace(/\\/g, '/'));
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  });
}

/** Valores que nunca deben salir en una causa: los de los `.env` de Hermes (perfil y por defecto). */
async function knownSecrets(home: string, envFile: string, extra: readonly string[] = []): Promise<string[]> {
  const values = [...Object.values(await readEnv(envFile)), ...Object.values(await readEnv(path.join(home, '.env')))];
  return [...values, ...extra].filter((value) => value.trim() !== '');
}

function listed(output: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, 'm').test(output);
}

async function profileCommand(cli: HermesCli, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await cli.run(['-p', PROFILE, ...args]);
  return { ok: result.status === 0, stdout: result.stdout };
}

export async function runEnroll(root: string, options: EnrollOptions): Promise<EnrollOutcome> {
  const manifest = (await loadManifestContext(root)).manifest;
  let settings: Awaited<ReturnType<typeof requireSettings>>;
  try {
    settings = await requireSettings(manifest);
  } catch (error) {
    if (error instanceof ControlConfigError && options.mode !== 'dry-run') {
      return { code: 1, lines: notSavedLines(root), stage: 'manifest', saved: false, action: RETAKE_ACTION };
    }
    throw error;
  }
  // webhook-operativo 4.1: Hermes ausente o viejo es una etapa con su código, no una excepción.
  let cli: HermesCli;
  try {
    cli = await resolveHermes(options.host, options.hermes);
  } catch (error) {
    if (error instanceof HermesNotFoundError || error instanceof HermesVersionError) {
      const notFound = error instanceof HermesNotFoundError;
      const cause = [notFound ? `exit 2 · ${error.message.split('\n')[0]}` : `exit 1 · ${error.message}`];
      return {
        code: notFound ? 2 : 1,
        lines: [`[FAIL] Hermes: ${error.message}`, `Siguiente: ${notFound ? 'instala Hermes (o indica --hermes <ruta>) y repite' : 'hermes update'}`],
        stage: 'resolver',
        cause,
        action: notFound ? 'instala Hermes o indica --hermes <ruta>' : 'hermes update',
      };
    }
    throw error;
  }
  const home = hermesHome(options.host);
  const profileDir = path.join(home, 'profiles', PROFILE);
  const envFile = path.join(profileDir, '.env');
  const lines = [`Hermes ${cli.version} · ${cli.path}`, `Perfil ${PROFILE} · ${profileDir}`, `  .env del perfil: ${envFile} (lo rellena la persona; ai-hub no lo lee ni lo escribe salvo para comprobar claves)`];

  if (options.mode === 'check') {
    type CheckState = 'ok' | 'fail' | 'nv';
    interface CheckRow {
      component: string;
      state: CheckState;
      line: string;
      stage: string;
      action?: string;
    }
    const rows: CheckRow[] = [];
    const add = (component: string, state: CheckState, line: string, stage: string, action?: string): void => {
      rows.push({ component, state, line, stage, ...(action ? { action } : {}) });
    };
    const profilePresent = await exists(profileDir);
    add('perfil', profilePresent ? 'ok' : 'fail', profilePresent ? 'perfil: presente' : 'perfil: no existe', 'profile', ENROLL_ACTION);

    const envText = await fs.readFile(envFile, 'utf8').catch(() => null);
    const env = envText === null ? {} : parseDotenv(envText);
    add(
      'configuración',
      envText === null ? 'fail' : 'ok',
      envText === null ? 'configuración: .env del perfil ausente o ilegible' : 'configuración: .env del perfil legible',
      'env',
      ENROLL_ACTION,
    );
    for (const key of DISCORD_KEYS) {
      add(
        key,
        env[key] ? 'ok' : 'fail',
        env[key] ? `${key}: presente` : `${key}: falta en ${envFile} · obténla en ${DISCORD_STEPS[key]}`,
        'env',
        ENROLL_ACTION,
      );
    }
    const collision = profilePresent ? await tokenCollision(home, profileDir) : null;
    if (collision !== null) {
      add('DISCORD_BOT_TOKEN', 'fail', `DISCORD_BOT_TOKEN: es el mismo bot que el perfil "${collision}"; crea un bot propio para ${PROFILE}`, 'env', ENROLL_ACTION);
    }

    const channelId = settings.channelId;
    const homeChannel = env.DISCORD_HOME_CHANNEL?.trim();
    const allowedChannels = (env.DISCORD_ALLOWED_CHANNELS ?? '').split(/[\s,;]+/).filter(Boolean);
    const channelOk = channelId !== undefined && homeChannel === channelId && allowedChannels.includes(channelId);
    add(
      'canal',
      channelOk ? 'ok' : 'fail',
      channelOk
        ? `canal: ${channelId} coincide con manifest.control`
        : channelId === undefined
          ? 'canal: falta manifest.control.channelId'
          : `canal: ${homeChannel ?? 'ausente'} no coincide con manifest.control.channelId=${channelId} o no está en DISCORD_ALLOWED_CHANNELS`,
      'env',
      ENROLL_ACTION,
    );
    const allowedUsers = (env.DISCORD_ALLOWED_USERS ?? '').split(/[\s,;]+/).filter(Boolean).sort();
    const expectedUsers = [...settings.approvers].sort();
    const approversOk = expectedUsers.length > 0 && allowedUsers.join(',') === expectedUsers.join(',');
    add(
      'aprobadores',
      approversOk ? 'ok' : 'fail',
      approversOk
        ? `aprobadores: coinciden con manifest.control (${expectedUsers.length})`
        : 'aprobadores: DISCORD_ALLOWED_USERS no coincide con manifest.control.approvers',
      'env',
      ENROLL_ACTION,
    );

    const skillFile = path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md');
    const skillPresent = await exists(skillFile);
    add('skill', skillPresent ? 'ok' : 'fail', skillPresent ? `skill: ${skillFile}` : `skill: falta ${skillFile}`, 'skill', ENROLL_ACTION);
    const scriptFiles = [path.join(scriptsDir(profileDir), 'control-poll.sh'), path.join(scriptsDir(profileDir), 'gitlab-route.sh')];
    const scriptsPresent = (await Promise.all(scriptFiles.map((file) => exists(file)))).every(Boolean);
    add('scripts', scriptsPresent ? 'ok' : 'fail', scriptsPresent ? 'scripts: control-poll.sh y gitlab-route.sh' : 'scripts: falta control-poll.sh o gitlab-route.sh', 'scripts', ENROLL_ACTION);
    const identity = await inspectSoulIdentity(profileDir);
    const identityFile = path.join(profileDir, 'SOUL.md');
    const identitySaved = Boolean(env.DISCORD_BOT_TOKEN);
    const identityAction = (await soulNeedsSetAside(profileDir))
      ? setAsideSoulAction(identityFile, identitySaved, RETAKE_ACTION)
      : identitySaved
        ? ENROLL_ACTION
        : RETAKE_ACTION;
    add(
      'identidad',
      identity === 'present' ? 'ok' : 'fail',
      identity === 'present' ? 'identidad: SOUL.md con el bloque actual' : 'identidad: SOUL.md ausente, editado o sin adoptar',
      'identity',
      identityAction,
    );

    // webhook-operativo: el webhook cuenta como presente solo si el config.yaml del dueño del listener lo habilita y
    // el puerto responde; sin gateway instalado (o con él parado) no es verificable. Nada de esto escribe ni reinicia.
    const topology: Topology = profilePresent
      ? await gatewayTopology(cli, PROFILE)
      : { state: 'not-installed', owner: PROFILE, shared: false };
    const owner = ownerOf(topology, home, PROFILE);
    const notices: string[] = [];
    let listing = { ok: false, stdout: '' };
    if (topology.state !== 'running') {
      add(
        'webhook',
        'nv',
        topology.state === 'not-installed'
          ? `webhook: no verificable sin gateway instalado (${GATEWAY_INSTALL_ACTION})`
          : 'webhook: no verificable con el gateway parado',
        'webhook-platform',
      );
      if (profilePresent) {
        listing = await profileCommand(cli, ['webhook', 'list']);
      }
    } else {
      const block = await readWebhookBlock(owner.config);
      const enableAction = topology.shared ? `${ENROLL_ACTION} --webhook-owner ${topology.owner}` : ENROLL_ACTION;
      if (block.kind === 'malformed') {
        add('webhook', 'fail', `webhook: ${owner.config} ${block.problem}`, 'webhook-platform', `corrige ${owner.config} y repite ${ENROLL_ACTION}`);
      } else if (block.kind !== 'enabled') {
        add('webhook', 'fail', `webhook: plataforma deshabilitada (falta platforms.webhook.enabled en ${owner.config})`, 'webhook-platform', enableAction);
      } else {
        const result = await cli.run(owner.command(['webhook', 'list']));
        listing = { ok: result.status === 0, stdout: result.stdout };
        const probed = await (options.host.probeWebhook ?? ((port: number) => probeWebhook(port)))(block.port);
        if (!listing.ok) {
          add('webhook', 'fail', 'webhook: plataforma deshabilitada o lista ilegible', 'webhook-platform', enableAction);
        } else if (probed === 'listening') {
          add('webhook', 'ok', `webhook: plataforma habilitada y escuchando en 127.0.0.1:${block.port}`, 'webhook-platform');
        } else if (probed === 'foreign') {
          add('webhook', 'fail', `webhook: el puerto ${block.port} está ocupado por otro proceso`, 'webhook-platform', `libera el puerto ${block.port} o elige otro en platforms.webhook.extra.port de ${owner.config}`);
        } else {
          add('webhook', 'fail', `webhook: declarado pero no escucha en 127.0.0.1:${block.port} · reinicia con ${owner.restartText}`, 'webhook-platform', owner.restartText);
          if (topology.shared) {
            notices.push(sharedRestartWarning(topology.owner));
          }
        }
      }
      if ((await readEnv(owner.env)).WEBHOOK_SECRET) {
        notices.push(SECRET_OVERRIDE_NOTICE);
      }
    }
    const routeOk = listing.ok && listed(listing.stdout, ROUTE);
    if (routeOk) {
      add('ruta', 'ok', `ruta: ${ROUTE}`, 'webhook-route');
    } else if (topology.state === 'not-installed') {
      add('ruta', 'nv', `ruta: ${ROUTE} no verificable sin gateway instalado`, 'webhook-route');
    } else {
      add('ruta', 'fail', `ruta: ${ROUTE} no listada`, 'webhook-route', ENROLL_ACTION);
    }
    const crons = profilePresent ? await profileCommand(cli, ['cron', 'list']) : { ok: false, stdout: '' };
    const cronOk = crons.ok && listed(crons.stdout, CRON_NAME);
    add('cron', cronOk ? 'ok' : 'fail', cronOk ? `cron: ${CRON_NAME}` : `cron: ${CRON_NAME} no listado`, 'cron', ENROLL_ACTION);

    let modelState: CheckState = 'nv';
    let modelLine = 'modelo: config.yaml ausente, ilegible o model vacío';
    const configText = await fs.readFile(path.join(profileDir, 'config.yaml'), 'utf8').catch(() => null);
    if (configText !== null) {
      try {
        const data = record(parseYaml(configText));
        const model = data.model;
        const value = typeof model === 'string'
          ? model.trim()
          : typeof model === 'object' && model !== null
            ? String((model as Record<string, unknown>).default ?? (model as Record<string, unknown>).model ?? '').trim()
            : '';
        if (value !== '') {
          modelState = 'ok';
          modelLine = 'modelo: configurado en el perfil';
        }
      } catch {
        // Un config.yaml ilegible no prueba un fallo: Hermes puede resolver el modelo por otras vías.
      }
    }
    add('modelo', modelState, modelLine, 'check');

    if (topology.state === 'running') {
      add('gateway', 'ok', topology.shared ? `gateway: en ejecución (multiplexor del perfil "${topology.owner}")` : 'gateway: en ejecución', 'gateway');
    } else if (topology.state === 'not-installed') {
      add('gateway', 'nv', 'gateway: no instalado (no verificable)', 'gateway');
    } else {
      add('gateway', 'fail', 'gateway: instalado pero no en ejecución', 'gateway', GATEWAY_RESTART_ACTION);
    }

    for (const row of rows) {
      const tag = row.state === 'ok' ? '[OK]' : row.state === 'nv' ? '[NO VERIFICABLE]' : '[FAIL]';
      lines.push(`${tag} ${row.line}`);
    }
    lines.push(...notices);
    const failed = rows.find((row) => row.state === 'fail');
    if (failed === undefined) {
      return {
        code: 0,
        lines,
        ready: rows.filter((row) => row.state === 'ok').map((row) => row.component),
        missing: [],
      };
    }
    return {
      code: 1,
      lines,
      stage: failed.stage,
      ready: rows.filter((row) => row.state === 'ok').map((row) => row.component),
      missing: rows.filter((row) => row.state === 'fail').map((row) => row.component),
      action: failed.action ?? ENROLL_ACTION,
    };
  }

  const profileExists = await exists(profileDir);
  let createdThisRun = false;
  let identityPending: string | null = null;
  if (profileExists) {
    const collision = await tokenCollision(home, profileDir);
    if (collision !== null) {
      return { code: 1, lines: [...lines, `[FAIL] colisión de token de bot: ${PROFILE} comparte DISCORD_BOT_TOKEN con el perfil "${collision}"; no se escribe nada`] };
    }
  }
  const crons = profileExists ? await profileCommand(cli, ['cron', 'list']) : { ok: false, stdout: '' };
  const scripts = scriptsDir(profileDir);
  const run = async (args: string[]): Promise<RunResult | void> => {
    const result = await cli.run(args);
    return result.status === 0 ? undefined : result;
  };
  const routeLabel = `webhook: ${ROUTE} → discord (deliver-only, script gitlab-route.sh)`;
  // webhook-operativo (design §D5): el cron y control-poll.sh van antes del webhook; si este falla, queda el tick.
  const steps: Step[] = [
    {
      stage: 'profile',
      piece: 'perfil',
      label: `perfil: hermes profile create ${PROFILE} --no-skills`,
      present: profileExists,
      create: async () => {
        const failed = await run(['profile', 'create', PROFILE, '--no-skills']);
        if (!failed) {
          createdThisRun = true;
        }
        return failed;
      },
    },
    {
      stage: 'identity',
      piece: 'identidad',
      label: `identidad: ${path.join(profileDir, 'SOUL.md')} (bloque gestionado)`,
      present: (await inspectSoulIdentity(profileDir)) === 'present',
      create: async () => {
        const env = await readEnv(envFile);
        const soul = await ensureSoulIdentity(profileDir, {
          createdThisRun,
          saved: Boolean(env.DISCORD_BOT_TOKEN),
        });
        if (soul.state === 'pending') {
          identityPending = soul.action;
          return { status: 1, stdout: '', stderr: soul.action ?? 'identidad pendiente' };
        }
        return undefined;
      },
    },
    {
      stage: 'skill',
      piece: 'skill',
      label: `skill: ${path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md')}`,
      present: await exists(path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md')),
      create: async () => writeIfMissing(path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md'), await render('hermes/SKILL.md', root)),
    },
    {
      stage: 'scripts',
      piece: 'scripts',
      label: `script: ${path.join(scripts, 'control-poll.sh')}`,
      present: await exists(path.join(scripts, 'control-poll.sh')),
      create: async () => writeIfMissing(path.join(scripts, 'control-poll.sh'), await render('hermes/control-poll.sh', root)),
    },
    {
      stage: 'scripts',
      piece: 'scripts',
      label: `script: ${path.join(scripts, 'gitlab-route.sh')}`,
      present: await exists(path.join(scripts, 'gitlab-route.sh')),
      create: async () => writeIfMissing(path.join(scripts, 'gitlab-route.sh'), await render('hermes/gitlab-route.sh', root)),
    },
    {
      stage: 'cron',
      piece: 'cron',
      label: `cron: ${CRON_NAME} cada ${settings.pollMinutes} min → discord (sin agente, script control-poll.sh)`,
      present: crons.ok && listed(crons.stdout, CRON_NAME),
      create: () =>
        run([
          '-p', PROFILE, 'cron', 'create', `every ${settings.pollMinutes}m`,
          '--name', CRON_NAME, '--no-agent', '--script', 'control-poll.sh', '--deliver', 'discord',
        ]),
    },
  ];
  const ready: string[] = [];
  /** Fallo con su etapa, lo listo, lo que falta, la causa redactada y la acción (CO-M1, HC-03); nunca se lanza. */
  const failure = async (
    stage: string,
    headline: string,
    cause: string[],
    missing: string[],
    action?: string,
    pending = false,
  ): Promise<EnrollOutcome> => {
    const saved = Boolean((await readEnv(envFile)).DISCORD_BOT_TOKEN);
    const listo = [...new Set(ready.filter((piece) => !missing.includes(piece)))];
    if (saved) {
      listo.splice(listo.indexOf('perfil') + 1, 0, '.env');
    }
    const next = action ?? (saved ? ENROLL_ACTION : RETAKE_ACTION);
    lines.push(`[FAIL] ${headline}`, ...cause.slice(1).map((line) => `  ${line}`), `Siguiente: ${next}`);
    return { code: 1, lines, stage, ready: listo, missing, cause, saved, action: next, ...(pending ? { pending: true } : {}) };
  };
  for (const [index, step] of steps.entries()) {
    lines.push(`${step.present ? '[presente]' : options.mode === 'yes' ? '[creado]  ' : '[crear]   '} ${step.label}`);
    if (!step.present && options.mode === 'yes' && step.create) {
      let failed: RunResult | void;
      try {
        failed = await step.create();
      } catch (error) {
        // IO-01: una excepción dentro de una etapa es un fallo de esa etapa, no un error inesperado de init.
        failed = { status: null, stdout: '', stderr: '', error: (error as Error).message.split('\n')[0] };
      }
      if (failed) {
        const missing = [...new Set([...steps.slice(index).map((item) => item.piece), ...WEBHOOK_PIECES])];
        if (step.stage === 'identity' && identityPending !== null) {
          const saved = Boolean((await readEnv(envFile)).DISCORD_BOT_TOKEN);
          lines[lines.length - 1] = `[PENDIENTE] ${step.label}`;
          lines.push(`[FAIL] identidad: sin adoptar; ${identityPending}`);
          return {
            code: 1,
            lines,
            stage: 'identity',
            ready: [...new Set(ready)],
            missing,
            cause: [identityPending],
            saved,
            action: identityPending,
            pending: true,
          };
        }
        lines[lines.length - 1] = `[FALLO]   ${step.label}`;
        const cause = redactedCause(failed, await knownSecrets(home, envFile, options.secrets ?? []));
        return failure(step.stage, `${step.label.split(':')[0]}: Hermes devolvió ${cause[0]}`, cause, missing);
      }
    }
    if (step.present || options.mode === 'yes') {
      ready.push(step.piece);
    }
  }
  const checkHint = `Siguiente: ai-hub control enroll --check (credenciales de Discord en ${envFile})`;
  if (!(await exists(profileDir))) {
    // `--dry-run` sin perfil: la topología aún no se puede consultar; se describe el plan sin sondear nada.
    lines.push(
      `[crear]    plataforma webhook: bloque platforms.webhook (enabled, extra.port=${DEFAULT_WEBHOOK_PORT}) en el config.yaml del dueño del listener`,
      `[crear]    ${routeLabel}`,
      'GitLab (Settings > Webhooks del proyecto):',
      `  URL: https://<host-de-hermes>:${DEFAULT_WEBHOOK_PORT}/webhooks/${ROUTE} (con /p/${PROFILE} delante si el listener es del perfil default)`,
      '  Eventos: Issues events (work items) y Merge request events',
      `  Secret token: el que genere Hermes en webhook_subscriptions.json del dueño del listener (ai-hub no lo imprime)`,
      checkHint,
    );
    return { code: 0, lines };
  }
  let phase: Awaited<ReturnType<typeof webhookPhase>>;
  try {
    phase = await webhookPhase({
      cli,
      home,
      profile: PROFILE,
      route: ROUTE,
      subscribeArgs: [
        '--events', 'Issue Hook,Merge Request Hook',
        '--script', 'gitlab-route.sh',
        '--prompt', '{script_output}',
        '--deliver', 'discord',
        '--deliver-only',
        '--description', 'ai-hub control ingest (hermes-control)',
      ],
      routeLabel,
      mode: options.mode,
      probe: options.host.probeWebhook ?? ((port) => probeWebhook(port)),
      waitMs: options.host.webhookWaitMs ?? 30_000,
      ...(options.webhookOwner !== undefined ? { webhookOwner: options.webhookOwner } : {}),
      ...(options.confirmOwner ? { confirmOwner: options.confirmOwner } : {}),
      profileEnv: await readEnv(envFile),
      ownerEnv: readEnv,
      profileEnvFile: envFile,
      lines,
      ...(options.notify ? { notify: options.notify } : {}),
      listed,
      enrollAction: ENROLL_ACTION,
    });
  } catch (error) {
    // IO-01 y webhook-operativo 4.1: una excepción en la fase del webhook es un fallo de su etapa, sin pila.
    const first = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    phase = {
      restarted: false,
      port: DEFAULT_WEBHOOK_PORT,
      topology: { state: 'running', owner: PROFILE, shared: false },
      failure: { stage: 'webhook-platform', headline: `plataforma webhook: ${first}`, cause: [first] },
    };
  }
  if (phase.failure) {
    const failed = phase.failure;
    const cause = failed.result
      ? redactedCause(failed.result, await knownSecrets(home, envFile, options.secrets ?? []))
      : (failed.cause ?? [failed.headline]);
    const headline = failed.result && failed.stage !== 'gateway' ? `${failed.headline}: Hermes devolvió ${cause[0]}` : failed.headline;
    const missing = failed.stage === 'webhook-route' ? ['ruta'] : failed.stage === 'gateway' ? ['gateway'] : WEBHOOK_PIECES;
    if (failed.stage === 'webhook-route') {
      ready.push('plataforma webhook');
    }
    const outcome = await failure(failed.stage, headline, cause, missing, failed.action, failed.pending === true);
    return { ...outcome, restarted: phase.restarted };
  }
  if (phase.notVerifiable) {
    lines.push(checkHint);
    return { code: 0, lines, webhook: 'no-verificable', action: GATEWAY_INSTALL_ACTION };
  }
  const owner = ownerOf(phase.topology, home, PROFILE);
  lines.push(
    'GitLab (Settings > Webhooks del proyecto):',
    `  URL: https://<host-de-hermes>:${phase.port}${owner.urlPath(ROUTE)}`,
    '  Eventos: Issues events (work items) y Merge request events',
    `  Secret token: el que generó Hermes, en ${owner.subscriptions} (ai-hub no lo imprime)`,
    checkHint,
  );
  return { code: 0, lines, restarted: phase.restarted, webhook: 'listening' };
}
