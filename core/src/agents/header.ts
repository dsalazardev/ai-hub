/**
 * Cabecera canónica de los agentes del catálogo (factory-evolution A3, M-11/M-33): abstracta, sin
 * nombres de proveedor ni de herramientas del host. Cada destino la traduce desde su `agentFormat`
 * declarativo (`sync/targets.ts`); el render nunca se ramifica por el nombre del destino.
 */
export const CAPABILITIES = ['read', 'search', 'edit', 'shell', 'web', 'delegate'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const TIERS = ['light', 'balanced', 'heavy'] as const;
export type Tier = (typeof TIERS)[number];
/** Capacidades que un rol de solo lectura (revisor, refuter) jamás declara. */
export const WRITE_CAPABILITIES: readonly Capability[] = ['edit', 'shell'];

export interface AgentHeader {
  capabilities?: Capability[];
  maxTurns?: number;
  tier?: Tier;
  role?: string;
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/** Valida las claves canónicas de un agente; devuelve los errores (vacío si es válida). */
export function validateAgentHeader(data: Record<string, unknown>, file: string): string[] {
  const errors: string[] = [];
  if ('capabilities' in data) {
    const value = data.capabilities;
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`${file}: capabilities debe ser una lista no vacía de ${CAPABILITIES.join(', ')}`);
    } else {
      for (const item of value) {
        if (!isCapability(item)) {
          errors.push(`${file}: capability desconocida "${String(item)}" (válidas: ${CAPABILITIES.join(', ')})`);
        }
      }
    }
  }
  if ('max_turns' in data) {
    const value = data.max_turns;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
      errors.push(`${file}: max_turns debe ser un entero entre 1 y 500`);
    }
  }
  if ('tier' in data && !(TIERS as readonly unknown[]).includes(data.tier)) {
    errors.push(`${file}: tier debe ser ${TIERS.join('|')}`);
  }
  for (const key of ['tools', 'model', 'maxTurns', 'steps', 'permissions', 'readonly']) {
    if (key in data) {
      errors.push(`${file}: "${key}" es una clave de destino; el catálogo declara capabilities, max_turns y tier`);
    }
  }
  return errors;
}

export function readAgentHeader(data: Record<string, unknown>): AgentHeader {
  const header: AgentHeader = {};
  if (Array.isArray(data.capabilities)) {
    header.capabilities = data.capabilities.filter(isCapability);
  }
  if (typeof data.max_turns === 'number') {
    header.maxTurns = data.max_turns;
  }
  if ((TIERS as readonly unknown[]).includes(data.tier)) {
    header.tier = data.tier as Tier;
  }
  if (typeof data.role === 'string') {
    header.role = data.role;
  }
  return header;
}

/** Forma de la cabecera de agente que entiende cada host. */
export type AgentHeaderStyle = 'tool-list' | 'deny-permissions' | 'readonly';

export interface AgentFormat {
  /** Directorio de agentes del destino. */
  path: string;
  extension: '.md' | '.agent.md';
  style: AgentHeaderStyle;
  /** `tool-list`: nombres de herramienta del host por capacidad. `deny-permissions`: acciones. */
  names: Record<Capability, string[]>;
  /** Clave del límite de turnos en el host, o `null` si no puede expresarlo. */
  turnsKey: string | null;
  /** `true` si el host lee `name` de la cabecera (si no, el nombre sale del archivo). */
  includeName: boolean;
  /** Claves fijas que el host necesita (p. ej. `mode: subagent`). */
  fixed: Record<string, string>;
  /** Claves cosméticas del catálogo que pasan tal cual si existen. */
  passthrough: string[];
}

export interface RenderedHeader {
  data: Record<string, unknown>;
  /** Claves de seguridad que el destino no pudo expresar (se informan en doctor). */
  degraded: string[];
}

/**
 * Traduce la cabecera canónica a la del destino. `model` viene del proyecto
 * (`manifest.agentModels.<target>.<tier>`); sin correspondencia se omite y el host hereda.
 */
export function renderAgentHeader(
  format: AgentFormat,
  base: { name: string; description: string },
  source: Record<string, unknown>,
  model: string | null,
): RenderedHeader {
  const header = readAgentHeader(source);
  const data: Record<string, unknown> = {
    ...(format.includeName ? { name: base.name } : {}),
    description: base.description,
    ...format.fixed,
  };
  const degraded: string[] = [];
  const capabilities = header.capabilities;
  if (capabilities !== undefined) {
    if (format.style === 'tool-list') {
      data.tools = [...new Set(capabilities.flatMap((capability) => format.names[capability]))];
    } else if (format.style === 'deny-permissions') {
      // Solo restringe: deniega lo no declarado y nunca concede nada.
      const denied = CAPABILITIES.filter((capability) => !capabilities.includes(capability));
      data.permissions = denied.flatMap((capability) =>
        format.names[capability].map((action) => ({ action, resource: '*', effect: 'deny' })),
      );
    } else {
      const writes = capabilities.some((capability) => WRITE_CAPABILITIES.includes(capability));
      if (!writes) {
        data.readonly = true;
      }
      degraded.push('capabilities (solo readonly)');
    }
  }
  if (header.maxTurns !== undefined) {
    if (format.turnsKey !== null) {
      data[format.turnsKey] = header.maxTurns;
    } else {
      degraded.push('max_turns');
    }
  }
  if (model !== null) {
    data.model = model;
  }
  for (const key of format.passthrough) {
    if (key in source) {
      data[key] = source[key];
    }
  }
  return { data, degraded };
}
