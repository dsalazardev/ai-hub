import type { EngineManifest } from '../engine/engine.js';

/**
 * Contrato de cierre (factory-evolution A1, M-05): la última línea no vacía de la respuesta final
 * de todo rol es `AI-HUB-STATUS: <STATE> | artifact=<ruta|-> | reason=<código>[: <frase>]`. El
 * contrato se deriva de `engine.yaml` (estados de `exit_effects` + veredictos del panel); la regla
 * `ai-hub-speckit` lo proyecta y `hermes-control`/`control tick` lo leen sin interpretar prosa.
 */
export interface StatusContract {
  prefix: string;
  /** Estados admitidos, en el orden de `exit_effects` seguido de los veredictos del panel. */
  states: string[];
  reasonRequired: string[];
  reasonMax: number;
  /** Segmentos opcionales en su orden (R-049, R-107): nombre y patrón del valor. */
  segments: Array<{ name: 'run' | 'delegated'; pattern: RegExp }>;
}

export interface StatusLine {
  /** Run id de una ejecución orquestada (`run=`), o `null`. */
  runId?: string | null;
  /** Razón de delegación (`delegated=`), o `null`. */
  delegated?: string | null;
  state: string;
  /** Ruta relativa a la raíz del repositorio, o `null` con `artifact=-`. */
  artifact: string | null;
  /** Código del motivo (`[a-z][a-z0-9_]*`), o `null` con `reason=-`. */
  reasonCode: string | null;
  /** Frase opcional tras el código; nunca contenido de archivos ni secretos. */
  reasonText: string | null;
}

export class StatusLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusLineError';
  }
}

export function statusContract(engine: EngineManifest): StatusContract {
  return {
    prefix: engine.status_line.prefix,
    states: [...Object.keys(engine.exit_effects), ...engine.status_line.panel],
    reasonRequired: [...engine.status_line.reason_required],
    reasonMax: engine.status_line.reason_max,
    segments: engine.status_line.segments.map((segment) => ({ name: segment.name, pattern: new RegExp(segment.pattern) })),
  };
}

const LINE = /^([A-Z-]+): ([A-Z][A-Z_-]*) \| artifact=(\S+)((?: \| [a-z]+=[^|]+?)*) \| reason=(-|[a-z][a-z0-9_]{0,39})(?:: (.+))?$/;
const ARTIFACT = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/<>-]+$/;

/** Analiza una línea de estado; lanza `StatusLineError` si no cumple el contrato. */
export function parseStatusLine(line: string, contract: StatusContract): StatusLine {
  const match = LINE.exec(line.trim());
  if (!match || match[1] !== contract.prefix) {
    throw new StatusLineError(`no es una línea ${contract.prefix} válida`);
  }
  const [, , state, artifact, middle, reason, text] = match;
  // Segmentos opcionales: conocidos, como máximo una vez, en el orden del motor y con su patrón.
  const values: Partial<Record<'run' | 'delegated', string>> = {};
  let position = -1;
  for (const part of middle.split(' | ').filter(Boolean)) {
    const separator = part.indexOf('=');
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    const index = contract.segments.findIndex((segment) => segment.name === name);
    if (index === -1) {
      throw new StatusLineError(`segmento desconocido: ${name}`);
    }
    if (index <= position) {
      throw new StatusLineError(`segmento ${name} repetido o fuera de orden (orden: ${contract.segments.map((segment) => segment.name).join(', ')})`);
    }
    if (!contract.segments[index].pattern.test(value)) {
      throw new StatusLineError(`segmento ${name} con un valor inválido`);
    }
    position = index;
    values[contract.segments[index].name] = value;
  }
  // La frase llega hasta el final de la línea: no puede esconder un segmento detrás del motivo.
  if (text !== undefined && contract.segments.some((segment) => text.includes(` | ${segment.name}=`))) {
    throw new StatusLineError('la frase del motivo contiene un marcador de segmento; los segmentos van antes de reason');
  }
  if (!contract.states.includes(state)) {
    throw new StatusLineError(`estado fuera del contrato: ${state}`);
  }
  if (artifact !== '-' && !ARTIFACT.test(artifact)) {
    throw new StatusLineError('artifact debe ser una ruta relativa a la raíz sin ".." o "-"');
  }
  if (reason === '-' && contract.reasonRequired.includes(state)) {
    throw new StatusLineError(`${state} exige reason=<código>`);
  }
  if (text !== undefined && text.length > contract.reasonMax) {
    throw new StatusLineError(`la frase del motivo supera ${contract.reasonMax} caracteres`);
  }
  return {
    state,
    artifact: artifact === '-' ? null : artifact,
    // Solo presentes cuando la línea los trae: una línea vigente sin segmentos conserva su forma.
    ...(values.run !== undefined ? { runId: values.run } : {}),
    ...(values.delegated !== undefined ? { delegated: values.delegated } : {}),
    reasonCode: reason === '-' ? null : reason,
    reasonText: text ?? null,
  };
}

/** Última línea no vacía de un texto, analizada; `null` si no cumple el contrato. */
export function lastStatusLine(text: string, contract: StatusContract): StatusLine | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) {
    return null;
  }
  try {
    return parseStatusLine(last, contract);
  } catch {
    return null;
  }
}

export function formatStatusLine(status: StatusLine, contract: StatusContract): string {
  const reason = status.reasonCode === null ? '-' : status.reasonCode;
  const text = status.reasonText === null ? '' : `: ${status.reasonText}`;
  const values: Record<'run' | 'delegated', string | null | undefined> = { run: status.runId, delegated: status.delegated };
  const segments = contract.segments
    .filter((segment) => values[segment.name] !== null && values[segment.name] !== undefined)
    .map((segment) => ` | ${segment.name}=${values[segment.name]}`)
    .join('');
  return `${contract.prefix}: ${status.state} | artifact=${status.artifact ?? '-'}${segments} | reason=${reason}${text}`;
}

/** Sección "Contrato de cierre" de la regla `ai-hub-speckit`, generada desde el motor. */
export function closingContractSection(engine: EngineManifest): string[] {
  const contract = statusContract(engine);
  return [
    '## Contrato de cierre',
    '',
    'La última línea no vacía de tu respuesta final es siempre una línea de estado:',
    '',
    '```text',
    `${contract.prefix}: <STATE> | artifact=<ruta relativa a la raíz o -> [| run=<run-id>] [| delegated=<razón>] | reason=<código>[: <frase de ${contract.reasonMax} caracteres como máximo>]`,
    '```',
    '',
    `Segmentos opcionales, como máximo una vez cada uno y en este orden, siempre antes de \`reason\`: ${contract.segments.map((segment) => `\`${segment.name}\``).join(', ')}.`,
    '`run` es el id de la ejecución orquestada que te lanzó (el mismo patrón que la telemetría de runs: `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`); fuera de un runner, omítelo.',
    `\`delegated\` lo escribe solo un rol delegado y nombra la razón: ${engine.delegation.reasons.map((reason) => `\`${reason.id}\``).join(', ')}.`,
    'La frase del motivo llega hasta el final de la línea y no puede contener ` | run=` ni ` | delegated=`; cualquier otra barra vertical es texto.',
    '',
    `Estados admitidos: ${contract.states.map((state) => `\`${state}\``).join(', ')}.`,
    `\`reason\` es obligatorio con ${contract.reasonRequired.map((state) => `\`${state}\``).join(', ')}; el código es \`[a-z][a-z0-9_]*\`.`,
    'Nunca pongas en la línea contenido de archivos, prompts, tokens ni variables de entorno.',
    `El bucle \`converge\` admite como máximo ${engine.loop.converge.max_rounds} rondas \`NEEDS_WORK\` (el proyecto solo puede bajarlo con \`policy.maxRounds\`); agotadas, el estado es \`${engine.loop.converge.on_exhaust}\` con \`reason=max_rounds\`.`,
    'Si en un comando de assessment tu clasificación es dudosa, no adivines: termina en `NEEDS_CLARIFICATION` con `reason=low_confidence`.',
    '',
    ...delegationSection(engine),
  ];
}

/** Política de delegación (R-054, R-055) proyectada desde `engine.yaml` › `delegation`. */
export function delegationSection(engine: EngineManifest): string[] {
  return [
    '## Delegación',
    '',
    `Por defecto trabajas ${engine.delegation.default === 'inline' ? 'inline' : engine.delegation.default}: solo delegas con una de estas razones y su umbral de partida.`,
    '',
    '| Razón | Umbral de partida |',
    '|---|---|',
    ...engine.delegation.reasons.map((reason) => `| \`${reason.id}\` | ${reason.threshold} |`),
    '',
    'El número de archivos, el tamaño de la tarea o el precio del modelo no deciden por sí solos. Delegar no añade estados ni cambia `exit_effects`.',
    'El verificador independiente recibe un contexto nuevo y la evidencia del candidato, nunca la defensa del autor; usa un modelo distinto cuando `agentModels` lo permite y, con un solo modelo, anota la diversidad reducida.',
    `Si el riesgo exige diversidad y no la hay, cierra \`BLOCKED\` con \`reason=${engine.delegation.verifier.diversity_unavailable_reason}\` y escala a una persona: nada se aprueba solo.`,
  ];
}
