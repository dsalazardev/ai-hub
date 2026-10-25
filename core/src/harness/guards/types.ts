export type GuardDecision = 'allow' | 'ask' | 'deny' | 'block';

export type GuardMode = 'shadow' | 'enforce';

export interface WorktreeInfo {
  path: string;
  branch: string;
  dirty: boolean;
  owned: boolean;
}

export interface PresetDangerPattern {
  id: string;
  pattern: string;
  decision: 'ask' | 'deny';
  reason: string;
}

export interface GuardContext {
  root: string;
  git: {
    branch: string;
    defaultBranch: string;
    head: string;
    dirty: boolean;
    ahead: number;
    worktrees: WorktreeInfo[];
  };
  project: {
    preset: string;
    languages: string[];
    hasCI: boolean;
    hasDeploy: boolean;
    team: boolean;
  };
  session?: {
    id: string;
    checkout: string;
  };
  policy: {
    trunk: 'auto' | 'closed' | 'open';
    guardMode: GuardMode;
    optOuts: string[];
  };
  preset?: {
    dangerPatterns: PresetDangerPattern[];
  };
}

export interface GuardResult {
  decision: GuardDecision;
  rule: string;
  reason: string;
}

export const ALLOW_RULE = 'preflight:allow';
