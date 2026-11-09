import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import { loadEngine } from '../engine/engine.js';
import { readHarnessEnv } from '../env/dotenv.js';
import { loadManifestContext } from '../manifest/manifest.js';
import { flagString } from '../cli/args.js';
import type { CliContext, ParsedArgs } from '../cli/types.js';
import { HARNESS_RUNS_DIR } from './local.js';
import { parseStatusLine, statusContract, type StatusLine } from '../speckit/status.js';

/**
 * Telemetría de ejecuciones del consumidor (PD-2, M-06): `ai-hub runs` es el ÚNICO escritor de
 * `.ai-hub/runs/<run>/events.jsonl`. Esquema cerrado (`schema/runs.schema.json`), hermano del ledger
 * del taller: jamás guarda prompts, respuestas, contenido de archivos, tokens ni variables de entorno.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'runs.schema.json');

export const RUN_KINDS = ['start', 'step', 'status', 'note', 'metric', 'end'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const NOTE_TYPES = ['decision', 'warn', 'awaiting-ok', 'lesson'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const DEFAULT_RUNS_KEEP = 50;

export interface RunEvent {
  v: 1;
  ts: string;
  run: string;
  kind: RunKind;
  step?: string;
  attempt?: number;
  duration_ms?: number;
  state?: string;
  artifact?: string;
  reason_code?: string;
  note_type?: NoteType;
  note?: string;
  metric?: { key: string; value: number };
}

export class RunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunValidationError';
  }
}

let validator: ValidateFunction | null = null;

async function validate(): Promise<ValidateFunction> {
  if (validator === null) {
    const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, 'utf8')) as object;
    validator = new Ajv({ allErrors: true }).compile(schema);
  }
  return validator;
}

/** Estados admitidos: las claves de `exit_effects` más los veredictos del panel. */
export async function allowedStates(): Promise<Set<string>> {
  return new Set(statusContract(await loadEngine()).states);
}

/** Prefijos de credenciales conocidos y cadenas de alta entropía: nunca entran en la telemetría. */
const SECRET_PATTERNS = [
  /\b(?:glpat-|gl[a-z]{2,4}-|ghp_|gho_|ghs_|github_pat_|sk-|xox[abpr]-|AKIA|AIza)[A-Za-z0-9_-]{6,}/,
  /[A-Za-z0-9+/=_-]{32,}/,
];

async function secretValues(root: string): Promise<string[]> {
  const values = Object.values((await readHarnessEnv(root)) ?? {});
  return values.filter((value) => value.length >= 6 && value !== 'CHANGEME');
}

/** Texto libre permitido (nota, artefacto): sin secretos, sin saltos de línea, ≤ 200. */
async function assertClean(root: string, field: string, value: string): Promise<void> {
  if (/[\r\n]/.test(value)) {
    throw new RunValidationError(`"${field}" no admite saltos de línea (no se guarda contenido)`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new RunValidationError(`"${field}" parece contener un secreto; no se registra`);
  }
  for (const secret of await secretValues(root)) {
    if (value.includes(secret)) {
      throw new RunValidationError(`"${field}" contiene un valor de .ai-hub/.env; no se registra`);
    }
  }
}

export function runsDir(root: string): string {
  return path.join(root, ...HARNESS_RUNS_DIR.split('/'));
}

function eventsFile(root: string, run: string): string {
  return path.join(runsDir(root), run, 'events.jsonl');
}

/** Valida un evento contra el esquema cerrado y las reglas de contenido; no escribe nada. */
export async function validateRunEvent(root: string, event: RunEvent): Promise<RunEvent> {
  const check = await validate();
  if (!check(event)) {
    const detail = (check.errors ?? [])
      .map((error) => {
        const params = error.params as Record<string, unknown>;
        const extra = typeof params.additionalProperty === 'string' ? ` "${params.additionalProperty}"` : '';
        return `${error.instancePath || '(evento)'}${extra} ${error.message ?? 'inválido'}`;
      })
      .join('; ');
    throw new RunValidationError(`evento inválido: ${detail}`);
  }
  if (event.state !== undefined && !(await allowedStates()).has(event.state)) {
    throw new RunValidationError(`estado desconocido: ${event.state}`);
  }
  for (const field of ['note', 'artifact'] as const) {
    const value = event[field];
    if (value !== undefined) {
      await assertClean(root, field, value);
    }
  }
  return event;
}

export async function appendRunEvent(root: string, event: RunEvent): Promise<void> {
  const valid = await validateRunEvent(root, event);
  const file = eventsFile(root, valid.run);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(valid)}\n`, 'utf8');
}

export async function readRunEvents(root: string, run: string): Promise<RunEvent[]> {
  const raw = await fs.readFile(eventsFile(root, run), 'utf8').catch(() => '');
  const events: RunEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** Ejecuciones existentes, de la más antigua a la más reciente (el id empieza por la fecha). */
export async function listRuns(root: string): Promise<string[]> {
  const entries = await fs.readdir(runsDir(root), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'scope')
    .map((entry) => entry.name)
    .sort();
}

async function retention(root: string): Promise<number> {
  try {
    const policy = (await loadManifestContext(root)).manifest.policy;
    const keep = policy.runs?.keep;
    return typeof keep === 'number' && keep >= 1 ? keep : DEFAULT_RUNS_KEEP;
  } catch {
    return DEFAULT_RUNS_KEEP;
  }
}

/** Poda: deja hueco para una ejecución nueva sin superar `policy.runs.keep`. */
export async function pruneRuns(root: string, keep?: number): Promise<string[]> {
  const limit = keep ?? (await retention(root));
  const runs = await listRuns(root);
  const excess = runs.length - (limit - 1);
  const removed = excess > 0 ? runs.slice(0, excess) : [];
  for (const run of removed) {
    await fs.rm(path.join(runsDir(root), run), { recursive: true, force: true });
  }
  return removed;
}

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export async function startRun(root: string, step?: string, now: Date = new Date()): Promise<string> {
  await pruneRuns(root);
  const run = newRunId(now);
  await appendRunEvent(root, { v: 1, ts: now.toISOString(), run, kind: 'start', ...(step ? { step } : {}) });
  return run;
}


const RUN_FLAGS: Record<string, readonly string[]> = {
  start: ['step'],
  event: ['run', 'kind', 'step', 'attempt', 'duration-ms', 'state', 'artifact', 'reason', 'metric', 'from-status'],
  note: ['run', 'type', 'text', 'step'],
  end: ['run', 'state', 'duration-ms', 'reason'],
  list: ['json'],
};

const USAGE = [
  'Uso: ai-hub runs start [--step <id>]',
  '     ai-hub runs event --run <id> --kind step|status|metric [--step] [--attempt N] [--duration-ms N] [--state S] [--artifact ruta] [--reason código] [--metric clave=valor] [--from-status "<línea>"]',
  '     ai-hub runs note --run <id> --type decision|warn|awaiting-ok|lesson [--text "≤200, sin contenido"]',
  '     ai-hub runs end --run <id> [--state S] [--duration-ms N] [--reason código]',
  '     ai-hub runs list [--json]',
].join('\n');

function integerFlag(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === null) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new RunValidationError(`--${name} debe ser un entero`);
  }
  return Number.parseInt(value, 10);
}

function optional<K extends keyof RunEvent>(key: K, value: RunEvent[K] | null | undefined): Partial<RunEvent> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Partial<RunEvent>);
}

export async function cmdRuns(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  const allowed = sub ? RUN_FLAGS[sub] : undefined;
  if (!allowed) {
    ctx.io.err(USAGE);
    return 2;
  }
  const unknown = Object.keys(args.flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0) {
    ctx.io.err(`campo desconocido para runs ${sub}: ${unknown.map((flag) => `--${flag}`).join(', ')}; no se escribió nada`);
    return 2;
  }
  try {
    if (sub === 'list') {
      const runs = await listRuns(ctx.root);
      const rows = [];
      for (const run of runs) {
        const events = await readRunEvents(ctx.root, run);
        const last = [...events].reverse().find((event) => event.state !== undefined);
        rows.push({ run, events: events.length, state: last?.state ?? null, ended: events.some((event) => event.kind === 'end') });
      }
      if (args.flags.json) {
        ctx.io.out(JSON.stringify(rows, null, 2));
      } else {
        ctx.io.out(`ejecuciones: ${rows.length}`);
        for (const row of rows) {
          ctx.io.out(`  ${row.run}  ${row.state ?? '-'}  ${row.events} eventos${row.ended ? ' · cerrada' : ''}`);
        }
      }
      return 0;
    }
    if (sub === 'start') {
      ctx.io.out(await startRun(ctx.root, flagString(args, 'step') ?? undefined));
      return 0;
    }
    const run = flagString(args, 'run');
    if (run === null) {
      throw new RunValidationError('--run <id> es obligatorio');
    }
    const ts = new Date().toISOString();
    let event: RunEvent;
    if (sub === 'note') {
      const type = flagString(args, 'type');
      if (type === null || !(NOTE_TYPES as readonly string[]).includes(type)) {
        throw new RunValidationError(`--type debe ser ${NOTE_TYPES.join('|')}`);
      }
      event = {
        v: 1,
        ts,
        run,
        kind: 'note',
        note_type: type as NoteType,
        ...optional('note', flagString(args, 'text')),
        ...optional('step', flagString(args, 'step')),
      };
    } else if (sub === 'end') {
      event = {
        v: 1,
        ts,
        run,
        kind: 'end',
        ...optional('state', flagString(args, 'state')),
        ...optional('duration_ms', integerFlag(args, 'duration-ms')),
        ...optional('reason_code', flagString(args, 'reason')),
      };
    } else {
      const fromStatus = flagString(args, 'from-status');
      let parsed: StatusLine | null = null;
      if (fromStatus !== null) {
        try {
          parsed = parseStatusLine(fromStatus, statusContract(await loadEngine()));
        } catch {
          parsed = null;
        }
      }
      const state = flagString(args, 'state');
      if (fromStatus !== null && parsed === null) {
        // La línea no cumple el contrato: se registra el motivo, nunca el texto recibido.
        event = { v: 1, ts, run, kind: 'status', reason_code: 'invalid_status' };
      } else if (parsed !== null) {
        // Del contrato se guardan estado, artefacto y código; la frase libre nunca se persiste.
        event = {
          v: 1,
          ts,
          run,
          kind: 'status',
          state: parsed.state,
          ...optional('artifact', parsed.artifact),
          ...optional('reason_code', parsed.reasonCode),
          ...optional('step', flagString(args, 'step')),
        };
      } else {
        const kind = flagString(args, 'kind') ?? (fromStatus !== null ? 'status' : null);
        if (kind === null || !['step', 'status', 'metric'].includes(kind)) {
          throw new RunValidationError('--kind debe ser step|status|metric');
        }
        const metricRaw = flagString(args, 'metric');
        let metric: RunEvent['metric'];
        if (metricRaw !== null) {
          const match = /^([a-z][a-z0-9_]{0,39})=(-?\d+(?:\.\d+)?)$/.exec(metricRaw);
          if (!match) {
            throw new RunValidationError('--metric debe ser clave=número');
          }
          metric = { key: match[1], value: Number(match[2]) };
        }
        event = {
          v: 1,
          ts,
          run,
          kind: kind as RunKind,
          ...optional('step', flagString(args, 'step')),
          ...optional('attempt', integerFlag(args, 'attempt')),
          ...optional('duration_ms', integerFlag(args, 'duration-ms')),
          ...optional('state', state),
          ...optional('artifact', flagString(args, 'artifact')),
          ...optional('reason_code', flagString(args, 'reason')),
          ...optional('metric', metric),
        };
      }
    }
    await appendRunEvent(ctx.root, event);
    ctx.io.out(`[OK]    runs: ${event.kind} registrado en ${run}`);
    return 0;
  } catch (error) {
    if (error instanceof RunValidationError) {
      ctx.io.err(`${error.message}; no se escribió nada`);
      return 2;
    }
    throw error;
  }
}
