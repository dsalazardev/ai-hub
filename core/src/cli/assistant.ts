import { contextHost, runControlStep } from '../control/onboard-step.js';
import { connectionSaved } from '../control/onboard.js';
import { ENROLL_ACTION, RETAKE_ACTION, RETAKE_PROVIDE, isolate, type IntegrationReport } from './integrations.js';
import type { ParsedArgs } from './types.js';
import type { CliContext } from './types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TARGETS, TOOL_HINTS, TOOL_IDS, isToolId, type ToolId } from '../sync/targets.js';
import { detectPreset } from '../presets/detect.js';
import { loadEngine, type SpeckitScript } from '../engine/engine.js';
import { DEFAULT_SPECKIT_SCRIPTS, effectiveSpeckit } from '../speckit/settings.js';
import { probeEnvironment, probeShell, speckitPreflight, type SpeckitEnvironment } from '../speckit/commands.js';
// Ciclo intencional con onboarding.ts (D2): ambos módulos se usan sólo a nivel de
// función, nunca a nivel de módulo, así que los live bindings de ESM lo resuelven.
import { cliVersion, cmdInit, destinationLine, prepareInit, printInitPlan, type PreparedInit } from './onboarding.js';
import { PRE_PROMPT, PRE_PROMPT_HISTORY } from './preprompt.js';
import {
  IdeaInputError,
  extractFencedIdea,
  fenceIdea,
  isBlankIdea,
  maxIdeaBytes,
  normalizeIdea,
  type IdeaOutcome,
} from './idea.js';
import { refreshTemplateFile } from '../presets/materialize.js';
import { HARNESS_ENV_FILE, formatDotenv } from '../env/dotenv.js';

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
  intro(title: string, version: string): void;
  note(message: string): void;
  multiselect(message: string, options: PromptOption[], initial: string[]): Promise<string[] | null>;
  select(message: string, options: PromptOption[], initial?: string): Promise<string | null>;
  text(message: string): Promise<string | null>;
  confirm(message: string): Promise<boolean | null>;
  /**
   * Entrada enmascarada (PD-1). Opcional: sin ella el asistente no ofrece el paso del tracker,
   * porque un token jamás se pide por un prompt que lo muestre en claro.
   */
  password?(message: string): Promise<string | null>;
  /**
   * idea-input (D1): entrada multilínea de la idea, con bracketed paste, render acotado y drenado. Opcional: sin
   * ella el paso 6 usa `text` (los prompts inyectados de los tests). `null` = cancelación.
   */
  longText?(message: string, options: { maxBytes: number; root: string }): Promise<IdeaOutcome | null>;
}

/** Decisiones que hoy son flags de init; la idea es la única que no lo es (design D6). */
export interface AssistantAnswers {
  targets: ToolId[];
  /** `null`: usar el preset detectado (sin flag `--preset`). */
  preset: string | null;
  profile: 'full' | 'preset-only' | 'custom';
  excludes: string[];
  /** Conjunto de scripts elegido (mínimo uno); el orden es el de la selección (design D7). */
  scripts: SpeckitScript[];
  /** Activo: el único del conjunto, o el elegido cuando selecciona más de uno; siempre se emite. */
  script: SpeckitScript;
  /** Idea del proyecto; `null` = paso saltado (no se escribe `backlog/`). */
  idea: string | null;
  /** init-fiabilidad (DEV-02): raíz elegida ante un ancestro instalado; se emite como `--dir`. */
  dir?: string;
}

function isSpeckitScript(value: string): value is SpeckitScript {
  return value === 'sh' || value === 'ps' || value === 'py';
}

/**
 * R1: el asistente es una generadora de flags. `answersToFlags` reproduce exactamente
 * las estructuras que `parseArgs` produce para el argv equivalente; el plan lo construye
 * el mismo constructor compartido de `cmdInit`, así que el hash es idéntico por construcción.
 * El activo se emite siempre (design D7); el conjunto sólo cuando difiere de los tres
 * como conjunto — así la preselección completa produce el mismo hash que el camino bare.
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
  flags.script = answers.script;
  if (answers.dir !== undefined) {
    flags.dir = answers.dir;
  }
  const isDefaultSet =
    answers.scripts.length === DEFAULT_SPECKIT_SCRIPTS.length &&
    DEFAULT_SPECKIT_SCRIPTS.every((script) => answers.scripts.includes(script));
  if (!isDefaultSet) {
    flags.scripts = answers.scripts.join(',');
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

  // Paso 4 (design D7): conjunto de scripts con multiselect (mínimo uno; cero re-pregunta)
  // y activo con select sólo cuando elige más de uno. La nota informa el shell resuelto
  // para sh y el intérprete de py antes de elegir el activo.
  const engine = await loadEngine();
  const scriptOptions: PromptOption[] = [
    { value: 'py', label: 'Python', hint: 'python · python3 · py' },
    { value: 'sh', label: 'Shell', hint: 'bash · git-bash' },
    { value: 'ps', label: 'PowerShell', hint: 'pwsh · powershell' },
  ];
  let scripts: SpeckitScript[] | null = null;
  while (scripts === null) {
    const reply = await prompts.multiselect(
      '¿Qué tipos de script instala Spec Kit?',
      scriptOptions,
      ['py', 'sh', 'ps'],
    );
    if (reply === null) {
      return null;
    }
    const chosen = reply.filter(isSpeckitScript);
    if (chosen.length === 0) {
      prompts.note('Elige al menos un tipo de script; cero no deja continuar');
      continue;
    }
    scripts = chosen;
  }
  if (scripts.includes('sh')) {
    const shShell = await probeShell(
      effectiveSpeckit({ targets, speckit: { script: 'sh' } }, engine),
      ctx.exec,
      ctx.root,
    );
    prompts.note(
      shShell.ok
        ? `sh se ejecutará con: ${shShell.command}`
        : 'no se encontró un shell que ejecute sh; el preflight de Spec Kit fallará si dejas sh como activo',
    );
  }
  if (scripts.includes('py')) {
    const pyProbe = await probeShell(
      effectiveSpeckit({ targets, speckit: { script: 'py' } }, engine),
      ctx.exec,
      ctx.root,
    );
    prompts.note(
      pyProbe.ok
        ? `py se ejecutará con: ${pyProbe.command}`
        : 'no se encontró un intérprete de Python; el preflight de Spec Kit fallará si dejas py como activo',
    );
  }
  let script: SpeckitScript;
  if (scripts.length === 1) {
    script = scripts[0];
  } else {
    const initial = scripts.includes(engine.speckit.script) ? engine.speckit.script : scripts[0];
    const chosen = await prompts.select(
      '¿Qué script deja activo Spec Kit?',
      scriptOptions.filter((option) => scripts.includes(option.value as SpeckitScript)),
      initial,
    );
    if (chosen === null || !isSpeckitScript(chosen) || !scripts.includes(chosen)) {
      return null;
    }
    script = chosen;
  }

  return { targets, preset, profile, excludes, scripts, script, idea: null };
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
    { targets: answers.targets, speckit: { script: answers.script, scripts: answers.scripts } },
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

/** Plantilla exacta con la que 0.7.0–0.13.0 escribían la semilla (idea cruda, sin fence). */
const SEED_013 =
  /^# Semilla del proyecto\n\n> Registrada por `ai-hub init` el \d{4}-\d{2}-\d{2}\. La idea es textual: el arnés no\n> añade requisitos\. Siguiente paso: abre `backlog\/pre-prompt\.md` en tu agente\.\n\n## Idea\n\n/;

/** Semilla nueva (design D6): la idea en un fence dinámico, con la fecha y la procedencia. */
export function renderSeed(idea: string, note: string, now: Date = new Date()): string {
  return (
    `# Semilla del proyecto\n\n` +
    `> Registrada por \`ai-hub init\` el ${seedDate(now)} desde ${note}. La idea es textual: el arnés no\n` +
    `> añade requisitos. Siguiente paso: abre \`backlog/pre-prompt.md\` en tu agente.\n\n` +
    `## Idea\n\n${fenceIdea(idea)}\n`
  );
}

export type SeedState = 'written' | 'unchanged' | 'migrated' | 'collision';

/**
 * Clasifica un `seed.md` existente frente a la idea nueva (D5): con fence → igual o colisión; plantilla exacta de
 * 0.13.0 → migra solo si su texto coincide con la idea; cualquier otra forma → colisión.
 */
export function classifySeed(existing: string, idea: string): Exclude<SeedState, 'written'> {
  const legacy = SEED_013.exec(existing);
  if (legacy !== null) {
    const raw = existing.slice(legacy[0].length);
    if (!raw.endsWith('\n') || /^`{3,}markdown$/m.test(raw)) {
      return 'collision';
    }
    return normalizeIdea(raw, 'backlog/seed.md') === idea ? 'migrated' : 'collision';
  }
  const section = existing.split('\n## Idea\n')[1];
  const fenced = section === undefined ? null : extractFencedIdea(section);
  return fenced !== null && fenced === idea ? 'unchanged' : 'collision';
}

const SEED_LINES: Record<SeedState, string> = {
  written: 'backlog: seed.md escrito',
  unchanged: 'backlog: seed.md sin cambios',
  migrated: 'backlog: seed.md migrado al formato con fence',
  collision: 'backlog: seed.md existe y difiere; no se sobrescribió',
};

const PRE_PROMPT_LINES = {
  written: 'backlog: pre-prompt.md escrito',
  kept: 'backlog: pre-prompt.md sin cambios',
  updated: 'backlog: pre-prompt.md actualizado a la plantilla nueva',
  collision: 'backlog: pre-prompt.md editado por el proyecto; no se sobrescribió',
} as const;

/**
 * Escritor de la semilla (design D5/D6/D13). `seed.md` es contenido de la persona: se escribe con fence si no
 * existe, nunca se sobrescribe y solo migra desde 0.13.0 si coincide. `pre-prompt.md` es plantilla del motor:
 * tres vías sobre `.ai-hub/.scaffold.json`. Se llama solo tras un apply exitoso; la semilla queda fuera del plan,
 * del lock y de `sync`. El CLI no ejecuta el pre-prompt ni llama a ningún modelo (R4). Devuelve las líneas a
 * imprimir, sin el texto de la idea.
 */
export async function writeBacklogSeed(
  ctx: CliContext,
  idea: string,
  note: string,
  now: Date = new Date(),
): Promise<string[]> {
  const dir = path.join(ctx.root, 'backlog');
  await fs.mkdir(dir, { recursive: true });
  const seedPath = path.join(dir, 'seed.md');
  const existing = await fs.readFile(seedPath, 'utf8').catch(() => null);
  let state: SeedState;
  if (existing === null) {
    state = 'written';
  } else {
    state = classifySeed(existing, idea);
  }
  if (state === 'written' || state === 'migrated') {
    await fs.writeFile(seedPath, renderSeed(idea, note, now), 'utf8');
  }
  const prePrompt = await refreshTemplateFile(
    ctx.root,
    'backlog/pre-prompt.md',
    PRE_PROMPT,
    'engine:backlog/pre-prompt.md',
    PRE_PROMPT_HISTORY,
  );
  const lines = [SEED_LINES[state], PRE_PROMPT_LINES[prePrompt]];
  if (state === 'written' || state === 'migrated') {
    lines.push('backlog: ejecuta backlog/pre-prompt.md en tu agente');
  }
  lines.push(await writeIdeaMd(ctx.root, idea, state, now));
  return lines;
}

export const IDEA_MD_LINES = {
  written: 'backlog: IDEA.md escrito (fuente: backlog/seed.md)',
  kept: 'backlog: IDEA.md ya existe; se conserva sin cambios',
  collision: 'backlog: IDEA.md no se escribe: backlog/seed.md contiene otra idea (colisión)',
} as const;

/** Contenido de `IDEA.md`: la idea textual en el mismo fence que el seed, la fecha y el enlace a la fuente. */
export function renderIdeaMd(idea: string, now: Date = new Date()): string {
  return `# Idea del proyecto\n\n> Registrada por \`ai-hub init\` el ${seedDate(now)}. Fuente: [backlog/seed.md](backlog/seed.md).\n\n${fenceIdea(idea)}\n`;
}

/**
 * init-fiabilidad (SEED-01, SEED-02): `IDEA.md` en la raíz, en el flujo base y sin Hermes. Solo si el seed se
 * escribió o ya tenía esta idea (nunca diverge del seed) y solo si no existe (nunca se sobrescribe). Escritura
 * exclusiva (`wx`): un fallo de escritura sube a `init`, que lo trata como fallo de la base (SEED-03).
 */
async function writeIdeaMd(root: string, idea: string, state: SeedState, now: Date): Promise<string> {
  const file = path.join(root, 'IDEA.md');
  if (await fs.access(file).then(() => true, () => false)) {
    return IDEA_MD_LINES.kept;
  }
  if (state === 'collision') {
    return IDEA_MD_LINES.collision;
  }
  await fs.writeFile(file, renderIdeaMd(idea, now), { encoding: 'utf8', flag: 'wx' });
  return IDEA_MD_LINES.written;
}

const IDEA_QUESTION = '¿Cuál es la idea del proyecto? Pégala o escríbela; puede ocupar varias líneas';

/**
 * Paso 6 (idea-input): entrada multilínea si el adaptador la tiene; si no, el `text` de siempre (prompts
 * inyectados). `null` = cancelación; `skip` = sin idea.
 */
async function askIdea(prompts: AssistantPrompts, ctx: CliContext, maxBytes: number): Promise<IdeaOutcome | null> {
  if (prompts.longText) {
    return prompts.longText(IDEA_QUESTION, { maxBytes, root: ctx.root });
  }
  const reply = await prompts.text('¿Cuál es la idea del proyecto? Una frase basta (vacío = saltar)');
  if (reply === null) {
    return null;
  }
  const text = normalizeIdea(reply, 'entrada');
  return isBlankIdea(text) ? { kind: 'skip', source: 'paste' } : { kind: 'idea', text, source: 'paste', note: 'pegado en el asistente' };
}

/**
 * Colector del asistente. Recibe los prompts por `ctx` (tests) o carga el adaptador
 * clack en diferido, sólo tras el gate (design D1/D3). Cancelación (R5): cualquier
 * prompt que retorna `null` termina con "init cancelado" antes de escribir un byte.
 */
/** init-fiabilidad (DEV-02): texto de la pregunta de raíz ante un ancestro con `manifest.yaml`. */
export function rootQuestion(cwd: string, ancestor: string): string {
  return `${cwd} no tiene instalación, pero el ancestro ${ancestor} tiene manifest.yaml. ¿Dónde instalar?`;
}

export async function runAssistantInit(
  initialCtx: CliContext,
  options: { ancestor?: { cwd: string; ancestor: string } } = {},
): Promise<number> {
  let ctx = initialCtx;
  const prompts = ctx.assistantPrompts ?? (await import('./assistant-clack.js')).clackPrompts;
  prompts.intro('ai-hub init — asistente de instalación', await cliVersion());
  // init-fiabilidad (DEV-02): un ancestro instalado nunca se adopta en silencio; la persona elige y la
  // elección viaja como `--dir` (cancelar no escribe nada).
  let dir: string | undefined;
  if (options.ancestor !== undefined) {
    const { cwd, ancestor } = options.ancestor;
    const chosen = await prompts.select(rootQuestion(cwd, ancestor), [
      { value: cwd, label: `${cwd} (este directorio, instalación nueva)` },
      { value: ancestor, label: `${ancestor} (la instalación del ancestro)` },
    ]);
    if (chosen === null) {
      ctx.io.out('init cancelado; no se escribió nada');
      return 0;
    }
    dir = chosen;
    ctx = { ...ctx, root: chosen };
  }
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
  // Paso 6 (D12, idea-input): idea opcional (D6). No es flag: alimenta la semilla tras confirmar;
  // vacío = saltar (sin backlog); null = cancelación (R5). Entrada multilínea con bracketed paste (D1).
  let maxBytes: number;
  try {
    maxBytes = maxIdeaBytes();
  } catch (error) {
    if (error instanceof IdeaInputError) {
      ctx.io.err(`${error.message}; no se escribió nada`);
      return 2;
    }
    throw error;
  }
  const ideaOutcome = await askIdea(prompts, ctx, maxBytes);
  if (ideaOutcome === null) {
    ctx.io.out('init cancelado; no se escribió nada');
    return 0;
  }
  const resolved: AssistantAnswers = {
    ...answers,
    idea: ideaOutcome.kind === 'idea' ? ideaOutcome.text : null,
    ...(dir !== undefined ? { dir } : {}),
  };
  const ideaNote = ideaOutcome.kind === 'idea' ? ideaOutcome.note : '';
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
  // init-fiabilidad (DEV-05): la ruta absoluta, en stderr, antes de la confirmación.
  ctx.io.err(destinationLine(ctx.root));
  const confirmed = await prompts.confirm('¿Aplicamos este plan?');
  if (confirmed !== true) {
    ctx.io.out('init cancelado; no se escribió nada');
    return 0;
  }
  // El apply va por el mismo camino que `--yes`; la semilla (D5/D6) y la verificación de la base las hace
  // cmdInit, y solo después corren los pasos opcionales (init-fiabilidad, DEV-06).
  return cmdInit(resolvedArgs, ctx, {
    idea: ideaOutcome,
    afterBase: async (applied) => {
      // init-fiabilidad (IO-01): cada integración corre aislada; su fallo es un estado, nunca un error de init.
      const reports: Array<IntegrationReport | null> = [];
      reports.push(await isolate('tracker', () => 'tracker-env', () => runTrackerStep(prompts, applied)));
      // control-onboarding: la última pregunta, solo con Hermes; vacío = saltar sin escribir nada.
      const NEXT: Record<string, string> = { profile: 'env', env: 'manifest', manifest: 'skill' };
      let stage = 'control';
      const staged: CliContext = {
        ...applied,
        onConnectStage: async (done) => {
          stage = NEXT[done] ?? stage;
          await applied.onConnectStage?.(done);
        },
      };
      const control = await isolate('control', () => stage, async () => (await runControlStep(prompts, staged, resolved.idea)).report);
      // HC-12: una excepción no prevista se informa con la acción que corresponde a lo persistido.
      if (control !== null && control.state === 'fallida' && control.action === null) {
        const saved = await connectionSaved(applied.root, contextHost(applied));
        control.action = saved ? ENROLL_ACTION : RETAKE_ACTION;
        if (!saved) {
          control.provide = RETAKE_PROVIDE;
        }
      }
      reports.push(control);
      return reports.filter((report): report is IntegrationReport => report !== null);
    },
  });
}

/**
 * Paso opt-in del tracker (PD-1, la última pregunta): solo el usuario en su terminal escribe su
 * token. Vacío o cancelación = saltar sin escribir nada. Escribe únicamente `.ai-hub/.env`
 * (ya ignorado por `init`), no toca el manifiesto, el plan ni ningún otro archivo, y jamás
 * imprime el valor. Un `.env` existente nunca se sobrescribe.
 */
export async function offerTrackerStep(prompts: AssistantPrompts, ctx: CliContext): Promise<boolean> {
  return (await runTrackerStep(prompts, ctx))?.state === 'completada';
}

const TRACKER_SKIPPED: IntegrationReport = { name: 'tracker', state: 'no-solicitada', stage: null, action: null };

/** El paso del tracker con su informe (init-fiabilidad, IO-02): `null` si no se ofreció (sin entrada enmascarada). */
export async function runTrackerStep(prompts: AssistantPrompts, ctx: CliContext): Promise<IntegrationReport | null> {
  if (!prompts.password) {
    return null;
  }
  const reply = await prompts.text(
    '¿Quieres configurar tu tracker de GitLab ahora? (opcional: escribe "s" para configurarlo; vacío = saltar)',
  );
  if (reply === null || !/^(s|si|sí|y|yes)$/i.test((reply ?? '').trim())) {
    ctx.io.out('tracker: paso saltado; puedes crear .ai-hub/.env desde .ai-hub/.env.example cuando quieras');
    return TRACKER_SKIPPED;
  }
  const envFile = path.join(ctx.root, HARNESS_ENV_FILE);
  if (await fs.access(envFile).then(() => true, () => false)) {
    ctx.io.out('tracker: .ai-hub/.env ya existe; edítalo a mano (no se sobrescribe)');
    return { name: 'tracker', state: 'pendiente', stage: 'tracker-env', action: 'ai-hub doctor --online', ready: ['.ai-hub/.env (existente)'] };
  }
  const url = await prompts.text('URL de tu GitLab (sin /api; vacío = saltar)');
  if (url === null || (url ?? '').trim() === '') {
    ctx.io.out('tracker: paso saltado; no se escribió nada');
    return TRACKER_SKIPPED;
  }
  const token = await prompts.password('Token personal de GitLab (scope api; no se mostrará)');
  if (token === null || (token ?? '').trim() === '') {
    ctx.io.out('tracker: paso saltado; no se escribió nada');
    return TRACKER_SKIPPED;
  }
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, formatDotenv({ GITLAB_URL: url.trim(), GITLAB_TOKEN: token.trim() }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  ctx.io.out(
    'tracker: .ai-hub/.env escrito (ignorado por git). Declara manifest.tracker {kind: gitlab, urlEnv: GITLAB_URL, tokenEnv: GITLAB_TOKEN} y comprueba con ai-hub doctor --online',
  );
  return { name: 'tracker', state: 'completada', stage: null, action: null };
}
