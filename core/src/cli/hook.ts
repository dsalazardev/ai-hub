import { spawnSync } from 'node:child_process';
import { replaceOwned } from '../writes/replace.js';
import { classifyDelivery } from '../harness/guards/delivery.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEngine } from '../engine/engine.js';
import { resolveRoleScopes } from '../engine/scopes.js';
import { buildGuardContext } from '../harness/guards/adapters/context.js';
import {
  claudePreToolUse,
  commandFromHookInput,
  opencodeToolExecuteBefore,
  type ClaudePreToolUseInput,
  type OpenCodeHookInput,
} from '../harness/guards/adapters/hooks.js';
import type { GuardContext, GuardMode } from '../harness/guards/types.js';
import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import type { CliContext, ParsedArgs } from './types.js';
import { appendRunEvent, pruneRuns, readRunEvents } from '../harness/runs.js';
import { caseInsensitiveFs, recognizedReads } from '../harness/guards/adapters/read-targets.js';
import { evaluateRead, READ_OPT_OUT } from '../harness/guards/read-policy.js';
import os from 'node:os';

/** Eventos que el arnés proyecta como hooks de host (G-01). */
export const HOOK_EVENTS = ['pre', 'post', 'stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const MAX_INPUT = 1024 * 1024;
const SCOPE_DIR = '.ai-hub/runs/scope';

type HookPayload = Record<string, unknown>;

function isRecord(value: unknown): value is HookPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function host(input: HookPayload): 'claude' | 'opencode' {
  return 'tool_name' in input || 'hook_event_name' in input || 'tool_input' in input ? 'claude' : 'opencode';
}

/** Rol activo del paso: `AI_HUB_ROLE` o el tipo de subagente que reporta el host. */
export function activeRole(input: HookPayload, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.AI_HUB_ROLE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  for (const key of ['agent_type', 'subagent_type', 'agent']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

function sessionKey(input: HookPayload): string {
  const raw = input.session_id ?? input.sessionID ?? 'default';
  return String(raw).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'default';
}

/** Glob mínimo de `can_modify`: `**` cualquier ruta, `*` un segmento. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        pattern += '(?:/)?';
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Estado del árbol: cada ruta cambiada o sin rastrear (incluidos archivos dentro de directorios
 * sin rastrear) con el hash de su contenido; una ruta borrada vale `deleted`.
 */
export async function treeState(root: string): Promise<Record<string, string> | null> {
  const raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (raw === null) {
    return null;
  }
  const state: Record<string, string> = {};
  const parts = raw.split('\0').filter((part) => part !== '');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (code.startsWith('R') || code.startsWith('C')) {
      i += 1;
    }
    const bytes = await fs.readFile(path.join(root, rel)).catch(() => null);
    state[rel] = bytes === null ? 'deleted' : createHash('sha256').update(bytes).digest('hex');
  }
  return state;
}

export function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

/** Rutas cambiadas por el paso que caen fuera del `can_modify` resuelto del rol. */
export function scopeViolations(changed: string[], canModify: string[]): string[] {
  const patterns = canModify.map(globToRegExp);
  return changed.filter((rel) => !patterns.some((pattern) => pattern.test(rel)));
}

/** `can_modify` efectivo del rol: el del motor, o el resuelto desde las áreas del proyecto (E3). */
async function roleScope(role: string, root: string): Promise<string[] | null> {
  const engine = await loadEngine();
  const match = engine.roles.find((item) => item.id === role || item.canonical === role);
  if (!match) {
    return null;
  }
  const areas = await loadManifestContext(root).then(
    (context) => context.manifest.paths.areas,
    () => undefined,
  );
  return resolveRoleScopes(engine, areas)[match.id] ?? null;
}

async function guardContext(root: string, manifest: ProjectManifest): Promise<GuardContext> {
  return buildGuardContext({
    root,
    preset: manifest.preset.id,
    languages: manifest.stack.languages,
    policy: { trunk: manifest.policy.trunk, guardMode: manifest.policy.guardMode, optOuts: manifest.policy.optOuts },
    presetPatterns: manifest.policy.dangerPatterns,
  });
}

export interface HookOutcome {
  /** JSON que el host lee por stdout; `{}` = sin opinión (permitir). */
  output: Record<string, unknown>;
  /** Mensaje informativo (nunca bloquea). */
  note?: string;
}

const ALLOW: HookOutcome = { output: {} };

async function onPre(root: string, input: HookPayload): Promise<HookOutcome> {
  const manifest = (await loadManifestContext(root)).manifest;
  const mode: GuardMode = manifest.policy.guardMode;
  const role = activeRole(input);
  if (role !== null && (await roleScope(role, root)) !== null) {
    const state = await treeState(root);
    if (state !== null) {
      const file = path.join(root, ...SCOPE_DIR.split('/'), `${sessionKey(input)}.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // 3.11: instantánea regenerable por la transacción X2; si falla, el hook sigue fallando abierto.
      await replaceOwned({ root, file, module: 'cli/hook.ts', content: JSON.stringify({ role, state }) });
    }
  }
  await ensureSessionRun(root, sessionRun(input)).catch(() => undefined);
  // R-047–R-053: la política de lectura va antes del contexto de git, que puede fallar abierto; con el manifiesto
  // cargado, una lectura reconocida no verificable o sensible se deniega en `enforce` aunque lo demás falle.
  const reads = await readPolicy(root, input, manifest, mode);
  const claude = host(input) === 'claude';
  // R-072 (4.63): un rol implementer no abre peticiones de cambio, en cualquier modo.
  const command = commandFromHookInput(input as ClaudePreToolUseInput);
  const delivery = command === null ? null : classifyDelivery(command, role);
  if (delivery !== null) {
    const text = `${delivery.rule}: ${delivery.reason}`;
    return claude
      ? { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text }, systemMessage: text } }
      : { output: { blocked: true, message: text } };
  }
  if (reads.deny !== null) {
    return claude
      ? { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reads.deny }, systemMessage: reads.deny } }
      : { output: { blocked: true, message: reads.deny } };
  }
  const warning = reads.warnings.length > 0 ? reads.warnings.join('\n') : null;
  let ctx: GuardContext;
  try {
    ctx = await guardContext(root, manifest);
  } catch {
    return warning === null ? ALLOW : withWarning(ALLOW, warning, claude);
  }
  if (claude) {
    const decision = claudePreToolUse(input as ClaudePreToolUseInput, ctx, mode);
    if (decision === null) {
      return warning === null ? ALLOW : withWarning(ALLOW, warning, claude);
    }
    const outcome: HookOutcome = {
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.permissionDecision,
          ...(decision.permissionDecisionReason ? { permissionDecisionReason: decision.permissionDecisionReason } : {}),
        },
        ...(decision.systemMessage ? { systemMessage: decision.systemMessage } : {}),
      },
    };
    return warning === null ? outcome : withWarning(outcome, warning, claude);
  }
  const decision = opencodeToolExecuteBefore(input as OpenCodeHookInput, ctx, mode);
  const outcome = decision === null ? ALLOW : { output: { ...decision } };
  return warning === null ? outcome : withWarning(outcome, warning, claude);
}

/** Añade el aviso de `shadow` al canal visible del host (mensaje del sistema en Claude, mensaje en OpenCode). */
function withWarning(outcome: HookOutcome, warning: string, claude: boolean): HookOutcome {
  const key = claude ? 'systemMessage' : 'message';
  const previous = typeof outcome.output[key] === 'string' ? `\n${outcome.output[key] as string}` : '';
  return { ...outcome, output: { ...outcome.output, [key]: `${warning}${previous}`, ...(claude ? {} : { blocked: outcome.output.blocked === true }) } };
}

/**
 * Evalúa las lecturas reconocidas del payload. Devuelve la denegación (enforce) o los avisos (shadow) y deja un
 * registro redactado en `runs` v2 (`note_type: guard`) con el patrón y la herramienta, nunca la ruta ni el contenido.
 */
async function readPolicy(root: string, input: HookPayload, manifest: ProjectManifest, mode: GuardMode): Promise<{ deny: string | null; warnings: string[] }> {
  if (manifest.policy.optOuts.includes(READ_OPT_OUT)) {
    return { deny: null, warnings: [] };
  }
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() !== '' ? input.cwd : root;
  const env = { cwd, home: os.homedir(), platform: process.platform };
  const warnings: string[] = [];
  for (const read of await recognizedReads(input, env)) {
    const result = evaluateRead(read, mode, caseInsensitiveFs(env.platform));
    if (result.rule === null || result.warning === null) {
      continue;
    }
    await appendRunEvent(root, {
      ts: new Date().toISOString(),
      run: sessionRun(input),
      kind: 'note',
      note_type: 'guard',
      origin: 'hook',
      note: `${result.rule} ${read.action} ${read.tool.slice(0, 40)} ${result.decision}`,
    }).catch(() => undefined);
    if (result.decision === 'deny') {
      return { deny: result.warning, warnings };
    }
    warnings.push(result.warning);
  }
  return { deny: null, warnings };
}

async function onPost(root: string, input: HookPayload): Promise<HookOutcome> {
  const file = path.join(root, ...SCOPE_DIR.split('/'), `${sessionKey(input)}.json`);
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    return ALLOW;
  }
  const snapshot = JSON.parse(raw) as { role: string; state: Record<string, string> };
  const scope = await roleScope(snapshot.role, root);
  const after = await treeState(root);
  if (scope === null || after === null) {
    return ALLOW;
  }
  const violations = scopeViolations(changedPaths(snapshot.state, after), scope);
  if (violations.length === 0) {
    return ALLOW;
  }
  const text = `scope: ${snapshot.role} modificó fuera de su can_modify: ${violations.slice(0, 10).join(', ')}${violations.length > 10 ? ` (+${violations.length - 10})` : ''}`;
  // Informa; jamás revierte ni modifica archivos.
  return { output: { systemMessage: text }, note: text };
}

/** Ejecución de la sesión del host: `AI_HUB_RUN` o `session-<id>` (válido para el esquema de runs). */
export function sessionRun(input: HookPayload, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AI_HUB_RUN?.trim();
  if (fromEnv && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(fromEnv)) {
    return fromEnv;
  }
  return `session-${sessionKey(input).slice(0, 70)}`;
}

async function ensureSessionRun(root: string, run: string): Promise<void> {
  if ((await readRunEvents(root, run)).length === 0) {
    await pruneRuns(root);
    await appendRunEvent(root, { ts: new Date().toISOString(), run, kind: 'start', step: 'session', origin: 'hook' });
  }
}

/** Fin de turno: el motor registra duración y fin (una cifra, un escritor: el hook). */
async function onStop(root: string, input: HookPayload): Promise<HookOutcome> {
  const run = sessionRun(input);
  await ensureSessionRun(root, run);
  const start = (await readRunEvents(root, run)).find((event) => event.kind === 'start');
  const elapsed = start ? Math.max(0, Date.now() - Date.parse(start.ts)) : 0;
  await appendRunEvent(root, { ts: new Date().toISOString(), run, kind: 'end', origin: 'hook', duration_ms: Math.min(elapsed, 604_800_000) });
  return ALLOW;
}

/**
 * Hook de host: lee el payload, decide y devuelve la respuesta. Falla abierto: cualquier error
 * (JSON inválido, sin git, sin manifiesto) produce "permitir" y exit 0.
 */
export async function runHook(event: HookEvent, raw: string, root: string): Promise<HookOutcome> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return ALLOW;
  }
  if (!isRecord(input)) {
    return ALLOW;
  }
  try {
    if (event === 'pre') {
      return await onPre(root, input);
    }
    if (event === 'post') {
      return await onPost(root, input);
    }
    return await onStop(root, input);
  } catch {
    return ALLOW;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_INPUT) {
      return '';
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function cmdHook(args: ParsedArgs, ctx: CliContext, stdin: () => Promise<string> = readStdin): Promise<number> {
  const [event] = args.positionals;
  if (!HOOK_EVENTS.includes(event as HookEvent)) {
    ctx.io.err(`Uso: ai-hub hook <${HOOK_EVENTS.join('|')}> (lee el payload del host por stdin)`);
    return 2;
  }
  const outcome = await runHook(event as HookEvent, await stdin().catch(() => ''), ctx.root);
  ctx.io.out(JSON.stringify(outcome.output));
  return 0;
}
