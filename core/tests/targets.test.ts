import { describe, it, expect } from 'vitest';
import { TARGETS, TOOL_IDS } from '../src/sync/targets.js';
import { loadEngine } from '../src/engine/engine.js';

describe('target registry', () => {
  it('declares five targets with skills, rules and a hook surface', () => {
    expect(TOOL_IDS).toHaveLength(5);
    for (const id of TOOL_IDS) {
      const target = TARGETS[id];
      expect(target.skills).toBeTruthy();
      expect(target.rules).toBeTruthy();
      expect(target.hook).toBeTruthy();
      expect(['dir', 'file']).toContain(target.skillShape);
    }
  });

  it('uses the file shape only for Cursor and gives Copilot instructions', () => {
    expect(TARGETS.cursor.skillShape).toBe('file');
    expect(TARGETS.copilot.ruleShape).toBe('instructions');
    expect(TARGETS.claude.agents).toBe('.claude/agents');
  });

  it('matches the engine target list', async () => {
    const engine = await loadEngine();
    expect([...engine.targets].sort()).toEqual([...TOOL_IDS].sort());
  });
});
