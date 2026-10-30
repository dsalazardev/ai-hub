import type { ParsedArgs } from './types.js';
import type { CliContext } from './types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TARGETS, TOOL_HINTS, TOOL_IDS, isToolId, type ToolId } from '../sync/targets.js';
import { detectPreset } from '../presets/detect.js';
import { loadEngine } from '../engine/engine.js';
import { effectiveSpeckit } from '../speckit/settings.js';
import { probeEnvironment, probeShell, speckitPreflight, type SpeckitEnvironment } from '../speckit/commands.js';
// Ciclo intencional con onboarding.ts (D2): ambos módulos se usan sólo a nivel de
// función, nunca a nivel de módulo, así que los live bindings de ESM lo resuelven.
import { cmdInit, prepareInit, printInitPlan, type PreparedInit } from './onboarding.js';
import { PRE_PROMPT } from './preprompt.js';

/** Opción de un prompt del asistente. */
export interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Prompts del asistente (design D13): el colector recibe esta interfaz inyectable;
 * el adaptador real (clack) vive en `assistant-clack.ts` y sólo se carga con TTY.
 * `null` en cualquier prompt significa cancelación (Ctrl+C, R5): el colector
 * retorna antes de cualquier escritura.
 */
export interface AssistantPrompts {
  intro(title: string): void;
  note(message: string): void;
  multiselect(message: string, options: PromptOption[], initial: string[]): Promise<string[] | null>;
  select(message: string, options: PromptOption[], initial?: string): Promise<string | null>;
  text(message: string): Promise<string | null>;
  confirm(message: string): Promise<boolean | null>;
}

/** Decisiones que hoy son flags de init; la idea es la única que no lo es (design D6). */
export interface AssistantAnswers {
  targets: ToolId[];
  /** `null`: usar el preset detectado (sin flag `--preset`). */
  preset: string | null;
  profile: 'full' | 'preset-only' | 'custom';
  excludes: string[];
  /** `null`: usar el script efectivo por defecto (sin flag `--script`). */
  script: 'sh' | 'ps' | null;
  /** Idea del proyecto; `null` = paso saltado (no se escribe `backlog/`). */
  idea: string | null;
}

/**
 * R1: el asistente es una generadora de flags. `answersToFlags` reproduce exactamente
 * las estructuras que `parseArgs` produce para el argv equivalente; el plan lo construye
 * el mismo constructor compartido de `cmdInit`, así que el hash es idéntico por construcción.
 */
export function answersToFlags(answers: AssistantAnswers): ParsedArgs {
  const flags: Record<string, string | boolean> = {
    yes: true,
    targets: answers.targets.join(','),
  };
  if (answers.preset !== null) {
    flags.preset = answers.preset;
  }
  if (answers.profile === 'full') {
    flags.full = true;
  } else if (answers.profile === 'preset-only') {
    flags['preset-only'] = true;
  } else if (answers.excludes.length > 0) {
    flags.exclude = answers.excludes.join(',');
  }
  if (answers.script !== null) {
    flags.script = answers.script;
  }
  return { positionals: [], flags };
}

/**
 * Regla compartida de `--exclude` (R1): el asistente valida con la misma regla que
 * `parseExclusions` del camino de flags, para que todo exclude aceptado por la TUI
 * sea válido como flag. Las reglas base no se pueden excluir.
 */
export function assertExclusions(items: string[]): void {
  for (const item of items) {
    const separator = item.indexOf(':');
    const kind = separator >= 0 ? item.slice(0, separator) : 'skill';
    const id = separator >= 0 ? item.slice(separator + 1) : item;
    if (kind === 'rule' && (id === 'core' || id === 'preflight')) {
      throw new Error(`la regla base "${id}" no se puede excluir`);
    }
  }
}

/**
 * Gate del asistente (design D3): sólo arranca en una instalación (no en el checkout
 * del motor, que decide `cmdInit`), con TTY real y sin ningún flag. Una petición con
 * flags es una petición explícita del usuario y corre el flujo actual intacto (R2).
 */
export function isInteractiveRequest(args: ParsedArgs, ctx: CliContext): boolean {
  if (args.positionals.length > 0 || Object.keys(args.flags).length > 0) {
    return false;
  }
  return ctx.interactive ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
}

/** Etiqueta de display de cada destino; las rutas viven en `TARGETS`, no aquí. */
const TOOL_LABELS: Record<ToolId, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  pi: 'Pi',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
};

/**
 * Presencia de herramientas: `<comando> --version` vía `ctx.exec` (design D7, datos
 * declarativos en `TOOL_HINTS`). Sólo pregunta por el binario; jamás lee estado de
 * login ni credenciales.
 */
export async function detectTools(ctx: CliContext): Promise<string[]> {
  const found: string[] = [];
  for (const tool of TOOL_IDS) {
    const result = await ctx.exec(TOOL_HINTS[tool].probeCommand, ['--version'], {
      cwd: ctx.root,
      timeoutMs: 10_000,
    });
    if (result.status === 0) {
      found.push(tool);
    }
  }
  return found;
}

/** Paso custom (D12): excludes guiados con la regla compartida; input inválido re-pregunta. */
async function promptExcludes(prompts: AssistantPrompts): Promise<string[] | null> {
  for (;;) {
    const answer = await prompts.text(
      'Ids a excluir, separados por coma (skill por defecto; agent:<id>; rule:<id>; vacío = excluir nada)',
    );
    if (answer === null) {
      return null;
    }
    const items = answer
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    try {
      assertExclusions(items);
      return items;
    } catch (error) {
      prompts.note(`No pude aplicar esos excludes: ${(error as Error).message}`);
    }
  }
}

/**
 * Colector de las decisiones de onboarding (design D12, pasos 1-4). Devuelve las
 * respuestas resueltas a la semántica de flags, o `null` si el usuario canceló
 * en cualquier paso (R5). La idea (paso 6) llega con el grupo de semilla.
 * `installed` es la detección de herramientas (paso 1); si viene ausente se sondea.
 */
export async function collectAnswers(
  prompts: AssistantPrompts,
  ctx: CliContext,
  installed?: string[],
): Promise<AssistantAnswers | null> {
  // Paso 1: targets multi-select con preselección por detección (D7).
  const detected = installed ?? (await detectTools(ctx));
  const targetOptions: PromptOption[] = TOOL_IDS.map((tool) => ({
    value: tool,
    label: TOOL_LABELS[tool],
    hint: TARGETS[tool].skills,
  }));
  const chosenTargets = await prompts.multiselect(
    '¿En qué clientes instalas el arnés?',
    targetOptions,
    detected,
  );
  if (chosenTargets === null) {
    return null;
  }
  const targets = chosenTargets.filter(isToolId);
  if (targets.length === 0) {
    return null;
  }

  // Paso 2: preset detectado; empate → elección explícita, nunca adivinar.
  const detection = await detectPreset(ctx.root);
  let preset: string | null = null;
  if (detection.ambiguous.length > 0) {
    preset = await prompts.select(
      `Detección ambigua entre ${detection.ambiguous.join(', ')}; elige el preset`,
      detection.ambiguous.map((id) => ({ value: id, label: id })),
      detection.ambiguous[0],
    );
    if (preset === null) {
      return null;
    }
  } else {
    prompts.note(`Preset detectado: ${detection.id}`);
  }

  // Paso 3: perfil del catálogo; custom guía los excludes.
  const profile = await prompts.select('¿Cuánto catálogo instalamos?', [
    { value: 'full', label: 'full', hint: 'todo el catálogo de skills, agentes y reglas' },
    { value: 'preset-only', label: 'preset-only', hint: 'sólo lo que declara el preset' },
    { value: 'custom', label: 'custom', hint: 'full con excludes guiados' },
  ]);
  if (profile !== 'full' && profile !== 'preset-only' && profile !== 'custom') {
    return null;
  }
  let excludes: string[] = [];
  if (profile === 'custom') {
    const collected = await promptExcludes(prompts);
    if (collected === null) {
      return null;
    }
    excludes = collected;
  }

  // Paso 4: script sh/ps informando el shell resuelto para sh antes de elegir.
  const engine = await loadEngine();
  const shShell = await probeShell(
    effectiveSpeckit({ targets, speckit: { script: 'sh' } }, engine),
    ctx.exec,
    ctx.root,
  );
  prompts.note(
    shShell.ok
      ? `sh se ejecutará con: ${shShell.command}`
      : 'no se encontró un shell que ejecute sh; el preflight de Spec Kit fallará si eliges sh',
  );
  const script = await prompts.select(
    '¿Script para Spec Kit?',
    [
      { value: 'sh', label: 'sh', hint: 'bash / git-bash' },
      { value: 'ps', label: 'ps', hint: 'PowerShell' },
    ],
    engine.speckit.script,
  );
  if (script !== 'sh' && script !== 'ps') {
    return null;
  }

  return { targets, preset, profile, excludes, script, idea: null };
}

/** Resultado del paso entorno (D8): el preflight de hoy, más el sondeo para el plan. */
export interface EnvironmentCheck {
  ok: boolean;
  environment: SpeckitEnvironment | { skipped: string };
  /** Problemas del preflight cuando falla; vacíos cuando pasa. */
  problems: string[];
}

/**
 * Paso 5 (D12): verificación de herramientas (D7) + entorno de Spec Kit (D8).
 * Herramienta faltante: aviso con instalación y login, nunca bloquea, nunca pide una
 * key. Preflight: fail-closed igual que hoy — si falla, no se permite continuar.
 */
export async function verifyEnvironment(
  answers: AssistantAnswers,
  prompts: AssistantPrompts,
  ctx: CliContext,
  installed: string[],
): Promise<EnvironmentCheck> {
  for (const tool of answers.targets) {
    const hints = TOOL_HINTS[tool];
    if (installed.includes(tool)) {
      prompts.note(`${TOOL_LABELS[tool]} detectado; recordatorio de login: ${hints.loginHint}`);
    } else {
      prompts.note(
        `${TOOL_LABELS[tool]} no está instalado; los destinos son opcionales y puedes continuar. ` +
          `Instala: ${hints.installHint}. Login (cuando lo tengas): ${hints.loginHint}. ` +
          'El arnés no pide ni guarda credenciales: las tuyas viven en la herramienta.',
      );
    }
  }
  const engine = await loadEngine();
  const settings = effectiveSpeckit(
    { targets: answers.targets, speckit: { script: answers.script ?? undefined } },
    engine,
  );
  if (!settings.managed) {
    return { ok: true, environment: { skipped: 'Spec Kit no gestionado' }, problems: [] };
  }
  const environment = await probeEnvironment(settings, ctx.exec, ctx.root);
  prompts.note(
    `Entorno Spec Kit: uvx ${environment.uvx} · caché ${environment.cached}` +
      ` · shell ${environment.shell}${environment.version !== null ? ` · specify-cli ${environment.version}` : ''}`,
  );
  const preflight = await speckitPreflight(settings, ctx.exec, ctx.root, 'init');
  if (!preflight.ok) {
    for (const problem of preflight.problems) {
      prompts.note(`preflight: ${problem}`);
    }
    return { ok: false, environment, problems: preflight.problems };
  }
  return { ok: true, environment, problems: [] };
}

/** Fecha del registro de la semilla (YYYY-MM-DD). */
function seedDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Escritor de la semilla (design D6/D9/D10): `backlog/seed.md` con la idea textual,
 * la fecha y el apuntador, más `backlog/pre-prompt.md` con la plantilla bilingüe del
 * motor. Se llama sólo tras la confirmación y un apply exitoso; la semilla es un
 * activo versionable del proyecto, no estado del arnés (fuera del plan, del lock y
 * de `sync`). El CLI no ejecuta el pre-prompt ni llama a ningún modelo (R4).
 */
export async function writeBacklogSeed(ctx: CliContext, idea: string): Promise<void> {
  const dir = path.join(ctx.root, 'backlog');
  await fs.mkdir(dir, { recursive: true });
  const seed =
    `# Semilla del proyecto\n\n` +
    `> Registrada por \`ai-hub init\` el ${seedDate()}. La idea es textual: el arnés no\n` +
    `> añade requisitos. Siguiente paso: abre \`backlog/pre-prompt.md\` en tu agente.\n\n` +
    `## Idea\n\n${idea}\n`;
  await fs.writeFile(path.join(dir, 'seed.md'), seed, 'utf8');
  await fs.writeFile(path.join(dir, 'pre-prompt.md'), PRE_PROMPT, 'utf8');
}

/**
 * Colector del asistente. Recibe los prompts por `ctx` (tests) o carga el adaptador
 * clack en diferido, sólo tras el gate (design D1/D3). Cancelación (R5): cualquier
 * prompt que retorna `null` termina con "init cancelado" antes de escribir un byte.
 */
export async function runAssistantInit(ctx: CliContext): Promise<number> {
  const prompts = ctx.assistantPrompts ?? (await import('./assistant-clack.js')).clackPrompts;
  prompts.intro('ai-hub init — asistente de instalación');
  const installed = await detectTools(ctx);
  const answers = await collectAnswers(prompts, ctx, installed);
  if (answers === null) {
    ctx.io.out('init cancelado; no se escribió nada');
    return 0;
  }
  // Paso 5: herramientas (informativo, D7) + preflight de Spec Kit (fail-closed, D8).
  const environment = await verifyEnvironment(answers, prompts, ctx, installed);
  if (!environment.ok) {
    ctx.io.err('preflight de Spec Kit fallido; no se escribió nada');
    return 2;
  }
  // Paso 6 (D12): idea opcional (D6). No es flag: alimenta la semilla tras confirmar;
  // vacío = saltar (sin backlog); null = cancelación (R5).
  const ideaReply = await prompts.text(
    '¿Cuál es la idea del proyecto? Una frase basta (vacío = saltar)',
  );
  if (ideaReply === null) {
    ctx.io.out('init cancelado; no se escribió nada');
    return 0;
  }
  const resolved: AssistantAnswers = { ...answers, idea: ideaReply === '' ? null : ideaReply };
  // Paso 7 (D12): el mismo JSON de `--dry-run` (plan + entorno real del paso 5) y
  // confirmación. Al confirmar, aplica por el mismo camino que `--yes` con los flags
  // resueltos (cmdInit recursivo: con `yes` el gate se apaga solo); al cancelar,
  // retorna antes de cualquier escritura (R5).
  const resolvedArgs = answersToFlags(resolved);
  let prepared: PreparedInit;
  try {
    prepared = await prepareInit(resolvedArgs, ctx);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 2;
  }
  printInitPlan(prepared, ctx, environment.environment);
  const confirmed = await prompts.confirm('¿Aplicamos este plan?');
  if (confirmed !== true) {
    ctx.io.out('init cancelado; no se escribió nada');
    return 0;
  }
  const code = await cmdInit(resolvedArgs, ctx);
  // La semilla se escribe sólo tras un apply exitoso (D5/D6): activo del proyecto,
  // nunca estado del plan.
  if (code === 0 && resolved.idea !== null) {
    await writeBacklogSeed(ctx, resolved.idea);
    ctx.io.out('backlog: seed.md + pre-prompt.md escritos; ejecuta el pre-prompt en tu agente');
  }
  return code;
}
