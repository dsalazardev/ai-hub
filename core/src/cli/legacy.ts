import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CliContext } from './types.js';

export async function cmdVerify(ctx: CliContext): Promise<number> {
  const projectGate = path.join(ctx.root, '.ai-hub', 'harness', 'run-all.sh');
  const engineGate = path.join(ctx.root, 'harness', 'run-all.sh');
  const runAllPath = existsSync(projectGate) ? projectGate : engineGate;
  const result = spawnSync('bash', [runAllPath], { stdio: 'inherit' });
  if (result.error) {
    ctx.io.err(`run-all.sh no encontrado o no ejecutable: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export async function cmdJudge(ctx: CliContext): Promise<number> {
  ctx.io.out('[INFO]  Nivel 4 LLM-as-judge no implementado. Disponible en Fase 3 (ai-hub-v4-judge).');
  return 0;
}
