import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseDotenv } from '../env/dotenv.js';
import { readTemplate } from '../harness/local.js';
import { loadManifestContext } from '../manifest/manifest.js';
import { ControlConfigError, requireSettings } from './decide.js';
import { hermesHome, resolveHermes, type HermesCli, type ResolverHost } from './hermes.js';
import { writeProfileEnv } from './profile-env.js';
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
  /** Identidad sin adoptar: se informa como `pendiente`, no como fallo inesperado. */
  pending?: boolean;
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
  const cli = await resolveHermes(options.host, options.hermes);
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

    const platform = profilePresent ? await profileCommand(cli, ['webhook', 'list']) : { ok: false, stdout: '' };
    add('webhook', platform.ok ? 'ok' : 'fail', platform.ok ? 'webhook: plataforma habilitada' : 'webhook: plataforma deshabilitada o lista ilegible', 'webhook-platform', ENROLL_ACTION);
    const routeOk = platform.ok && listed(platform.stdout, ROUTE);
    add('ruta', routeOk ? 'ok' : 'fail', routeOk ? `ruta: ${ROUTE}` : `ruta: ${ROUTE} no listada`, 'webhook-route', ENROLL_ACTION);
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

    const gateway = profilePresent
      ? await cli.run(['gateway', 'status'])
      : { status: null, stdout: '', stderr: 'not installed' };
    if (gateway.status === 0) {
      add('gateway', 'ok', 'gateway: en ejecución', 'gateway');
    } else {
      const detail = `${gateway.stdout}\n${gateway.stderr}`.toLowerCase();
      if (detail.includes('not installed')) {
        add('gateway', 'nv', 'gateway: no instalado (no verificable)', 'gateway');
      } else {
        add('gateway', 'fail', 'gateway: instalado pero no en ejecución', 'gateway', 'hermes gateway restart');
      }
    }

    for (const row of rows) {
      const tag = row.state === 'ok' ? '[OK]' : row.state === 'nv' ? '[NO VERIFICABLE]' : '[FAIL]';
      lines.push(`${tag} ${row.line}`);
    }
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
  let webhooks = profileExists ? await profileCommand(cli, ['webhook', 'list']) : { ok: false, stdout: '' };
  const crons = profileExists ? await profileCommand(cli, ['cron', 'list']) : { ok: false, stdout: '' };
  const scripts = scriptsDir(profileDir);
  const run = async (args: string[]): Promise<RunResult | void> => {
    const result = await cli.run(args);
    return result.status === 0 ? undefined : result;
  };
  const routeStep: Step = {
    stage: 'webhook-route',
    piece: 'ruta',
    label: `webhook: ${ROUTE} → discord (deliver-only, script gitlab-route.sh)`,
    present: webhooks.ok && listed(webhooks.stdout, ROUTE),
    // La salida de `subscribe` incluye el secreto generado: en éxito no se muestra; en fallo, solo redactada (HC-03).
    create: () =>
      run([
        '-p', PROFILE, 'webhook', 'subscribe', ROUTE,
        '--events', 'Issue Hook,Merge Request Hook',
        '--script', 'gitlab-route.sh',
        '--prompt', '{script_output}',
        '--deliver', 'discord',
        '--deliver-only',
        '--description', 'ai-hub control ingest (hermes-control)',
      ]),
  };
  const platformStep: Step = {
    stage: 'webhook-platform',
    piece: 'plataforma webhook',
    label: 'plataforma webhook: WEBHOOK_ENABLED=true · WEBHOOK_PORT=8644 (añade solo las claves ausentes)',
    present: webhooks.ok,
    create: async () => {
      // Preflight explícito aunque el perfil se acabe de crear: primero se comprueba, después se habilita.
      webhooks = await profileCommand(cli, ['webhook', 'list']);
      routeStep.present = webhooks.ok && listed(webhooks.stdout, ROUTE);
      if (webhooks.ok) {
        return undefined;
      }
      const env = await readEnv(envFile);
      const enabled = env.WEBHOOK_ENABLED?.trim().toLowerCase();
      if (enabled !== undefined && enabled !== 'true') {
        return {
          status: 1,
          stdout: '',
          stderr: `WEBHOOK_ENABLED=${env.WEBHOOK_ENABLED} es incompatible; la plataforma webhook no se habilita sin consentimiento`,
        };
      }
      const missing: Record<string, string> = {};
      if (env.WEBHOOK_ENABLED === undefined) {
        missing.WEBHOOK_ENABLED = 'true';
      }
      if (env.WEBHOOK_PORT === undefined) {
        missing.WEBHOOK_PORT = '8644';
      }
      if (Object.keys(missing).length > 0) {
        await writeProfileEnv(envFile, missing);
      }
      webhooks = await profileCommand(cli, ['webhook', 'list']);
      routeStep.present = webhooks.ok && listed(webhooks.stdout, ROUTE);
      return webhooks.ok ? undefined : { status: 1, stdout: webhooks.stdout, stderr: '' };
    },
  };
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
    platformStep,
    routeStep,
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
        const env = await readEnv(envFile);
        const saved = Boolean(env.DISCORD_BOT_TOKEN);
        if (step.stage === 'identity' && identityPending !== null) {
          const missing = [...new Set(steps.slice(index).map((item) => item.piece))];
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
        // init-fiabilidad (CO-M1, HC-03): el fallo se devuelve con su etapa y su causa redactada; nunca se lanza.
        lines[lines.length - 1] = `[FALLO]   ${step.label}`;
        const cause = redactedCause(failed, await knownSecrets(home, envFile, options.secrets ?? []));
        const missing = [...new Set(steps.slice(index).map((item) => item.piece))];
        const listo = [...new Set(ready.filter((piece) => !missing.includes(piece)))];
        if (saved) {
          listo.splice(listo.indexOf('perfil') + 1, 0, '.env');
        }
        const action = saved ? ENROLL_ACTION : RETAKE_ACTION;
        lines.push(`[FAIL] ${step.label.split(':')[0]}: Hermes devolvió ${cause[0]}`, ...cause.slice(1).map((line) => `  ${line}`), `Siguiente: ${action}`);
        return { code: 1, lines, stage: step.stage, ready: listo, missing, cause, saved, action };
      }
    }
    if (step.present || options.mode === 'yes') {
      ready.push(step.piece);
    }
  }
  lines.push(
    'GitLab (Settings > Webhooks del proyecto):',
    `  URL: https://<host-de-hermes>:8644/webhooks/${ROUTE}`,
    '  Eventos: Issues events (work items) y Merge request events',
    `  Secret token: el que generó Hermes, en ${path.join(profileDir, 'webhook_subscriptions.json')} (ai-hub no lo imprime)`,
    `Siguiente: ai-hub control enroll --check (credenciales de Discord en ${envFile})`,
  );
  return { code: 0, lines };
}
