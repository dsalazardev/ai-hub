import fs from 'node:fs/promises';
import path from 'node:path';
import { TARGETS, type ToolId } from './targets.js';

/**
 * Hooks ejecutables de Claude Code (G-01): entradas gestionadas mezcladas por clave en
 * `.claude/settings.json`. El archivo es del usuario: se conservan todas sus claves y entradas,
 * solo se sustituyen las que llaman a `ai-hub hook`, y un JSON inválido no se toca. No entra en
 * `sync.lock.json` (un destino obsoleto del lock se borra; este archivo jamás debe borrarse).
 */
export const HOOK_COMMAND = 'npx --no-install ai-hub hook';

const MANAGED: Array<{ event: string; matcher?: string; hook: 'pre' | 'post' | 'stop' }> = [
  { event: 'PreToolUse', matcher: 'Bash', hook: 'pre' },
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
  const result: HookProjection = { written: [], problems: [] };
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
    const next = `${JSON.stringify(mergeClaudeHooks(base), null, 2)}\n`;
    if (next !== current.raw) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, next, 'utf8');
      result.written.push(spec.hookPath);
    }
  }
  return result;
}
