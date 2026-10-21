import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readState, writeState, StateNotFoundError, StateSchemaError } from '../src/state.js';
import type { StateV3 } from '../src/state.js';

const VALID_STATE: StateV3 = {
  version: 3,
  project: 'test-project',
  active_change: null,
  changes: [],
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-test-'));
  await fs.mkdir(path.join(tmpDir, 'openspec'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readState', () => {
  it('devuelve StateV3 cuando el archivo es válido', async () => {
    const statePath = path.join(tmpDir, 'openspec', 'state.json');
    await fs.writeFile(statePath, JSON.stringify(VALID_STATE));

    const state = await readState(tmpDir);

    expect(state.version).toBe(3);
    expect(state.active_change).toBeNull();
    expect(Array.isArray(state.changes)).toBe(true);
  });

  it('lanza StateNotFoundError cuando el archivo no existe', async () => {
    await expect(readState(tmpDir)).rejects.toThrow(StateNotFoundError);
  });

  it('lanza StateSchemaError cuando el schema es inválido (version incorrecta)', async () => {
    const statePath = path.join(tmpDir, 'openspec', 'state.json');
    await fs.writeFile(statePath, JSON.stringify({ version: 2, active_change: null, changes: [] }));

    await expect(readState(tmpDir)).rejects.toThrow(StateSchemaError);
  });

  it('lanza StateSchemaError cuando faltan campos requeridos', async () => {
    const statePath = path.join(tmpDir, 'openspec', 'state.json');
    await fs.writeFile(statePath, JSON.stringify({ version: 3 }));

    await expect(readState(tmpDir)).rejects.toThrow(StateSchemaError);
  });
});

describe('writeState', () => {
  it('escribe state.json correctamente', async () => {
    await writeState(tmpDir, VALID_STATE);

    const statePath = path.join(tmpDir, 'openspec', 'state.json');
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as StateV3;
    expect(parsed.version).toBe(3);
    expect(parsed.active_change).toBeNull();
  });

  it('el archivo temporal .tmp no queda en disco tras escritura exitosa', async () => {
    await writeState(tmpDir, VALID_STATE);

    const tmpPath = path.join(tmpDir, '.planning', 'state.json.tmp');
    await expect(fs.access(tmpPath)).rejects.toThrow();
  });

  it('lanza StateSchemaError y no escribe nada si el estado es inválido', async () => {
    const invalid = { version: 2, active_change: null, changes: [] } as unknown as StateV3;

    await expect(writeState(tmpDir, invalid)).rejects.toThrow(StateSchemaError);

    const statePath = path.join(tmpDir, 'openspec', 'state.json');
    await expect(fs.access(statePath)).rejects.toThrow();
  });

  it('permite active_change como string no nulo', async () => {
    const stateWithChange: StateV3 = { ...VALID_STATE, active_change: 'mi-cambio' };
    await writeState(tmpDir, stateWithChange);

    const result = await readState(tmpDir);
    expect(result.active_change).toBe('mi-cambio');
  });
});
