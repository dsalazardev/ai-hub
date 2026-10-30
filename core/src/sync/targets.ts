export const TOOL_IDS = ['claude', 'opencode', 'pi', 'cursor', 'copilot'] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export type SkillShape = 'dir' | 'file';
export type RuleShape = 'md' | 'mdc' | 'instructions';
export type HookKind = 'markdown' | 'cursor-mdc' | 'copilot-instructions';

/**
 * Integración de Spec Kit que sirve a un destino. `commandsDir` es donde Spec Kit escribe
 * sus comandos y delimita el espacio de nombres reservado `speckit-*` / `speckit.*`.
 * `skill-dir` escribe `<dir>/speckit-plan/SKILL.md`; `command-file` escribe `<dir>/speckit.plan.md`.
 */
export interface SpeckitTarget {
  integration: string;
  separator: '-' | '.';
  commandsDir: string;
  layout: 'skill-dir' | 'command-file';
}

export interface ToolTargets {
  skills: string;
  agents: string | null;
  rules: string;
  hook: string;
  skillShape: SkillShape;
  ruleShape: RuleShape;
  hookKind: HookKind;
  /** `null`: el destino no recibe Spec Kit (Copilot). */
  speckit: SpeckitTarget | null;
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
    speckit: { integration: 'claude', separator: '-', commandsDir: '.claude/skills', layout: 'skill-dir' },
  },
  opencode: {
    skills: '.opencode/skills',
    agents: '.opencode/agents',
    rules: '.opencode/rules',
    hook: '.opencode/rules/preflight.md',
    skillShape: 'dir',
    ruleShape: 'md',
    hookKind: 'markdown',
    speckit: { integration: 'opencode', separator: '.', commandsDir: '.opencode/commands', layout: 'command-file' },
  },
  pi: {
    skills: '.pi/skills',
    agents: '.pi/agents',
    rules: '.pi/prompts',
    hook: '.pi/prompts/preflight.md',
    skillShape: 'dir',
    ruleShape: 'md',
    hookKind: 'markdown',
    speckit: { integration: 'pi', separator: '.', commandsDir: '.pi/prompts', layout: 'command-file' },
  },
  cursor: {
    skills: '.cursor/rules',
    agents: null,
    rules: '.cursor/rules',
    hook: '.cursor/rules/preflight.mdc',
    skillShape: 'file',
    ruleShape: 'mdc',
    hookKind: 'cursor-mdc',
    speckit: { integration: 'cursor-agent', separator: '-', commandsDir: '.cursor/skills', layout: 'skill-dir' },
  },
  copilot: {
    skills: '.github/skills',
    agents: '.github/agents',
    rules: '.github/instructions',
    hook: '.github/instructions/preflight.instructions.md',
    skillShape: 'dir',
    ruleShape: 'instructions',
    hookKind: 'copilot-instructions',
    speckit: null,
  },
};

export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

/**
 * Presencia e instrucciones por destino (design D7). El probe sólo pregunta por el
 * binario (`<probeCommand> --version` vía ctx.exec); el login JAMÁS se verifica ni
 * se lee auth: el hint se imprime y las credenciales viven en las herramientas.
 */
export interface ToolHints {
  probeCommand: string;
  installHint: string;
  loginHint: string;
}

export const TOOL_HINTS: Record<ToolId, ToolHints> = {
  claude: {
    probeCommand: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginHint: 'arranca claude y sigue el login',
  },
  opencode: {
    probeCommand: 'opencode',
    installHint: 'npm install -g opencode-ai',
    loginHint: 'opencode auth login',
  },
  pi: {
    probeCommand: 'pi',
    installHint: 'instala el agente Pi siguiendo la documentación de tu distribución',
    loginHint: 'haz login en tu agente Pi como indique su documentación',
  },
  cursor: {
    probeCommand: 'cursor-agent',
    installHint: 'instala Cursor CLI (cursor-agent) siguiendo la documentación de Cursor',
    loginHint: 'cursor-agent login (usa la sesión de tu instalación de Cursor)',
  },
  copilot: {
    probeCommand: 'gh',
    installHint: 'instala GitHub CLI y luego gh extension install github/gh-copilot',
    loginHint: 'gh auth login',
  },
};

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
