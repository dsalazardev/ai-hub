import { classifyBranch } from './branch.js';
import { classifyDanger, DANGER_RULE_IDS } from './danger.js';
import { classifyShip } from './ship.js';
import { classifyTrunk } from './trunk.js';
import { ALLOW_RULE, type GuardContext, type GuardMode, type GuardResult } from './types.js';

export const GUARD_RULE_IDS = [
  ...DANGER_RULE_IDS,
  'ship:unpushed',
  'trunk:closed',
  'branch:checked-out-elsewhere',
  ALLOW_RULE,
];

/**
 * Pure policy evaluation. All IO (git, filesystem, config) belongs to the caller
 * that builds GuardContext. No imports from node:fs, node:child_process or node:net.
 */
export function runPreflight(command: string, ctx: GuardContext): GuardResult {
  return (
    classifyDanger(command, ctx.preset?.dangerPatterns ?? []) ??
    classifyShip(command, ctx) ??
    classifyTrunk(command, ctx) ??
    classifyBranch(command, ctx) ?? {
      decision: 'allow',
      rule: ALLOW_RULE,
      reason: 'sin reglas de peligro, trunk o rama aplicables.',
    }
  );
}

export interface PreflightOutcome {
  result: GuardResult;
  mode: GuardMode;
  blocked: boolean;
}

export function evaluatePreflight(
  command: string,
  ctx: GuardContext,
  mode: GuardMode = ctx.policy.guardMode,
): PreflightOutcome {
  const result = runPreflight(command, ctx);
  return {
    result,
    mode,
    blocked: mode === 'enforce' && result.decision !== 'allow',
  };
}

export function requiresConfirmation(result: GuardResult): boolean {
  return result.decision === 'ask';
}
