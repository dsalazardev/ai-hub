/**
 * Comparación mínima de versiones `x.y.z` para validar el rango soportado de Spec Kit.
 * Una versión con sufijo (por ejemplo `1.2.1.dev0`) no se considera estable y no satisface ningún rango.
 */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

/** Extremos declarados de un rango: `>=1.2.3 <1.3.0` → `{ min: '1.2.3', max: '1.3.0' }`. */
export interface RangeBounds {
  min: string;
  max: string;
}

const RANGE_COMPARATOR = /^(>=|>|<=|<)\s*(\d+\.\d+\.\d+)$/;

/**
 * Deriva los extremos de un rango soportado. Exige un mínimo (`>=` o `>`) y un máximo
 * (`<` o `<=`) estables; devuelve null si el rango está malformado o incompleto.
 */
export function rangeBounds(range: string): RangeBounds | null {
  const parts = range.trim().split(/\s+/).filter((item) => item !== '');
  let min: string | null = null;
  let max: string | null = null;
  for (const part of parts) {
    const match = RANGE_COMPARATOR.exec(part);
    if (match === null) {
      return null;
    }
    if (match[1] === '>=' || match[1] === '>') {
      if (min !== null) {
        return null;
      }
      min = match[2];
    } else {
      if (max !== null) {
        return null;
      }
      max = match[2];
    }
  }
  return min === null || max === null ? null : { min, max };
}

/** Igual que `rangeBounds`, pero lanza con un mensaje claro cuando el rango está malformado. */
export function requireRangeBounds(range: string): RangeBounds {
  const bounds = rangeBounds(range);
  if (bounds === null) {
    throw new Error(`rango de versiones malformado: "${range}" (se esperaba ">=x.y.z <a.b.c")`);
  }
  return bounds;
}

/** Rango en la notación de uvx/pip: `>=1.2.3 <1.3.0` → `>=1.2.3,<1.3.0`. */
export function uvxRange(range: string): string {
  requireRangeBounds(range);
  return range.trim().split(/\s+/).join(',');
}

/** Extrae la versión estable del stdout de `specify --version` (`specify 1.2.5`). */
export function parseSpecifyVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  return match === null ? null : match[1];
}

/** Evalúa un rango de comparadores separados por espacios: `>=1.2.3 <1.3.0`. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) {
    return false;
  }
  const comparators = range.trim().split(/\s+/).filter((item) => item !== '');
  if (comparators.length === 0) {
    return false;
  }
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
    if (match === null) {
      return false;
    }
    const bound = parseVersion(match[2]);
    if (bound === null) {
      return false;
    }
    const order = compareVersions(parsed, bound);
    switch (match[1] ?? '=') {
      case '>=':
        return order >= 0;
      case '<=':
        return order <= 0;
      case '>':
        return order > 0;
      case '<':
        return order < 0;
      default:
        return order === 0;
    }
  });
}
