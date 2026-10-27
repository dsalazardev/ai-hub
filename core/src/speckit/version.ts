/**
 * Comparación mínima de versiones `x.y.z` para validar el pin de Spec Kit.
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
