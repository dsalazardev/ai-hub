import { evaluatePreflight } from '../preflight.js';
import type { GuardContext, GuardMode, GuardResult } from '../types.js';

export interface RunnerPreflight {
  command: string;
  result: GuardResult;
  mode: GuardMode;
  blocked: boolean;
}

/**
 * Authoritative entrypoint for the Hermes runner. The runner builds GuardContext
 * once per job and calls this before dispatch; shadow mode records, enforce blocks.
 */
export function preflightForRunner(
  command: string,
  ctx: GuardContext,
  mode: GuardMode = 'shadow',
): RunnerPreflight {
  const outcome = evaluatePreflight(command, ctx, mode);
  return {
    command,
    result: outcome.result,
    mode: outcome.mode,
    blocked: outcome.blocked,
  };
}

export function formatRunnerDecision(decision: RunnerPreflight): string {
  const prefix = decision.mode === 'shadow' ? '[shadow]' : '[enforce]';
  return `${prefix} ${decision.result.decision} ${decision.result.rule}: ${decision.result.reason}`;
}
