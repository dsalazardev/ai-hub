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
  /** Sello de revisión (M-31): presente solo si el proyecto selló un veredicto. */
  review?: {
    verdict: string;
    /** Hash del diff sellado. */
    sealed: string;
    /** Hash del diff actual contra la misma base; `null` si no se pudo leer. */
    current: string | null;
  };
}

export interface GuardResult {
  decision: GuardDecision;
  rule: string;
  reason: string;
}

export const ALLOW_RULE = 'preflight:allow';
