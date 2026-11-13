import type { CliIO } from './types.js';

/**
 * init-fiabilidad (IO-01…03, DEV-08, design.md §8): las integraciones opcionales (tracker y plano de control) corren
 * después de verificar la base, aisladas. Su fallo nunca cambia el código de salida de `init`: se informa como un
 * estado, con una línea estable en stdout para scripts y una nota humana en stderr. Estos estados describen la
 * instalación; no son estados de gobierno ni mueven etiquetas.
 */
export type IntegrationName = 'tracker' | 'control';
export type IntegrationState = 'no-solicitada' | 'completada' | 'pendiente' | 'fallida' | 'no-verificable';

export interface IntegrationReport {
  name: IntegrationName;
  state: IntegrationState;
  /** Etapa alcanzada (ids de design.md §8) o `null`. */
  stage: string | null;
  /** Un comando existente que retoma la integración, o `null`. */
  action: string | null;
  ready?: string[];
  /** Piezas cuya comprobación aún no se pudo hacer; no son ausencias. */
  unverified?: string[];
  /** Solo ausencias observadas. */
  missing?: string[];
  /** Datos que la persona tiene que aportar de nuevo (nunca valores). */
  provide?: string[];
  /** Causa ya redactada, sin secretos. */
  cause?: string[];
}

export const STATUS_PREFIX = 'ai-hub-integration:';

/** Línea estable: `ai-hub-integration: name=… state=… stage=… action=…` (action ocupa el resto de la línea). */
export function statusLine(report: IntegrationReport): string {
  return `${STATUS_PREFIX} name=${report.name} state=${report.state} stage=${report.stage ?? '-'} action=${report.action ?? '-'}`;
}

/** Declara `manifest.tracker` sin terminal cuando `.ai-hub/.env` ya tiene las claves (fabrica-verificable §D6). */
export const DECLARE_TRACKER_ACTION = 'ai-hub init --yes --declare-tracker';

/** Acción tras guardar la conexión (token del perfil + `manifest.control`). */
export const ENROLL_ACTION = 'ai-hub control enroll --yes';
/** Retomar la conexión antes del punto de guardado (design.md §12.4): el token solo por stdin, nunca como argumento. */
export const RETAKE_ACTION = 'ai-hub init --yes --connect-hermes --discord-channel <id> --approver <id> --discord-token-stdin';
export const RETAKE_PROVIDE = ['token (entrada estándar o entrada enmascarada)', 'canal', 'aprobador', 'TTL', 'expiración'];

/** Nota humana para un estado no completado: etapa, lo listo, lo que falta y cómo retomarlo. */
export function humanNote(report: IntegrationReport): string {
  const parts = [`${report.name}: ${report.state}${report.stage ? ` en ${report.stage}` : ''}`];
  if (report.ready && report.ready.length > 0) {
    parts.push(`listo: ${report.ready.join(', ')}`);
  }
  if (report.unverified && report.unverified.length > 0) {
    parts.push(`sin verificar: ${report.unverified.join(', ')}`);
  }
  if (report.missing && report.missing.length > 0) {
    parts.push(`falta: ${report.missing.join(', ')}`);
  }
  if (report.provide && report.provide.length > 0) {
    parts.push(`aporta de nuevo: ${report.provide.join(', ')}`);
  }
  if (report.action) {
    parts.push(`siguiente: ${report.action}${report.action === RETAKE_ACTION ? ' (o ai-hub init en una terminal)' : ''}`);
  }
  return parts.join(' · ');
}

/**
 * Aislador (IO-01): cualquier excepción dentro de una integración se convierte en `fallida` con su etapa; nunca
 * llega al manejador general («Error inesperado»). El mensaje se reduce a su primera línea, sin pila.
 */
export async function isolate(
  name: IntegrationName,
  stage: () => string | null,
  run: () => Promise<IntegrationReport | null>,
  action: () => string | null = () => null,
): Promise<IntegrationReport | null> {
  try {
    return await run();
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return { name, state: 'fallida', stage: stage() ?? name, action: action(), cause: [message] };
  }
}

/** Cierra `init`: notas humanas en stderr para lo no completado y, al final de stdout, una línea por integración. */
export function printReports(io: CliIO, reports: readonly IntegrationReport[]): void {
  for (const report of reports) {
    if (report.state !== 'completada' && report.state !== 'no-solicitada') {
      io.err(`aviso: ${humanNote(report)}`);
      for (const line of report.cause ?? []) {
        io.err(`  ${line}`);
      }
    }
  }
  for (const report of reports) {
    io.out(statusLine(report));
  }
}
