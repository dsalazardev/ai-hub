import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';

/**
 * webhook-operativo: la plataforma webhook de Hermes se habilita en `platforms.webhook` del `config.yaml` del dueño
 * del listener, el único archivo que leen tanto el CLI de rutas como el gateway. Este módulo lee y escribe ese
 * bloque sin tocar el resto del archivo, sondea el puerto con `GET /health` y hace las copias numeradas previas.
 * Nunca escribe un secreto, `INSECURE_NO_AUTH` ni `extra.host`.
 */
export const DEFAULT_WEBHOOK_PORT = 8644;
export const BACKUP_SUFFIX = '.pre-ai-hub';

export type WebhookBlock =
  /** Sin archivo, sin bloque o con un bloque que no declara `enabled`: la plataforma no está habilitada. */
  | { kind: 'absent'; port: number | null }
  | { kind: 'enabled'; port: number; hasSecret: boolean }
  /** `enabled: false` explícito: la persona la desactivó y no se toca. */
  | { kind: 'disabled' }
  | { kind: 'malformed'; problem: string };

export type ProbeResult = 'listening' | 'refused' | 'foreign' | 'timeout';

export class WebhookConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problem: string,
  ) {
    super(`${file}: ${problem}`);
    this.name = 'WebhookConfigError';
  }
}

/** Documento YAML del archivo, o el motivo por el que no es un mapping utilizable. El contenido nunca sale en el motivo. */
function parseConfig(text: string): { doc: Document } | { problem: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const code = doc.errors[0].code;
    return { problem: code === 'DUPLICATE_KEY' ? 'tiene claves duplicadas' : `no es YAML válido (${code})` };
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    return { problem: 'no es un mapping YAML' };
  }
  return { doc };
}

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
}

/** Estado del bloque `platforms.webhook` de un `config.yaml`; solo lectura. */
export async function readWebhookBlock(file: string): Promise<WebhookBlock> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent', port: null };
    }
    return { kind: 'malformed', problem: `no se puede leer (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const parsed = parseConfig(text);
  if ('problem' in parsed) {
    return { kind: 'malformed', problem: parsed.problem };
  }
  const root = plain(parsed.doc.toJS()) ?? {};
  if (root.platforms !== undefined && root.platforms !== null && plain(root.platforms) === null) {
    return { kind: 'malformed', problem: 'platforms no es un mapping' };
  }
  const platforms = plain(root.platforms) ?? {};
  if (platforms.webhook !== undefined && platforms.webhook !== null && plain(platforms.webhook) === null) {
    return { kind: 'malformed', problem: 'platforms.webhook no es un mapping' };
  }
  const webhook = plain(platforms.webhook);
  if (webhook === null) {
    return { kind: 'absent', port: null };
  }
  const extra = plain(webhook.extra) ?? {};
  const port = validPort(extra.port);
  if (webhook.enabled === false) {
    return { kind: 'disabled' };
  }
  if (!webhook.enabled) {
    return { kind: 'absent', port };
  }
  return { kind: 'enabled', port: port ?? DEFAULT_WEBHOOK_PORT, hasSecret: typeof extra.secret === 'string' && extra.secret.trim() !== '' };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.ai-hub-${process.pid}.tmp`;
  await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Escribe `platforms.webhook.enabled: true` y `extra.port`, conservando las demás claves, los comentarios y un
 * `extra.port` que ya existiera. Falla cerrado (sin escribir) si el archivo no es un mapping o tiene claves duplicadas.
 */
export async function writeWebhookBlock(file: string, port: number): Promise<void> {
  const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw new WebhookConfigError(file, `no se puede leer (${error.code ?? 'error'})`);
  });
  const parsed = parseConfig(text);
  if ('problem' in parsed) {
    throw new WebhookConfigError(file, parsed.problem);
  }
  const state = await readWebhookBlock(file);
  if (state.kind === 'malformed') {
    throw new WebhookConfigError(file, state.problem);
  }
  const doc = parsed.doc;
  doc.setIn(['platforms', 'webhook', 'enabled'], true);
  if (!doc.hasIn(['platforms', 'webhook', 'extra', 'port'])) {
    doc.setIn(['platforms', 'webhook', 'extra', 'port'], port);
  }
  await writeAtomic(file, doc.toString());
  const written = await readWebhookBlock(file);
  if (written.kind !== 'enabled') {
    throw new WebhookConfigError(file, 'el bloque platforms.webhook no quedó habilitado tras escribirlo');
  }
}

/** Copia `file` a `file.pre-ai-hub` o, si ese nombre existe, a `file.pre-ai-hub.<n>`; las copias nunca se sobrescriben. */
export async function numberedBackup(file: string): Promise<string | null> {
  if (!(await exists(file))) {
    return null;
  }
  let target = `${file}${BACKUP_SUFFIX}`;
  for (let index = 1; await exists(target); index += 1) {
    target = `${file}${BACKUP_SUFFIX}.${index}`;
  }
  await fs.copyFile(file, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
  return target;
}

/** Quita del `.env` solo las líneas de las claves indicadas; el resto queda byte a byte. Devuelve cuántas quitó. */
export async function removeEnvKeys(file: string, keys: readonly string[]): Promise<number> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    return 0;
  }
  const kept: string[] = [];
  let removed = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key !== undefined && keys.includes(key)) {
      removed += 1;
    } else {
      kept.push(line);
    }
  }
  if (removed > 0) {
    await writeAtomic(file, kept.join(''));
  }
  return removed;
}

function tcpOpen(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Sonda local del listener (design §D3): `GET /health` debe devolver `{"status":"ok","platform":"webhook"}`. Si HTTP
 * no responde, un TCP abierto distingue «otro proceso ocupa el puerto» de «nadie escucha». Se usa `127.0.0.1`
 * explícito para que `localhost` no resuelva antes a IPv6.
 */
export function probeWebhook(port: number, timeoutMs = 1500, host = '127.0.0.1'): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const fallback = (refused: boolean): void => {
      if (refused) {
        finish('refused');
        return;
      }
      void tcpOpen(port, host, timeoutMs).then((open) => finish(open ? 'foreign' : 'timeout'));
    };
    const request = http.get({ host, port, path: '/health', timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 4096) {
          chunks.push(chunk);
        }
      });
      response.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        const data = plain(body);
        finish(response.statusCode === 200 && data?.status === 'ok' && data?.platform === 'webhook' ? 'listening' : 'foreign');
      });
      response.on('error', () => finish('foreign'));
    });
    request.on('timeout', () => {
      request.destroy();
      fallback(false);
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (!settled) {
        fallback(error.code === 'ECONNREFUSED');
      }
    });
  });
}

/** Tope por defecto de la espera tras un reinicio: 300 s (arranque en frío medido: 177 s). */
export const DEFAULT_WEBHOOK_WAIT_MS = 300_000;
export const WEBHOOK_WAIT_ENV = 'AI_HUB_WEBHOOK_WAIT_SECONDS';
const WAIT_STEPS_MS = [500, 1000, 2000, 4000, 5000];
const PROGRESS_EVERY_MS = 15_000;

/** Tope de la espera: `AI_HUB_WEBHOOK_WAIT_SECONDS` (entero de 0 a 900) o el valor por defecto, con aviso si es inválido. */
export function webhookWaitCap(env: Record<string, string | undefined>): { ms: number; notice: string | null } {
  const raw = env[WEBHOOK_WAIT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { ms: DEFAULT_WEBHOOK_WAIT_MS, notice: null };
  }
  const text = raw.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 900) {
    return { ms: seconds * 1000, notice: null };
  }
  return {
    ms: DEFAULT_WEBHOOK_WAIT_MS,
    notice: `aviso: ${WEBHOOK_WAIT_ENV}=${text.slice(0, 20)} no es un entero entre 0 y 900; se usa el tope de ${DEFAULT_WEBHOOK_WAIT_MS / 1000} s`,
  };
}

export interface WaitOptions {
  totalMs: number;
  /** Reloj y pausa inyectables: las pruebas simulan minutos sin esperar. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Línea de progreso cada 15 s: `webhook: arrancando (45 s de 300 s)`. */
  onProgress?: (line: string) => void;
  /** ¿Sigue vivo el gateway? Se consulta cada 15 s y al llegar al tope; `false` corta la espera. */
  alive?: () => Promise<boolean>;
}

export interface WaitResult {
  /** `cap`: se agotó el tope sin evidencia de fallo (el gateway sigue arrancando). */
  outcome: 'listening' | 'foreign' | 'stopped' | 'cap';
  result: ProbeResult;
  elapsedMs: number;
}

/**
 * Sondea con backoff (0,5 → 5 s) hasta que el listener responde, aparece evidencia de fallo (puerto ajeno, gateway
 * parado) o se agota `totalMs` (design §D2 de fabrica-verificable). Nunca espera más allá del tope.
 */
export async function waitForWebhook(probe: (port: number) => Promise<ProbeResult>, port: number, options: WaitOptions): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const totalSeconds = Math.round(options.totalMs / 1000);
  let nextMark = PROGRESS_EVERY_MS;
  for (let attempt = 0; ; attempt += 1) {
    const result = await probe(port);
    const elapsedMs = now() - started;
    if (result === 'listening' || result === 'foreign') {
      return { outcome: result, result, elapsedMs };
    }
    const atCap = elapsedMs >= options.totalMs;
    if (atCap || elapsedMs >= nextMark) {
      if (options.alive && !(await options.alive())) {
        return { outcome: 'stopped', result, elapsedMs };
      }
      if (atCap) {
        return { outcome: 'cap', result, elapsedMs };
      }
      options.onProgress?.(`webhook: arrancando (${Math.round(elapsedMs / 1000)} s de ${totalSeconds} s)`);
      nextMark = (Math.floor(elapsedMs / PROGRESS_EVERY_MS) + 1) * PROGRESS_EVERY_MS;
    }
    await sleep(Math.min(WAIT_STEPS_MS[Math.min(attempt, WAIT_STEPS_MS.length - 1)], options.totalMs - elapsedMs));
  }
}
