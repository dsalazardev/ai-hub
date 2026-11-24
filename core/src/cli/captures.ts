import path from 'node:path';
import { CAPTURE_QUOTA, listCaptures, releaseCapture } from '../writes/transaction.js';
import type { CliContext, ParsedArgs } from './types.js';

const USAGE = 'uso: ai-hub captures list <archivo> | ai-hub captures release <captura> --yes';

/**
 * Capturas de la versión reemplazada (3.23, R-105). Una captura guarda una escritura externa detectada después de la
 * última comprobación; ocupa una de las plazas del destino hasta que una persona la revisa y la libera. Con el cupo
 * lleno la transacción no reemplaza (`capture_quota_full`). Liberar solo borra capturas del motor, nunca el destino.
 */
export async function cmdCaptures(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub, target] = args.positionals;
  if ((sub !== 'list' && sub !== 'release') || !target) {
    ctx.io.err(USAGE);
    return 2;
  }
  const file = path.resolve(ctx.cwd, target);
  if (sub === 'list') {
    const captures = await listCaptures(file);
    ctx.io.out(`capturas de ${target}: ${captures.length} de ${CAPTURE_QUOTA}`);
    for (const capture of captures) {
      ctx.io.out(`  ${path.basename(capture)}`);
    }
    return 0;
  }
  if (!args.flags.yes) {
    ctx.io.err(`release borra la captura ${target}; revísala antes y repite con --yes`);
    return 2;
  }
  try {
    await releaseCapture(file);
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
  ctx.io.out(`captura liberada: ${target}`);
  return 0;
}
