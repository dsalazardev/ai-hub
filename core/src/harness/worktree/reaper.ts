export interface WorktreeFacts {
  path: string;
  branch: string;
  owned: boolean;
  dirty: boolean;
  untrackedNonRegenerable: boolean;
  unmergedCommits: number;
  integrated: boolean;
}

export type ReapDecision = 'keep' | 'ask' | 'remove';

export interface ReapPlan {
  path: string;
  branch: string;
  decision: ReapDecision;
  rule: string;
  reason: string;
}

export interface ReapOptions {
  confirm: boolean;
}

/**
 * Three conservative questions, each failing towards keeping:
 * provenance (did ai-hub create it?), integration (is the branch landed?),
 * contents (are there non-regenerable files?).
 */
export function decideWorktree(facts: WorktreeFacts, options: ReapOptions): ReapPlan {
  const base = { path: facts.path, branch: facts.branch };
  if (!facts.owned) {
    return {
      ...base,
      decision: 'keep',
      rule: 'reaper:foreign',
      reason: 'el worktree no fue creado por ai-hub; no se toca.',
    };
  }
  if (!facts.integrated || facts.unmergedCommits > 0) {
    return {
      ...base,
      decision: 'keep',
      rule: 'reaper:unmerged',
      reason: `la rama tiene ${facts.unmergedCommits} commit(s) sin integrar en la trunk; intégrala o abre una PR antes de reapear.`,
    };
  }
  if (facts.dirty || facts.untrackedNonRegenerable) {
    return {
      ...base,
      decision: 'keep',
      rule: 'reaper:contents',
      reason:
        'hay cambios sin commit o archivos no regenerables; guarda el trabajo o muévelo a una rama antes de reapear.',
    };
  }
  if (!options.confirm) {
    return {
      ...base,
      decision: 'ask',
      rule: 'reaper:clean-owned',
      reason: 'worktree limpio y propio; se elimina solo con --confirm.',
    };
  }
  return {
    ...base,
    decision: 'remove',
    rule: 'reaper:clean-owned',
    reason: 'worktree limpio, propio e integrado; eliminación confirmada.',
  };
}

export interface ReapReport {
  keep: ReapPlan[];
  ask: ReapPlan[];
  remove: ReapPlan[];
}

export function planReap(worktrees: WorktreeFacts[], options: ReapOptions): ReapReport {
  const report: ReapReport = { keep: [], ask: [], remove: [] };
  for (const facts of worktrees) {
    const plan = decideWorktree(facts, options);
    report[plan.decision === 'keep' ? 'keep' : plan.decision === 'ask' ? 'ask' : 'remove'].push(plan);
  }
  return report;
}
