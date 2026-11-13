import path from 'node:path';
import type { HermesCli } from './hermes.js';
import {
  DEFAULT_WEBHOOK_PORT,
  WebhookConfigError,
  numberedBackup,
  removeEnvKeys,
  waitForWebhook,
  writeWebhookBlock,
  type ProbeResult,
} from './webhook-config.js';
import type { RunResult } from '../speckit/runner.js';
import { gatewayTopology, resolveListener, type ListenerView, type Topology } from './listener.js';

export { gatewayTopology, type Topology } from './listener.js';

/**
 * webhook-operativo: la parte del enrolamiento que deja el webhook escuchando. Corre después del perfil, la identidad,
 * la skill, los scripts y el cron, para que un fallo aquí deje el plano de control operable por el tick.
 *
 * Orden: topología del gateway → bloque `platforms.webhook` del dueño del listener (con consentimiento nombrado si es
 * otro perfil) → migración de las claves heredadas del `.env` → `webhook list` → ruta → reinicio si hace falta →
 * `GET /health`. Nunca escribe un secreto.
 */
export const LEGACY_ENV_KEYS = ['WEBHOOK_ENABLED', 'WEBHOOK_PORT'] as const;
export const WEBHOOK_PIECES = ['plataforma webhook', 'ruta'];
export const GATEWAY_INSTALL_ACTION = 'hermes gateway install';
export const GATEWAY_RESTART_ACTION = 'hermes gateway restart';

export function sharedRestartWarning(owner: string): string {
  return `aviso: reiniciar el gateway del perfil "${owner}" corta las sesiones activas de todos los perfiles que sirve, no solo las de este`;
}

export const SECRET_OVERRIDE_NOTICE =
  'aviso: el .env del dueño del listener define WEBHOOK_SECRET: el gateway lo usa como secreto global y pisa platforms.webhook.extra.secret al arrancar; ai-hub no lo copia ni lo imprime';

export interface WebhookFailure {
  stage: 'gateway' | 'webhook-platform' | 'webhook-route';
  /** Texto tras `[FAIL] `. */
  headline: string;
  /** Resultado del comando de Hermes que falló (se redacta fuera) o causa propia, ya sin secretos. */
  result?: RunResult;
  cause?: string[];
  action?: string;
  pending?: boolean;
}

export interface WebhookPhaseResult {
  failure?: WebhookFailure;
  /** Sin gateway instalado: el webhook no se puede verificar y no es un fallo. */
  notVerifiable?: boolean;
  /** El tope de la espera se agotó sin evidencia de fallo: el gateway sigue arrancando (pendiente, no fallo). */
  starting?: { seconds: number };
  restarted: boolean;
  port: number;
  topology: Topology;
  /** Vista del listener con la que se decidió (fabrica-verificable §D1); ausente solo si la fase lanzó antes de resolverla. */
  view?: ListenerView;
}

export interface WebhookPhaseInput {
  cli: HermesCli;
  home: string;
  profile: string;
  route: string;
  /** Argumentos de `webhook subscribe` tras el nombre de la ruta (sin `--secret`: lo genera Hermes). */
  subscribeArgs: string[];
  routeLabel: string;
  mode: 'dry-run' | 'yes';
  probe: (port: number) => Promise<ProbeResult>;
  waitMs: number;
  /** Consentimiento nombrado: `--webhook-owner <perfil>`. */
  webhookOwner?: string;
  /** Consentimiento interactivo: la pregunta que nombra al dueño. */
  confirmOwner?: (owner: string) => Promise<boolean>;
  /** Claves del `.env` del perfil de control (solo presencia y valores no secretos). */
  profileEnv: Record<string, string>;
  ownerEnv: (file: string) => Promise<Record<string, string>>;
  profileEnvFile: string;
  lines: string[];
  /** Aviso inmediato, antes de la acción que anuncia. */
  notify?: (line: string) => void;
  listed: (output: string, name: string) => boolean;
  enrollAction: string;
}

const TRUTHY = /^(1|true|yes|on)$/i;

export async function webhookPhase(input: WebhookPhaseInput): Promise<WebhookPhaseResult> {
  const { cli, lines, mode, profile } = input;
  const yes = mode === 'yes';
  // Un aviso se emite una sola vez: de inmediato si hay notificador (antes de la acción), si no en las líneas.
  const say = (line: string): void => {
    if (input.notify) {
      input.notify(line);
    } else {
      lines.push(line);
    }
  };
  // fabrica-verificable §D1: el dueño, el bloque y la salud salen del mismo resolvedor que usan --check y doctor.
  const resolve = (): Promise<ListenerView> =>
    resolveListener({ cli, home: input.home, profile, route: input.route, probe: input.probe, crossCheckList: false });
  let view = await resolve();
  let topology = view.topology;
  const base = { restarted: false, port: DEFAULT_WEBHOOK_PORT };
  if (topology.state === 'not-installed') {
    lines.push(
      `[NO VERIFICABLE] webhook: no hay gateway de Hermes instalado; no se escribe el bloque ni la ruta y el plano de control queda operativo por el tick · acción: ${GATEWAY_INSTALL_ACTION}`,
    );
    return { ...base, topology, notVerifiable: true };
  }
  if (topology.state === 'stopped') {
    if (!yes) {
      lines.push(`[reiniciar] gateway: instalado pero parado · ${GATEWAY_RESTART_ACTION}`);
      return { ...base, topology };
    }
    say(`aviso: el gateway de Hermes está instalado pero parado; se intenta un reinicio (${GATEWAY_RESTART_ACTION})`);
    const started = await cli.run(['gateway', 'restart']);
    if (started.status === 0) {
      view = await resolve();
      topology = view.topology;
    }
    if (started.status !== 0 || topology.state !== 'running') {
      return {
        ...base,
        topology,
        failure: {
          stage: 'gateway',
          headline: 'gateway: instalado pero no en ejecución; el reinicio no lo levantó',
          result: started,
          action: GATEWAY_RESTART_ACTION,
          pending: true,
        },
      };
    }
  }
  if (input.webhookOwner !== undefined && input.webhookOwner !== topology.owner) {
    return {
      ...base,
      topology,
      failure: {
        stage: 'webhook-platform',
        headline: `plataforma webhook: --webhook-owner ${input.webhookOwner} no coincide con el dueño detectado del listener, "${topology.owner}"; no se escribió nada`,
        cause: [`dueño detectado: ${topology.owner}; indicado: ${input.webhookOwner}`],
        action: topology.shared ? `${input.enrollAction} --webhook-owner ${topology.owner}` : input.enrollAction,
      },
    };
  }
  const owner = { config: view.paths.config, env: view.paths.env, command: view.command, restartText: view.restartText };
  const block = view.block;
  if (block.kind === 'malformed') {
    return {
      ...base,
      topology,
      failure: {
        stage: 'webhook-platform',
        headline: `plataforma webhook: ${owner.config} ${block.problem}; no se escribió nada`,
        cause: [`config.yaml ${block.problem}`],
        action: `corrige ${owner.config} y repite ${input.enrollAction}`,
      },
    };
  }
  if (block.kind === 'disabled') {
    return {
      ...base,
      topology,
      failure: {
        stage: 'webhook-platform',
        headline: `plataforma webhook: platforms.webhook.enabled=false en ${owner.config}; está desactivada a propósito y no se cambia`,
        cause: ['platforms.webhook.enabled=false'],
        action: `pon platforms.webhook.enabled en true en ${owner.config} y repite ${input.enrollAction}`,
      },
    };
  }
  const legacyKeys = LEGACY_ENV_KEYS.filter((key) => input.profileEnv[key] !== undefined);
  const legacyEnabled = input.profileEnv.WEBHOOK_ENABLED?.trim();
  if (block.kind === 'absent' && legacyEnabled !== undefined && !TRUTHY.test(legacyEnabled)) {
    return {
      ...base,
      topology,
      failure: {
        stage: 'webhook-platform',
        headline: 'plataforma webhook: WEBHOOK_ENABLED del .env del perfil no es verdadero; la plataforma no se habilita sin consentimiento',
        cause: ['WEBHOOK_ENABLED heredado no es verdadero'],
        action: `quita WEBHOOK_ENABLED de ${input.profileEnvFile} y repite ${input.enrollAction}`,
      },
    };
  }
  const legacyPort = Number(input.profileEnv.WEBHOOK_PORT);
  const port =
    block.kind === 'enabled'
      ? block.port
      : (block.port ?? (Number.isInteger(legacyPort) && legacyPort > 0 && legacyPort < 65536 ? legacyPort : DEFAULT_WEBHOOK_PORT));
  const occupied = (): WebhookPhaseResult => ({
    restarted: false,
    port,
    topology,
    failure: {
      stage: 'webhook-platform',
      headline: `plataforma webhook: el puerto ${port} está ocupado por otro proceso (no responde como el webhook de Hermes)`,
      cause: [`GET http://127.0.0.1:${port}/health: documento ajeno`],
      action: `libera el puerto ${port} o elige otro en platforms.webhook.extra.port de ${owner.config}`,
    },
  });
  const before = block.kind === 'enabled' && view.health !== 'not-probed' ? view.health : await input.probe(port);
  if (before === 'foreign') {
    return occupied();
  }
  let changed = false;
  if (block.kind === 'absent') {
    const consented =
      !topology.shared || input.webhookOwner === topology.owner || (yes && (await input.confirmOwner?.(topology.owner)) === true);
    if (!consented) {
      const action = `${input.enrollAction} --webhook-owner ${topology.owner}`;
      if (yes) {
        return {
          restarted: false,
          port,
          topology,
          failure: {
            stage: 'webhook-platform',
            headline: `plataforma webhook: el listener pertenece al perfil "${topology.owner}"; habilitarla en su config.yaml la activa para todos los perfiles que sirve su gateway y exige un consentimiento que lo nombre`,
            cause: [`falta el consentimiento del dueño del listener (${topology.owner})`],
            action,
            pending: true,
          },
        };
      }
      lines.push(`[consentir] plataforma webhook: el listener pertenece al perfil "${topology.owner}"; escribir su config.yaml exige ${action}`);
    }
    lines.push(`${yes ? '[creado]  ' : '[crear]   '} plataforma webhook: bloque platforms.webhook (enabled, extra.port=${port}) en ${owner.config}`);
    if (yes) {
      try {
        if (topology.shared) {
          const copy = await numberedBackup(owner.config);
          if (copy !== null) {
            lines.push(`  copia previa del config.yaml del perfil "${topology.owner}": ${copy}`);
          }
        }
        await writeWebhookBlock(owner.config, port);
      } catch (error) {
        const problem = error instanceof WebhookConfigError ? error.problem : (error as Error).message.split('\n')[0];
        return {
          restarted: false,
          port,
          topology,
          failure: {
            stage: 'webhook-platform',
            headline: `plataforma webhook: no se pudo escribir ${owner.config} (${problem})`,
            cause: [`config.yaml ${problem}`],
            action: `corrige ${owner.config} y repite ${input.enrollAction}`,
          },
        };
      }
      changed = true;
    }
  } else {
    lines.push(`[presente] plataforma webhook: platforms.webhook habilitado en ${owner.config} (puerto ${port})`);
  }
  if (legacyKeys.length > 0) {
    lines.push(
      `${yes ? '[migrado] ' : '[migrar]  '} .env del perfil: ${legacyKeys.join(' y ')} dejan de usarse (la fuente es ${owner.config}); copia previa en ${path.basename(input.profileEnvFile)}.pre-ai-hub`,
    );
    if (yes) {
      await numberedBackup(input.profileEnvFile);
      await removeEnvKeys(input.profileEnvFile, legacyKeys);
    }
  }
  if ((await input.ownerEnv(owner.env)).WEBHOOK_SECRET) {
    lines.push(SECRET_OVERRIDE_NOTICE);
  }
  let routePresent = false;
  if (yes || block.kind === 'enabled') {
    const list = await cli.run(owner.command(['webhook', 'list']));
    if (list.status !== 0 && yes) {
      return {
        restarted: false,
        port,
        topology,
        failure: { stage: 'webhook-platform', headline: 'plataforma webhook: Hermes no la da por habilitada', result: list },
      };
    }
    // La ruta cuenta si la tiene el store del dueño (lo que carga el listener) o si la lista el CLI.
    routePresent = (view.route === 'present' && view.routeSource === 'store') || (list.status === 0 && input.listed(list.stdout, input.route));
  }
  lines.push(`${routePresent ? '[presente]' : yes ? '[creado]  ' : '[crear]   '} ${input.routeLabel}`);
  if (!routePresent && yes) {
    // La salida de `subscribe` incluye el secreto generado: en éxito se descarta; en fallo, solo redactada (HC-03).
    const subscribed = await cli.run(
      owner.command(['webhook', 'subscribe', input.route, ...input.subscribeArgs, ...(topology.shared ? ['--route-profile', profile] : [])]),
    );
    if (subscribed.status !== 0) {
      lines[lines.length - 1] = `[FALLO]   ${input.routeLabel}`;
      return { restarted: false, port, topology, failure: { stage: 'webhook-route', headline: 'webhook', result: subscribed } };
    }
  }
  const listening = !changed && (before === 'listening' || (await input.probe(port)) === 'listening');
  if (listening) {
    lines.push(`[presente] webhook: escuchando en 127.0.0.1:${port} (GET /health)`);
    return { restarted: false, port, topology, view };
  }
  if (topology.shared) {
    say(sharedRestartWarning(topology.owner));
  }
  if (!yes) {
    lines.push(`[reiniciar] gateway: ${owner.restartText} (carga el bloque; después se comprueba GET /health en 127.0.0.1:${port})`);
    return { restarted: false, port, topology, view };
  }
  const restart = await cli.run(owner.command(['gateway', 'restart']));
  if (restart.status !== 0) {
    return {
      restarted: false,
      port,
      topology,
      failure: { stage: 'gateway', headline: `gateway: falló "${owner.restartText}"`, result: restart, action: owner.restartText },
    };
  }
  // fabrica-verificable §D2: backoff con tope; un arranque lento es «arrancando», no un fallo.
  const waited = await waitForWebhook(input.probe, port, {
    totalMs: input.waitMs,
    onProgress: say,
    alive: async () => (await gatewayTopology(cli, profile)).state === 'running',
  });
  const seconds = Math.round(waited.elapsedMs / 1000);
  if (waited.outcome === 'foreign') {
    return { ...occupied(), restarted: true };
  }
  if (waited.outcome === 'stopped') {
    return {
      restarted: true,
      port,
      topology,
      view,
      failure: {
        stage: 'gateway',
        headline: `gateway: se detuvo mientras arrancaba (a los ${seconds} s del reinicio)`,
        cause: [`hermes -p ${profile} gateway status dejó de informar un gateway en ejecución`],
        action: `${owner.restartText} (y revisa el log del gateway)`,
      },
    };
  }
  if (waited.outcome === 'cap') {
    return { restarted: true, port, topology, view, starting: { seconds: Math.round(input.waitMs / 1000) } };
  }
  lines.push(`[OK]      webhook: escuchando en 127.0.0.1:${port} (GET /health)${seconds >= 1 ? ` tras ${seconds} s` : ''}`);
  return { restarted: true, port, topology, view };
}
