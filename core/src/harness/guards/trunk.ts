import type { GuardContext, GuardResult } from './types.js';

export const TRUNK_BRANCHES = new Set(['main', 'master', 'trunk']);

export function isTrunkBranch(branch: string): boolean {
  return TRUNK_BRANCHES.has(branch.toLowerCase());
}

function writesToCheckedOutTrunk(command: string): boolean {
  const cleaned = command.replace(/\s+/g, ' ').trim();
  return (
    /\bgit\s+commit\b/i.test(cleaned) ||
    /\bgit\s+merge\b/i.test(cleaned) ||
    /\bgit\s+rebase\b/i.test(cleaned) ||
    /\bgit\s+push\b/i.test(cleaned) ||
    /\bgit\s+tag\b/i.test(cleaned)
  );
}

export function trunkIsClosed(ctx: GuardContext): boolean {
  if (ctx.policy.optOuts.includes('trunk')) {
    return false;
  }
  if (ctx.policy.trunk === 'open') {
    return false;
  }
  if (ctx.policy.trunk === 'closed') {
    return true;
  }
  return ctx.project.hasCI || ctx.project.hasDeploy || ctx.project.team;
}

export function classifyTrunk(command: string, ctx: GuardContext): GuardResult | null {
  if (!writesToCheckedOutTrunk(command)) {
    return null;
  }
  const onTrunk = isTrunkBranch(ctx.git.branch) || ctx.git.branch === ctx.git.defaultBranch;
  if (!onTrunk) {
    return null;
  }
  if (!trunkIsClosed(ctx)) {
    return null;
  }
  return {
    decision: 'deny',
    rule: 'trunk:closed',
    reason:
      'the trunk is closed by CI, deployment, team signals or project policy; create a branch (git switch -c feat/<topic>), commit there and open a PR.',
  };
}
