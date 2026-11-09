import type { EngineManifest } from './engine.js';

/**
 * Áreas de implementación (factory-evolution E3, M-18, cierra G-05): el `can_modify` de cada
 * implementer se resuelve desde las áreas del manifiesto o del preset. Los roles del motor no
 * cambian; un área solo puede asignarse a uno de los dos implementers.
 */
export const AREA_ROLES = ['implementer-frontend', 'implementer-backend'] as const;
export type AreaRole = (typeof AREA_ROLES)[number];

export interface AreaSpec {
  id: string;
  paths: string[];
  role: AreaRole;
  rules?: string[];
}

export function isAreaRole(value: unknown): value is AreaRole {
  return typeof value === 'string' && (AREA_ROLES as readonly string[]).includes(value);
}

/** Glob de escritura de una ruta de área: `frontend/src` → `frontend/src/**`. */
export function areaGlob(areaPath: string): string {
  const clean = areaPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return clean.includes('*') ? clean : `${clean}/**`;
}

/** Errores de validación de las áreas (rol desconocido, ids repetidos, rutas vacías). */
export function validateAreas(areas: unknown, where: string): string[] {
  if (areas === undefined) {
    return [];
  }
  if (!Array.isArray(areas)) {
    return [`${where}: paths.areas debe ser una lista`];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of areas.entries()) {
    const area = raw as Record<string, unknown>;
    const id = typeof area.id === 'string' ? area.id : `#${index}`;
    if (seen.has(id)) {
      errors.push(`${where}: paths.areas repite el id "${id}"`);
    }
    seen.add(id);
    if (!isAreaRole(area.role)) {
      errors.push(`${where}: paths.areas "${id}" usa el rol desconocido "${String(area.role)}" (válidos: ${AREA_ROLES.join(', ')})`);
    }
    if (!Array.isArray(area.paths) || area.paths.length === 0) {
      errors.push(`${where}: paths.areas "${id}" necesita al menos una ruta`);
    }
  }
  return errors;
}

/**
 * `can_modify` efectivo por rol. Sin áreas rige el del motor; con áreas, cada implementer escribe
 * solo en las rutas de sus áreas (si no tiene ninguna, en nada) y el resto de roles no cambia.
 */
export function resolveRoleScopes(engine: EngineManifest, areas: AreaSpec[] | undefined): Record<string, string[]> {
  const scopes: Record<string, string[]> = {};
  for (const role of engine.roles) {
    scopes[role.id] = [...role.can_modify];
  }
  if (areas === undefined || areas.length === 0) {
    return scopes;
  }
  for (const role of AREA_ROLES) {
    scopes[role] = areas.filter((area) => area.role === role).flatMap((area) => area.paths.map(areaGlob));
  }
  return scopes;
}
