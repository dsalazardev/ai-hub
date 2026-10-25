import { describe, it, expect } from 'vitest';
import { decideWorktree, planReap, type WorktreeFacts } from '../src/harness/worktree/reaper.js';

function facts(overrides: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    path: '/repo/.worktrees/demo',
    branch: 'feat/demo',
    owned: true,
    dirty: false,
    untrackedNonRegenerable: false,
    unmergedCommits: 0,
    integrated: true,
    ...overrides,
  };
}

describe('worktree reaper', () => {
  it('nunca toca un worktree ajeno', () => {
    const plan = decideWorktree(facts({ owned: false }), { confirm: true });
    expect(plan.decision).toBe('keep');
    expect(plan.rule).toBe('reaper:foreign');
  });

  it('conserva una rama con commits sin integrar', () => {
    const plan = decideWorktree(facts({ unmergedCommits: 3, integrated: false }), { confirm: true });
    expect(plan.decision).toBe('keep');
    expect(plan.rule).toBe('reaper:unmerged');
    expect(plan.reason).toContain('PR');
  });

  it('conserva un worktree con cambios sin commit', () => {
    const plan = decideWorktree(facts({ dirty: true }), { confirm: true });
    expect(plan.decision).toBe('keep');
    expect(plan.rule).toBe('reaper:contents');
  });

  it('conserva un worktree con archivos no regenerables', () => {
    const plan = decideWorktree(facts({ untrackedNonRegenerable: true }), { confirm: true });
    expect(plan.decision).toBe('keep');
  });

  it('pide confirmación para un worktree limpio y propio', () => {
    const plan = decideWorktree(facts(), { confirm: false });
    expect(plan.decision).toBe('ask');
    expect(plan.reason).toContain('--confirm');
  });

  it('solo elimina con confirmación explícita', () => {
    const plan = decideWorktree(facts(), { confirm: true });
    expect(plan.decision).toBe('remove');
  });

  it('agrupa el plan sin mezclar decisiones', () => {
    const report = planReap(
      [facts(), facts({ owned: false }), facts({ dirty: true }), facts({ path: '/repo/.worktrees/otro' })],
      { confirm: false },
    );
    expect(report.ask).toHaveLength(2);
    expect(report.keep).toHaveLength(2);
    expect(report.remove).toHaveLength(0);
  });
});
