import { findTarget, TARGETS, type TargetDeclaration } from './targets.js';
import { transactWrite, type TransactionHooks } from './transaction.js';

/**
 * Reemplazo de un archivo propio del motor por la transacción X2 (3.11): lock, temporal sincronizado, última
 * comprobación y rename, sin copia adyacente (retención 0: el contenido es regenerable o lo cubren los snapshots).
 * `expected`, si se da, es lo que el escritor leyó al decidir: si otro escritor lo cambió, no se reemplaza.
 * Nunca se usa sobre configuración ajena existente (D-65): para eso hay creación exclusiva o propuesta.
 */
export async function replaceOwned(input: {
  root: string;
  file: string;
  module: string;
  content: string;
  target?: TargetDeclaration;
  expected?: string | null;
  hooks?: TransactionHooks;
}): Promise<'written' | 'unchanged'> {
  const result = await transactWrite({
    root: input.root,
    file: input.file,
    module: input.module,
    capture: false,
    retention: 0,
    ...(input.target ? { target: input.target } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
    transform: (current) => {
      if (input.expected !== undefined && current !== input.expected) {
        throw new Error(`${input.file} cambió mientras se preparaba la escritura; no se reemplaza`);
      }
      return input.content;
    },
  });
  if (result.status === 'stopped') {
    throw new Error(`${input.file}: escritura detenida (${result.reason}): ${result.detail}`);
  }
  return result.status;
}

/** Declaración de un destino generado por `sync`: la específica si existe; si no, la de los destinos del lock. */
export function generatedTarget(relative: string): TargetDeclaration {
  return findTarget(relative) ?? TARGETS.find((target) => target.id === 'generated-targets')!;
}
