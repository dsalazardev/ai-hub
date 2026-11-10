/** Entrada de un paquete en la salida de `npm pack --dry-run --json`. */
export interface PackEntry {
  name?: string;
  files: Array<{ path: string }>;
  entryCount: number;
}

function isEntry(value: unknown): value is PackEntry {
  return typeof value === 'object' && value !== null && Array.isArray((value as PackEntry).files);
}

/**
 * ci-verde D4: devuelve la entrada del paquete `name` en la salida de `npm pack --dry-run --json`, sea cual sea la
 * forma de la versión de npm:
 * - npm 10 (Node 22, el del CI): un array de entradas con `name`;
 * - npm ≥ 11: un objeto indexado por el nombre del paquete.
 * Un objeto vacío, un array sin el paquete o un elemento sin `name` (sin prueba de que sea este paquete) fallan con
 * un mensaje que nombra el paquete; nunca se devuelve `undefined`.
 */
export function packEntry(data: unknown, name: string): PackEntry {
  let found: unknown;
  if (Array.isArray(data)) {
    found = data.find((entry) => isEntry(entry) && entry.name === name);
  } else if (typeof data === 'object' && data !== null) {
    found = (data as Record<string, unknown>)[name];
  }
  if (!isEntry(found)) {
    throw new Error(`npm pack --dry-run --json no trae ninguna entrada para ${name}`);
  }
  return found;
}
