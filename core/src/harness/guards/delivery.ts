/**
 * Guardia de entrega (R-072), pura: abrir la petición de cambio es del componente de entrega, nunca de un rol
 * implementer. Un comando de shell que invoca `ai-hub control deliver` desde un rol `implementer-*` se deniega
 * nombrando el rol, en cualquier modo (no es una guardia de `shadow`: separa autoría y apertura).
 */

export const DELIVERY_COMMAND = /\bai-hub(?:-cli)?(?:@\S+)?\s+control\s+deliver\b/;

export function classifyDelivery(command: string, role: string | null): { decision: 'deny'; rule: string; reason: string } | null {
  if (role === null || !/^implementer\b|^implementer-/.test(role) || !DELIVERY_COMMAND.test(command)) {
    return null;
  }
  return {
    decision: 'deny',
    rule: 'delivery:role',
    reason: `el rol ${role} no abre peticiones de cambio: la entrega es del componente de entrega (autoría, apertura, revisión y aprobación van separadas)`,
  };
}
