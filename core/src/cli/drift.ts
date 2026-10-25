import { runSync } from '../sync/sync.js';
import { sourceCheckout } from './source.js';
import type { CliContext, ParsedArgs } from './types.js';

const CATEGORIES = [
  ['falta ', 'missing'],
  ['desactualizado: ', 'stale'],
  ['editado a mano: ', 'hand-edited'],
  ['destino obsoleto: ', 'obsolete'],
  ['enlace simbólico', 'symlink'],
] as const;

export async function cmdDrift(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const source = await sourceCheckout(ctx.root);
  if (source.isSource) {
    ctx.io.out('[OK]    Modo fuente: sin destinos que verificar (taller, no instalación)');
    return 0;
  }

  const result = await runSync(ctx.root, { check: true });
  if (args.flags.json) {
    const categories = Object.fromEntries(
      CATEGORIES.map(([prefix, name]) => [
        name,
        result.problems.filter((problem) => problem.startsWith(prefix)),
      ]),
    );
    ctx.io.out(JSON.stringify({ clean: result.problems.length === 0, categories }, null, 2));
    return result.problems.length === 0 ? 0 : 1;
  }
  if (result.problems.length === 0) {
    ctx.io.out('[OK]    Sin deriva');
    return 0;
  }
  for (const problem of result.problems) {
    ctx.io.err(`[DRIFT] ${problem}`);
  }
  ctx.io.err(`Ejecuta ai-hub sync para corregir ${result.problems.length} diferencias`);
  return 1;
}
