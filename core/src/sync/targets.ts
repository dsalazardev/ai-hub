export const TOOL_IDS = ['claude', 'opencode', 'pi', 'cursor', 'copilot'] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export type SkillShape = 'dir' | 'file';
export type RuleShape = 'md' | 'mdc' | 'instructions';
export type HookKind = 'markdown' | 'cursor-mdc' | 'copilot-instructions';

export interface ToolTargets {
  skills: string;
  agents: string | null;
  rules: string;
  hook: string;
  skillShape: SkillShape;
  ruleShape: RuleShape;
  hookKind: HookKind;
}

/**
 * Declarative destination table. Adding a tool means adding one row and one id
 * in engine.yaml `targets`; renderers never branch on a tool name.
 */
export const TARGETS: Record<ToolId, ToolTargets> = {
  claude: {
    skills: '.claude/skills',
    agents: '.claude/agents',
    rules: '.claude/rules',
    hook: '.claude/rules/preflight.md',
    skillShape: 'dir',
    ruleShape: 'md',
    hookKind: 'markdown',
  },
  opencode: {
    skills: '.opencode/skills',
    agents: '.opencode/agents',
    rules: '.opencode/rules',
    hook: '.opencode/rules/preflight.md',
    skillShape: 'dir',
    ruleShape: 'md',
    hookKind: 'markdown',
  },
  pi: {
    skills: '.pi/skills',
    agents: '.pi/agents',
    rules: '.pi/prompts',
    hook: '.pi/prompts/preflight.md',
    skillShape: 'dir',
    ruleShape: 'md',
    hookKind: 'markdown',
  },
  cursor: {
    skills: '.cursor/rules',
    agents: null,
    rules: '.cursor/rules',
    hook: '.cursor/rules/preflight.mdc',
    skillShape: 'file',
    ruleShape: 'mdc',
    hookKind: 'cursor-mdc',
  },
  copilot: {
    skills: '.github/skills',
    agents: '.github/agents',
    rules: '.github/instructions',
    hook: '.github/instructions/preflight.instructions.md',
    skillShape: 'dir',
    ruleShape: 'instructions',
    hookKind: 'copilot-instructions',
  },
};

export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

export function assertToolIds(values: string[]): ToolId[] {
  const invalid = values.filter((value) => !isToolId(value));
  if (invalid.length > 0) {
    throw new Error(`destinos desconocidos: ${invalid.join(', ')}. Válidos: ${TOOL_IDS.join(', ')}`);
  }
  return values as ToolId[];
}

export function agentTargets(tools: ToolId[]): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const tool of tools) {
    const target = TARGETS[tool].agents;
    if (target !== null) {
      entries.push([tool, target]);
    }
  }
  return Object.fromEntries(entries);
}

export function ruleTargets(tools: ToolId[]): Record<string, string> {
  return Object.fromEntries(tools.map((tool) => [tool, TARGETS[tool].rules]));
}

export function skillTargets(tools: ToolId[]): string[] {
  return [...new Set(tools.map((tool) => TARGETS[tool].skills))];
}
