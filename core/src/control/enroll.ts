import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDotenv } from '../env/dotenv.js';
import { readTemplate } from '../harness/local.js';
import { loadManifestContext } from '../manifest/manifest.js';
import { requireSettings } from './decide.js';
import { hermesHome, resolveHermes, type HermesCli, type ResolverHost } from './hermes.js';

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
}

export interface EnrollOutcome {
  code: number;
  lines: string[];
}

interface Step {
  label: string;
  present: boolean;
  create?: () => Promise<void>;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
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

function listed(output: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, 'm').test(output);
}

async function profileCommand(cli: HermesCli, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await cli.run(['-p', PROFILE, ...args]);
  return { ok: result.status === 0, stdout: result.stdout };
}

export async function runEnroll(root: string, options: EnrollOptions): Promise<EnrollOutcome> {
  const manifest = (await loadManifestContext(root)).manifest;
  const settings = await requireSettings(manifest);
  const cli = await resolveHermes(options.host, options.hermes);
  const home = hermesHome(options.host);
  const profileDir = path.join(home, 'profiles', PROFILE);
  const envFile = path.join(profileDir, '.env');
  const lines = [`Hermes ${cli.version} · ${cli.path}`, `Perfil ${PROFILE} · ${profileDir}`, `  .env del perfil: ${envFile} (lo rellena la persona; ai-hub no lo lee ni lo escribe salvo para comprobar claves)`];

  if (options.mode === 'check') {
    const env = await readEnv(envFile);
    let missing = 0;
    for (const key of DISCORD_KEYS) {
      if (env[key]) {
        lines.push(`[OK]   ${key}: presente`);
      } else {
        missing += 1;
        lines.push(`[FAIL] ${key}: falta en ${envFile} · obténla en ${DISCORD_STEPS[key]}`);
      }
    }
    const collision = await tokenCollision(home, profileDir);
    if (collision !== null) {
      missing += 1;
      lines.push(`[FAIL] DISCORD_BOT_TOKEN: es el mismo bot que el perfil "${collision}"; crea un bot propio para ${PROFILE}`);
    }
    return { code: missing === 0 ? 0 : 1, lines };
  }

  const profileExists = await exists(profileDir);
  if (profileExists) {
    const collision = await tokenCollision(home, profileDir);
    if (collision !== null) {
      return { code: 1, lines: [...lines, `[FAIL] colisión de token de bot: ${PROFILE} comparte DISCORD_BOT_TOKEN con el perfil "${collision}"; no se escribe nada`] };
    }
  }
  const webhooks = profileExists ? await profileCommand(cli, ['webhook', 'list']) : { ok: false, stdout: '' };
  const crons = profileExists ? await profileCommand(cli, ['cron', 'list']) : { ok: false, stdout: '' };
  const scripts = path.join(profileDir, 'scripts');
  const steps: Step[] = [
    {
      label: `perfil: hermes profile create ${PROFILE} --no-skills`,
      present: profileExists,
      create: async () => {
        const result = await cli.run(['profile', 'create', PROFILE, '--no-skills']);
        if (result.status !== 0) {
          throw new Error(`hermes profile create falló (exit ${result.status ?? 'sin código'})`);
        }
      },
    },
    {
      label: `skill: ${path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md')}`,
      present: await exists(path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md')),
      create: async () => writeIfMissing(path.join(profileDir, 'skills', SKILL_NAME, 'SKILL.md'), await render('hermes/SKILL.md', root)),
    },
    {
      label: `script: ${path.join(scripts, 'control-poll.sh')}`,
      present: await exists(path.join(scripts, 'control-poll.sh')),
      create: async () => writeIfMissing(path.join(scripts, 'control-poll.sh'), await render('hermes/control-poll.sh', root)),
    },
    {
      label: `script: ${path.join(scripts, 'gitlab-route.sh')}`,
      present: await exists(path.join(scripts, 'gitlab-route.sh')),
      create: async () => writeIfMissing(path.join(scripts, 'gitlab-route.sh'), await render('hermes/gitlab-route.sh', root)),
    },
    {
      label: `webhook: ${ROUTE} → discord (deliver-only, script gitlab-route.sh)`,
      present: webhooks.ok && listed(webhooks.stdout, ROUTE),
      create: async () => {
        // La salida de `subscribe` incluye el secreto generado: se descarta sin imprimirla ni guardarla.
        const result = await cli.run([
          '-p', PROFILE, 'webhook', 'subscribe', ROUTE,
          '--events', 'Issue Hook,Merge Request Hook',
          '--script', 'gitlab-route.sh',
          '--prompt', '{script_output}',
          '--deliver', 'discord',
          '--deliver-only',
          '--description', 'ai-hub control ingest (hermes-control)',
        ]);
        if (result.status !== 0) {
          throw new Error(`hermes webhook subscribe falló (exit ${result.status ?? 'sin código'})`);
        }
      },
    },
    {
      label: `cron: ${CRON_NAME} cada ${settings.pollMinutes} min → discord (sin agente, script control-poll.sh)`,
      present: crons.ok && listed(crons.stdout, CRON_NAME),
      create: async () => {
        const result = await cli.run([
          '-p', PROFILE, 'cron', 'create', `every ${settings.pollMinutes}m`,
          '--name', CRON_NAME, '--no-agent', '--script', 'control-poll.sh', '--deliver', 'discord',
        ]);
        if (result.status !== 0) {
          throw new Error(`hermes cron create falló (exit ${result.status ?? 'sin código'})`);
        }
      },
    },
  ];
  for (const step of steps) {
    lines.push(`${step.present ? '[presente]' : options.mode === 'yes' ? '[creado]  ' : '[crear]   '} ${step.label}`);
    if (!step.present && options.mode === 'yes' && step.create) {
      await step.create();
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
