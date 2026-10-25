import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  appendLedger,
  queryLedger,
  readLedger,
  resumeLedger,
  sanitizeEvent,
  LedgerValidationError,
} from '../src/harness/memory/ledger.js';
import { emptyState, writeState } from '../src/harness/memory/state.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ledger-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('ledger', () => {
  it('drops prompts, content and secrets from the closed schema', () => {
    const event = sanitizeEvent({
      sessionId: 's1',
      event: 'checkpoint',
      branch: 'feat/x',
      prompt: 'ignore me',
      content: 'secret',
      token: 'glpat-123',
      files: ['a.ts'],
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('ignore me');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('glpat');
    expect(event.files).toEqual(['a.ts']);
  });

  it('rejects events outside the enum and events without a session', () => {
    expect(() => sanitizeEvent({ sessionId: 's1', event: 'prompt' })).toThrow(LedgerValidationError);
    expect(() => sanitizeEvent({ event: 'start' })).toThrow(/sessionId/);
  });

  it('appends and reads events in order', async () => {
    await appendLedger(root, { sessionId: 's1', event: 'start', branch: 'main' });
    await appendLedger(root, { sessionId: 's1', event: 'end', branch: 'main', toolCalls: 4 });
    const events = await readLedger(root);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('start');
    expect(events[1].toolCalls).toBe(4);
  });

  it('stores a decision with alternatives', async () => {
    const event = await appendLedger(root, {
      sessionId: 's1',
      changeId: 'feat-a',
      event: 'decision',
      decision: { id: 'D1', choice: 'single package', alternatives: ['monorepo'] },
    });
    expect(event.changeId).toBe('feat-a');
    expect(event.decision).toEqual({
      id: 'D1',
      choice: 'single package',
      alternatives: ['monorepo'],
    });
    expect((await readLedger(root))[0].decision?.choice).toBe('single package');
    const queried = queryLedger(await readLedger(root), { changeId: 'feat-a', sessionId: 's1' });
    expect(queried).toHaveLength(1);
    expect(queryLedger(await readLedger(root), { changeId: 'other' })).toHaveLength(0);
  });

  it('applies the retention policy', async () => {
    await appendLedger(root, { sessionId: 'a', event: 'start' }, 2);
    await appendLedger(root, { sessionId: 'b', event: 'checkpoint' }, 2);
    await appendLedger(root, { sessionId: 'c', event: 'end' }, 2);
    const events = await readLedger(root);
    expect(events.map((event) => event.sessionId)).toEqual(['b', 'c']);
  });

  it('resumes the active change and task counts from .planning', async () => {
    await writeState(root, {
      ...emptyState('demo', 'generic-ts'),
      activeChange: 'feat-a',
      phase: 'apply',
      tasks: { total: 5, done: 2 },
    });
    await appendLedger(root, { sessionId: 's1', event: 'start', branch: 'feat/a' });
    const summary = await resumeLedger(root);
    expect(summary.activeChange).toBe('feat-a');
    expect(summary.phase).toBe('apply');
    expect(summary.tasks).toEqual({ total: 5, done: 2 });
    expect(summary.last?.sessionId).toBe('s1');
  });
});
