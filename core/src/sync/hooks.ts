import fs from 'node:fs/promises';
import path from 'node:path';
import { TARGETS, type ToolId } from './targets.js';
import { closeProposals, createExclusive, describePending, prepareProposal } from '../writes/proposals.js';
import { inspectForeignJson } from '../writes/foreign-json.js';

/**
 * Hooks ejecutables de Claude Code (G-01): entradas gestionadas mezcladas por clave en
 * `.claude/settings.json`. El archivo es del usuario: se conservan todas sus claves y entradas,
 * solo se sustituyen las que llaman a `ai-hub hook`, y un JSON inválido no se toca. No entra en
 * `sync.lock.json` (un destino obsoleto del lock se borra; este archivo jamás debe borrarse).
 */
export const HOOK_COMMAND = 'npx --no-install ai-hub hook';

export const PRE_TOOL_MATCHER = 'Bash|Read|Edit|MultiEdit|NotebookEdit|Grep|Glob|LS';

const MANAGED: Array<{ event: string; matcher?: string; hook: 'pre' | 'post' | 'stop' }> = [
  // R-051 (4.32): la política de lectura recibe lecturas, ediciones y búsquedas, no solo la shell.
  { event: 'PreToolUse', matcher: PRE_TOOL_MATCHER, hook: 'pre' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', hook: 'post' },
  { event: 'Stop', hook: 'stop' },
];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedHook(value: unknown): boolean {
  return isRecord(value) && typeof value.command === 'string' && value.command.includes('ai-hub hook ');
}

/** Devuelve la configuración con las entradas gestionadas exactas; el resto queda intacto. */
export function mergeClaudeHooks(settings: Json): Json {
  const hooks: Json = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    const kept = groups
      .map((group) =>
        isRecord(group) && Array.isArray(group.hooks)
          ? { ...group, hooks: group.hooks.filter((hook) => !isManagedHook(hook)) }
          : group,
      )
      .filter((group) => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.length === 0));
    hooks[event] = kept;
  }
  for (const managed of MANAGED) {
    const groups = Array.isArray(hooks[managed.event]) ? (hooks[managed.event] as unknown[]) : [];
    groups.push({
      ...(managed.matcher ? { matcher: managed.matcher } : {}),
      hooks: [{ type: 'command', command: `${HOOK_COMMAND} ${managed.hook}` }],
    });
    hooks[managed.event] = groups;
  }
  return { ...settings, hooks };
}

/** Comprueba que las entradas gestionadas existan; devuelve las que faltan. */
export function missingClaudeHooks(settings: Json): string[] {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  return MANAGED.filter((managed) => {
    const groups = Array.isArray(hooks[managed.event]) ? (hooks[managed.event] as unknown[]) : [];
    return !groups.some(
      (group) =>
        isRecord(group) &&
        (managed.matcher === undefined || group.matcher === managed.matcher) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((hook) => isRecord(hook) && hook.command === `${HOOK_COMMAND} ${managed.hook}`),
    );
  }).map((managed) => `${managed.event}${managed.matcher ? `(${managed.matcher})` : ''} → ai-hub hook ${managed.hook}`);
}

export interface HookProjection {
  written: string[];
  problems: string[];
  /** Capacidades pendientes de aplicación por la persona (D-65). */
  pending: string[];
}

async function readJson(file: string): Promise<{ data: Json | null; raw: string | null; invalid: boolean }> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    return { data: null, raw: null, invalid: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { data: parsed, raw, invalid: false } : { data: null, raw, invalid: true };
  } catch {
    return { data: null, raw, invalid: true };
  }
}

/**
 * Proyecta (o, con `check`, verifica) los hooks de los destinos `settings-json`. Los destinos
 * `plugin` viajan por el render normal y el lock.
 */
export async function projectSettingsHooks(root: string, tools: ToolId[], check: boolean): Promise<HookProjection> {
  const result: HookProjection = { written: [], problems: [], pending: [] };
  for (const tool of tools) {
    const spec = TARGETS[tool];
    if (spec.hookFormat !== 'settings-json' || spec.hookPath === null) {
      continue;
    }
    const file = path.join(root, ...spec.hookPath.split('/'));
    const current = await readJson(file);
    if (current.invalid) {
      result.problems.push(`${spec.hookPath} no es JSON válido; no se tocó (corrígelo y ejecuta ai-hub sync)`);
      continue;
    }
    const base = current.data ?? {};
    if (check) {
      for (const missing of missingClaudeHooks(base)) {
        result.problems.push(`falta hook gestionado en ${spec.hookPath}: ${missing}`);
      }
      continue;
    }
    if (current.raw === null) {
      // Archivo nuevo del motor (D-65): creación exclusiva; si otro lo crea antes, propuesta.
      if (await createExclusive(file, `${JSON.stringify(mergeClaudeHooks(base), null, 2)}\n`)) {
        result.written.push(spec.hookPath);
        await closeProposals(root, 'claude-hooks', spec.hookPath);
        continue;
      }
    }
    const fresh = current.raw === null ? await readJson(file) : current;
    if (fresh.invalid) {
      result.problems.push(`${spec.hookPath} no es JSON válido; no se tocó (corrígelo y ejecuta ai-hub sync)`);
      continue;
    }
    // R-033: claves duplicadas o comentarios hacen ambigua cualquier propuesta; se informa y no se toca.
    const shape = fresh.raw === null ? null : inspectForeignJson(fresh.raw);
    if (shape === 'duplicate-keys' || shape === 'comments') {
      result.problems.push(`${spec.hookPath} tiene ${shape === 'comments' ? 'comentarios' : 'claves duplicadas'}; no se tocó ni se propuso nada (corrígelo y ejecuta ai-hub sync)`);
      continue;
    }
    const missing = missingClaudeHooks(fresh.data ?? {});
    if (missing.length === 0) {
      await closeProposals(root, 'claude-hooks', spec.hookPath);
      continue;
    }
    // Configuración ajena existente (D-65): no se edita; propuesta con las entradas gestionadas.
    const prepared = await prepareProposal(root, {
      capability: 'claude-hooks',
      file,
      display: spec.hookPath,
      fragment: `${JSON.stringify({ hooks: managedHooksFragment() }, null, 2)}\n`,
      instructions: `mezcla estas entradas en "hooks" de ${spec.hookPath} conservando las tuyas`,
      check: 'ai-hub doctor (hooks) y ai-hub sync',
    });
    result.pending.push(describePending(root, prepared.proposal));
  }
  return result;
}

/** Solo las entradas gestionadas (para la propuesta): nunca el contenido del archivo del usuario. */
export function managedHooksFragment(): Json {
  return (mergeClaudeHooks({}).hooks as Json) ?? {};
}
