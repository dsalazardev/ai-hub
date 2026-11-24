import { TARGETS } from './targets.js';

/**
 * Gate de escritores (R-042): falla cuando un módulo escribe, añade o renombra sobre un destino declarado sin
 * ser su escritor declarado (que es quien aplica la política de su declaración).
 *
 * Límites, declarados: el análisis es por línea. Detecta una llamada de escritura (`writeFile`, `appendFile`,
 * `rename`, `copyFile`, sus variantes `Sync`) en la misma línea que un literal o una constante conocida del
 * destino. No sigue rutas construidas lejos de la llamada (variables pasadas entre funciones o módulos), ni
 * escrituras por procesos hijos. Cubre solo los destinos declarados y la telemetría.
 */

const WRITE_CALL = /\b(?:fs\.|fsp\.)?(?:writeFile|appendFile|rename|copyFile|writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\(/;

/** Señales de cada destino en el código: literales y constantes que lo nombran. */
const SIGNALS: Record<string, readonly string[]> = {
  'sync-lock': ["'sync.lock.json'", 'LOCK_PATH'],
  'root-gitignore': ["'.gitignore'"],
  'claude-settings': ["'settings.json'", 'spec.hookPath'],
  'decision-ledger': ["'decisions.jsonl'", 'DECISIONS_FILE'],
  'run-telemetry': ["'events.jsonl'", 'eventsFile('],
  'poll-health': ["'health.json'", 'HEALTH_FILE'],
  manifest: ["'manifest.yaml'", 'MANIFEST'],
  'harness-env': ["'.env'", 'HARNESS_ENV_FILE', 'envFile'],
};

export interface GateViolation {
  module: string;
  line: number;
  target: string;
}

export function scanWriters(files: ReadonlyArray<{ module: string; text: string }>): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const { module, text } of files) {
    text.split('\n').forEach((source, index) => {
      if (!WRITE_CALL.test(source)) {
        return;
      }
      for (const [id, signals] of Object.entries(SIGNALS)) {
        if (!signals.some((signal) => source.includes(signal))) {
          continue;
        }
        const declared = TARGETS.find((target) => target.id === id);
        const allowed = declared?.writers ?? [];
        if (!allowed.includes(module)) {
          violations.push({ module, line: index + 1, target: id });
        }
      }
    });
  }
  return violations;
}
