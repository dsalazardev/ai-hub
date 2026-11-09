import type { CliContext } from './types.js';

export async function cmdJudge(ctx: CliContext): Promise<number> {
  ctx.io.out('[INFO]  Nivel 4 LLM-as-judge no implementado. Disponible en Fase 3 (ai-hub-v4-judge).');
  return 0;
}
