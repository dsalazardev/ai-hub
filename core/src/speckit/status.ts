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
}

export interface StatusLine {
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
  };
}

const LINE = /^([A-Z-]+): ([A-Z][A-Z_-]*) \| artifact=(\S+) \| reason=(-|[a-z][a-z0-9_]{0,39})(?:: (.+))?$/;
const ARTIFACT = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/<>-]+$/;

/** Analiza una línea de estado; lanza `StatusLineError` si no cumple el contrato. */
export function parseStatusLine(line: string, contract: StatusContract): StatusLine {
  const match = LINE.exec(line.trim());
  if (!match || match[1] !== contract.prefix) {
    throw new StatusLineError(`no es una línea ${contract.prefix} válida`);
  }
  const [, , state, artifact, reason, text] = match;
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
  return `${contract.prefix}: ${status.state} | artifact=${status.artifact ?? '-'} | reason=${reason}${text}`;
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
    `${contract.prefix}: <STATE> | artifact=<ruta relativa a la raíz o -> | reason=<código>[: <frase de ${contract.reasonMax} caracteres como máximo>]`,
    '```',
    '',
    `Estados admitidos: ${contract.states.map((state) => `\`${state}\``).join(', ')}.`,
    `\`reason\` es obligatorio con ${contract.reasonRequired.map((state) => `\`${state}\``).join(', ')}; el código es \`[a-z][a-z0-9_]*\`.`,
    'Nunca pongas en la línea contenido de archivos, prompts, tokens ni variables de entorno.',
    `El bucle \`converge\` admite como máximo ${engine.loop.converge.max_rounds} rondas \`NEEDS_WORK\` (el proyecto solo puede bajarlo con \`policy.maxRounds\`); agotadas, el estado es \`${engine.loop.converge.on_exhaust}\` con \`reason=max_rounds\`.`,
    'Si en un comando de assessment tu clasificación es dudosa, no adivines: termina en `NEEDS_CLARIFICATION` con `reason=low_confidence`.',
  ];
}
