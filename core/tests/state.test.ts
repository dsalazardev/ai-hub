import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  emptyState,
  readState,
  writeState,
  migrateLegacyState,
  StateNotFoundError,
  StateSchemaError,
} from '../src/harness/memory/state.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-state-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('project state', () => {
  it('writes and reads a valid state', async () => {
    const state = emptyState('demo', 'generic-ts');
    await writeState(root, { ...state, activeChange: 'feat-a', phase: 'apply', tasks: { total: 3, done: 1 } });
    const read = await readState(root);
    expect(read.project).toBe('demo');
    expect(read.activeChange).toBe('feat-a');
    expect(read.tasks).toEqual({ total: 3, done: 1 });
  });

  it('fails when state.json is missing', async () => {
    await expect(readState(root)).rejects.toThrow(StateNotFoundError);
  });

  it('rejects an invalid state with the field name', async () => {
    await fs.mkdir(path.join(root, '.planning'), { recursive: true });
    await fs.writeFile(path.join(root, '.planning', 'state.json'), JSON.stringify({ version: 1 }));
    await expect(readState(root)).rejects.toThrow(StateSchemaError);
    await expect(readState(root)).rejects.toThrow(/project/);
  });

  it('migrates a legacy state into .planning', async () => {
    await fs.mkdir(path.join(root, 'openspec', 'changes', 'demo'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'openspec', 'state.json'),
      JSON.stringify({
        version: 3,
        active_change: 'demo',
        changes: [{ name: 'demo', phase: 'implementing' }],
      }),
    );
    await fs.writeFile(
      path.join(root, 'openspec', 'changes', 'demo', 'tasks.md'),
      '- [x] one\n- [ ] two\n',
    );
    const migrated = await migrateLegacyState(root, 'demo', 'generic-ts');
    expect(migrated?.activeChange).toBe('demo');
    expect(migrated?.phase).toBe('implementing');
    expect(migrated?.tasks).toEqual({ total: 2, done: 1 });
    expect((await readState(root)).activeChange).toBe('demo');
  });
});
