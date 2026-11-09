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

/**
 * M-31: si el proyecto selló un veredicto de revisión, volver a la trunk exige que el diff actual
 * sea byte a byte el revisado y que el veredicto apruebe. Sin sello no hay regla (opt-in); un diff
 * ilegible falla abierto, como el resto de adaptadores.
 */
function classifyReviewSeal(ctx: GuardContext): GuardResult | null {
  const review = ctx.review;
  if (!review || review.current === null) {
    return null;
  }
  if (review.current !== review.sealed) {
    return {
      decision: 'deny',
      rule: 'ship:review-seal',
      reason:
        'el diff cambió después de sellar la revisión (sello de revisión no coincide); vuelve a revisar y ejecuta ai-hub seal review.',
    };
  }
  if (review.verdict === 'CHANGES_REQUESTED') {
    return {
      decision: 'deny',
      rule: 'ship:review-seal',
      reason: 'el veredicto sellado es CHANGES_REQUESTED; corrige, vuelve a revisar y sella de nuevo.',
    };
  }
  return null;
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
    return classifyReviewSeal(ctx);
  }
  return {
    decision: 'deny',
    rule: 'ship:unpushed',
    reason: `no muevas trabajo sin publicar a la trunk (${pending.join(', ')}); haz commit, push y abre una PR, o guarda el trabajo en una rama antes de continuar.`,
  };
}
