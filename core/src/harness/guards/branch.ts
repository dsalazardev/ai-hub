import type { GuardContext, GuardResult } from './types.js';

const RESERVED = new Set(['--', '-', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD']);

/** Returns the branch a switch/checkout command would move to, or null. */
export function branchSwitchTarget(command: string): string | null {
  const cleaned = command.replace(/\s+/g, ' ').trim();
  const create = /\bgit\s+switch\s+(?:-c|--create)\s+([^\s;|&]+)/i.exec(cleaned);
  if (create) {
    return create[1];
  }
  const checkoutCreate = /\bgit\s+checkout\s+(?:-b|-B)\s+([^\s;|&]+)/i.exec(cleaned);
  if (checkoutCreate) {
    return checkoutCreate[1];
  }
  const switchPlain = /\bgit\s+switch\s+(?!--)([^\s;|&]+)/i.exec(cleaned);
  if (switchPlain) {
    const target = switchPlain[1];
    return RESERVED.has(target) ? null : target;
  }
  const checkoutPlain = /\bgit\s+checkout\s+(?!--)([^\s;|&]+)/i.exec(cleaned);
  if (checkoutPlain) {
    const target = checkoutPlain[1];
    return RESERVED.has(target) ? null : target;
  }
  return null;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function classifyBranch(command: string, ctx: GuardContext): GuardResult | null {
  const target = branchSwitchTarget(command);
  if (target === null) {
    return null;
  }
  const mine = ctx.session ? normalizePath(ctx.session.checkout) : null;
  const occupied = ctx.git.worktrees.find(
    (worktree) =>
      worktree.branch === target && (mine === null || normalizePath(worktree.path) !== mine),
  );
  if (!occupied) {
    return null;
  }
  return {
    decision: 'deny',
    rule: 'branch:checked-out-elsewhere',
    reason: `la rama "${target}" ya está activa en ${occupied.path}; usa otro nombre (git switch -c feat/<tema>) o elimina ese worktree antes de continuar.`,
  };
}
