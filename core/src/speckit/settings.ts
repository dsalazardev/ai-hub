import type { EngineManifest, SpeckitScript } from '../engine/engine.js';
import { TARGETS, isToolId, type ToolId } from '../sync/targets.js';
import { satisfiesRange } from './version.js';

/** Bloque `speckit` de manifest.yaml: solo restringe lo que fija el paquete. */
export interface ProjectSpeckit {
  managed?: boolean;
  version?: string;
  script?: SpeckitScript;
  defaultTarget?: string;
}

/** Campos que pertenecen al motor y que un proyecto no puede redefinir. */
export const ENGINE_OWNED_SPECKIT_FIELDS = ['extensions', 'excludeNewer', 'integrations', 'package', 'pin', 'supported'] as const;

export interface SpeckitSettings {
  managed: boolean;
  package: string;
  version: string;
  excludeNewer: string;
  script: SpeckitScript;
  /** Destinos declarados que reciben Spec Kit; el de por defecto va primero. */
  targets: ToolId[];
  defaultTarget: ToolId | null;
  defaultIntegration: string | null;
  /** Integraciones de Spec Kit en el mismo orden que `targets`. */
  integrations: string[];
  extensions: Record<string, string>;
}

export function speckitEnabledTargets(targets: readonly string[]): ToolId[] {
  return targets.filter((target): target is ToolId => isToolId(target) && TARGETS[target].speckit !== null);
}

export function integrationOf(target: ToolId): string {
  const speckit = TARGETS[target].speckit;
  if (speckit === null) {
    throw new Error(`el destino ${target} no recibe Spec Kit`);
  }
  return speckit.integration;
}

export function effectiveSpeckit(
  manifest: { targets: readonly string[]; speckit?: ProjectSpeckit },
  engine: EngineManifest,
): SpeckitSettings {
  const block = manifest.speckit ?? {};
  const enabled = speckitEnabledTargets(manifest.targets);
  const declaredDefault =
    block.defaultTarget !== undefined && enabled.includes(block.defaultTarget as ToolId)
      ? (block.defaultTarget as ToolId)
      : null;
  const defaultTarget = declaredDefault ?? enabled[0] ?? null;
  const targets =
    defaultTarget === null ? [] : [defaultTarget, ...enabled.filter((target) => target !== defaultTarget)];
  return {
    managed: block.managed !== false,
    package: engine.speckit.package,
    version: block.version ?? engine.speckit.pin,
    excludeNewer: engine.speckit.excludeNewer,
    script: block.script ?? engine.speckit.script,
    targets,
    defaultTarget,
    defaultIntegration: defaultTarget === null ? null : integrationOf(defaultTarget),
    integrations: targets.map(integrationOf),
    extensions: { ...engine.speckit.extensions },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Valida el bloque `speckit` del proyecto contra el paquete. Devuelve errores con el nombre del campo.
 * Se ejecuta antes del schema para poder explicar los campos que pertenecen al motor.
 */
export function validateProjectSpeckit(
  block: unknown,
  targets: readonly string[],
  engine: EngineManifest,
): string[] {
  if (block === undefined) {
    return speckitEnabledTargets(targets).length === 0
      ? ['speckit requiere al menos un destino con Spec Kit (claude, opencode, pi, cursor) o speckit.managed: false']
      : [];
  }
  if (!isRecord(block)) {
    return ['speckit debe ser un objeto'];
  }
  const errors: string[] = [];
  for (const field of ENGINE_OWNED_SPECKIT_FIELDS) {
    if (field in block) {
      errors.push(`speckit.${field} pertenece al motor; el proyecto no puede redefinirlo`);
    }
  }
  if (block.version !== undefined) {
    if (typeof block.version !== 'string' || !satisfiesRange(block.version, engine.speckit.supported)) {
      errors.push(
        `speckit.version ${String(block.version)} está fuera del rango soportado por el paquete "${engine.speckit.supported}"`,
      );
    }
  }
  const enabled = speckitEnabledTargets(targets);
  if (block.defaultTarget !== undefined) {
    const value = String(block.defaultTarget);
    if (!enabled.includes(value as ToolId)) {
      const all = Object.keys(TARGETS).filter((tool) => TARGETS[tool as ToolId].speckit !== null);
      errors.push(
        `speckit.defaultTarget "${value}" debe ser un destino declarado con Spec Kit: ${all.join(', ')}`,
      );
    }
  }
  if (block.managed !== false && enabled.length === 0) {
    errors.push('speckit requiere al menos un destino con Spec Kit (claude, opencode, pi, cursor) o speckit.managed: false');
  }
  return errors;
}
