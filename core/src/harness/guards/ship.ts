import { branchSwitchTarget } from './branch.js';
import { isTrunkBranch } from './trunk.js';
import type { GuardContext, GuardResult } from './types.js';

function movesIntoTrunk(command: string, ctx: GuardContext): boolean {
  const cleaned = command.replace(/\s+/g, ' ').trim();
  const isTrunk = (branch: string): boolean =>
    isTrunkBranch(branch) || branch === ctx.git.defaultBranch;
  const switched = branchSwitchTarget(cleaned);
  if (switched !== null && isTrunk(switched)) {
    return true;
  }
  const merge = /\bgit\s+merge\s+([^\s;|&]+)/i.exec(cleaned);
  if (merge && isTrunk(merge[1])) {
    return true;
  }
  return isTrunk(ctx.git.branch) && /\bgit\s+merge\b/i.test(cleaned);
}

export function classifyShip(command: string, ctx: GuardContext): GuardResult | null {
  if (!movesIntoTrunk(command, ctx)) {
    return null;
  }
  const pending: string[] = [];
  if (ctx.git.dirty) {
    pending.push('cambios sin commit');
  }
  if (ctx.git.ahead > 0) {
    pending.push(`${ctx.git.ahead} commit(s) sin push`);
  }
  if (pending.length === 0) {
    return null;
  }
  return {
    decision: 'deny',
    rule: 'ship:unpushed',
    reason: `no muevas trabajo sin publicar a la trunk (${pending.join(', ')}); haz commit, push y abre una PR, o guarda el trabajo en una rama antes de continuar.`,
  };
}
