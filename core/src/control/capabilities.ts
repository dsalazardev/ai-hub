/**
 * Capacidades condicionales de los adaptadores de tracker (R-017, D-48, D-61): se declaran por
 * producto y rango de versiones, cada una con su evidencia citada. Una versión desconocida o fuera de
 * rango no tiene la capacidad. Cada adaptador depende solo de su propio experimento: el resultado de
 * uno no habilita ni bloquea al otro.
 */

export type TrackerProduct = 'gitlab' | 'github';
export type TrackerCapability = 'conditional_label_update' | 'conditional_branch_delete';

export interface CapabilityDeclaration {
  product: TrackerProduct;
  capability: TrackerCapability;
  available: boolean;
  /** Rango cerrado de versiones `[min, max]` en el que vale la evidencia; `null` = ninguna versión. */
  versions: { min: string; max: string } | null;
  /** Cita obligatoria: archivo y sección de la evidencia (documental o experimento del hito 2). */
  evidence: string;
}

export class CapabilityDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityDeclarationError';
  }
}

/** Estado actual: ningún adaptador declara capacidades condicionales sin un experimento con éxito. */
export const CAPABILITY_DECLARATIONS: readonly CapabilityDeclaration[] = [
  {
    product: 'gitlab',
    capability: 'conditional_label_update',
    available: false,
    versions: null,
    evidence: '.planning/findings.md › 1.1 y 1.12: sin precondición documentada en PUT /projects/:id/issues/:iid; pendiente de 2.1',
  },
  {
    product: 'github',
    capability: 'conditional_label_update',
    available: false,
    versions: null,
    evidence: '.planning/findings.md › 1.2 y 1.12: «Conditional requests for unsafe methods … are not supported»; 2.2 solo confirmaría la ausencia',
  },
  {
    product: 'gitlab',
    capability: 'conditional_branch_delete',
    available: false,
    versions: null,
    evidence: '.planning/findings.md › 1.15 y 1.12: lease en el cliente git; servidor sin verificar; pendiente de 2.9',
  },
  {
    product: 'github',
    capability: 'conditional_branch_delete',
    available: false,
    versions: null,
    evidence: '.planning/findings.md › 1.15 y 1.12: lease en el cliente git; servidor sin verificar; pendiente de 2.10',
  },
];

const VERSION = /^\d+(?:\.\d+){0,3}$/;

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10));
  const right = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Una declaración disponible sin evidencia citada o sin rango de versiones es inválida. */
export function validateDeclarations(declarations: readonly CapabilityDeclaration[]): void {
  for (const declaration of declarations) {
    const name = `${declaration.product}/${declaration.capability}`;
    if (declaration.evidence.trim().length < 10) {
      throw new CapabilityDeclarationError(`${name}: la declaración necesita una cita de evidencia`);
    }
    if (declaration.available) {
      if (declaration.versions === null || !VERSION.test(declaration.versions.min) || !VERSION.test(declaration.versions.max)) {
        throw new CapabilityDeclarationError(`${name}: una capacidad disponible necesita un rango de versiones verificado`);
      }
      if (compareVersions(declaration.versions.min, declaration.versions.max) > 0) {
        throw new CapabilityDeclarationError(`${name}: rango de versiones invertido`);
      }
    }
  }
}

export type CapabilityResult =
  | { available: true; evidence: string }
  | { available: false; reason: 'capability_unverified' | 'version_unknown' | 'version_unsupported'; evidence: string };

export function trackerCapability(
  product: TrackerProduct,
  capability: TrackerCapability,
  version: string | null,
  declarations: readonly CapabilityDeclaration[] = CAPABILITY_DECLARATIONS,
): CapabilityResult {
  validateDeclarations(declarations);
  const declaration = declarations.find((item) => item.product === product && item.capability === capability);
  if (!declaration || !declaration.available || declaration.versions === null) {
    return { available: false, reason: 'capability_unverified', evidence: declaration?.evidence ?? 'sin declaración' };
  }
  if (version === null || !VERSION.test(version)) {
    return { available: false, reason: 'version_unknown', evidence: declaration.evidence };
  }
  const { min, max } = declaration.versions;
  if (compareVersions(version, min) < 0 || compareVersions(version, max) > 0) {
    return { available: false, reason: 'version_unsupported', evidence: declaration.evidence };
  }
  return { available: true, evidence: declaration.evidence };
}
