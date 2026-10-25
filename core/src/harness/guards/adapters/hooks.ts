import { evaluatePreflight } from '../preflight.js';
import type { GuardContext, GuardMode } from '../types.js';

export interface ClaudePreToolUseInput {
  tool_name?: unknown;
  tool_input?: Record<string, unknown>;
}

export interface ClaudeHookOutput {
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
  systemMessage?: string;
}

export interface OpenCodeHookInput {
  tool?: unknown;
  args?: Record<string, unknown>;
}

export interface OpenCodeHookOutput {
  blocked: boolean;
  message?: string;
}

export function commandFromHookInput(input: ClaudePreToolUseInput | OpenCodeHookInput): string | null {
  const isClaude = 'tool_name' in input || 'tool_input' in input;
  const tool = isClaude ? (input as ClaudePreToolUseInput).tool_name : (input as OpenCodeHookInput).tool;
  const args = isClaude ? (input as ClaudePreToolUseInput).tool_input : (input as OpenCodeHookInput).args;
  if (typeof tool !== 'string' || !args) {
    return null;
  }
  if (!['Bash', 'bash', 'shell', 'run_command'].includes(tool)) {
    return null;
  }
  const command = args.command;
  return typeof command === 'string' ? command : null;
}

function message(rule: string, reason: string): string {
  return `${rule}: ${reason}`;
}

/**
 * Thin Claude adapter: translates the hook payload to runPreflight and back.
 * It contains no policy of its own.
 */
export function claudePreToolUse(
  input: ClaudePreToolUseInput,
  ctx: GuardContext,
  mode: GuardMode = 'shadow',
): ClaudeHookOutput | null {
  const command = commandFromHookInput(input);
  if (command === null) {
    return null;
  }
  const outcome = evaluatePreflight(command, ctx, mode);
  const text = message(outcome.result.rule, outcome.result.reason);
  if (mode === 'shadow') {
    return { permissionDecision: 'allow', systemMessage: `[shadow] ${text}` };
  }
  if (outcome.result.decision === 'allow') {
    return { permissionDecision: 'allow' };
  }
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: text,
    systemMessage: text,
  };
}

export function opencodeToolExecuteBefore(
  input: OpenCodeHookInput,
  ctx: GuardContext,
  mode: GuardMode = 'shadow',
): OpenCodeHookOutput | null {
  const command = commandFromHookInput(input);
  if (command === null) {
    return null;
  }
  const outcome = evaluatePreflight(command, ctx, mode);
  const text = message(outcome.result.rule, outcome.result.reason);
  if (mode === 'shadow') {
    return { blocked: false, message: `[shadow] ${text}` };
  }
  return { blocked: outcome.result.decision !== 'allow', message: text };
}
