import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  resolveAiHubDir,
  readAiHubRc,
  AiHubDirNotFoundError,
  AiHubRcError,
} from '../src/paths.js';

let tmp: string;
const previousEnv = process.env.AI_HUB_DIR;

async function harness(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.yaml'), 'version: 1\n');
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-paths-'));
  delete process.env.AI_HUB_DIR;
});

afterEach(async () => {
  if (previousEnv === undefined) delete process.env.AI_HUB_DIR;
  else process.env.AI_HUB_DIR = previousEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveAiHubDir', () => {
  it('usa AI_HUB_DIR cuando contiene manifest.yaml', async () => {
    const dir = path.join(tmp, 'custom');
    await harness(dir);
    process.env.AI_HUB_DIR = dir;
    const result = resolveAiHubDir(tmp);
    expect(result.source).toBe('env');
    expect(result.dir).toBe(dir);
  });

  it('falla si AI_HUB_DIR no contiene manifest.yaml', async () => {
    process.env.AI_HUB_DIR = path.join(tmp, 'missing');
    expect(() => resolveAiHubDir(tmp)).toThrow(AiHubDirNotFoundError);
  });

  it('usa el directorio de .ai-hubrc.json', async () => {
    const dir = path.join(tmp, 'harness');
    await harness(dir);
    await fs.writeFile(path.join(tmp, '.ai-hubrc.json'), JSON.stringify({ version: 1, dir: 'harness' }));
    const result = resolveAiHubDir(tmp);
    expect(result.source).toBe('rc');
    expect(result.dir).toBe(dir);
  });

  it('prefiere .ai-hub sobre ai-hub', async () => {
    await harness(path.join(tmp, '.ai-hub'));
    await harness(path.join(tmp, 'ai-hub'));
    const result = resolveAiHubDir(tmp);
    expect(result.source).toBe('dot-dir');
  });

  it('resuelve un checkout llamado ai-hub', async () => {
    const dir = path.join(tmp, 'ai-hub');
    await harness(dir);
    const result = resolveAiHubDir(tmp);
    expect(result.source).toBe('plain-dir');
    expect(result.dir).toBe(dir);
  });

  it('sube hasta el ancestro con manifest.yaml', async () => {
    const root = path.join(tmp, 'repo');
    await harness(root);
    const nested = path.join(root, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });
    const result = resolveAiHubDir(nested);
    expect(result.source).toBe('manifest-root');
    expect(result.dir).toBe(root);
  });

  it('lanza un error con las rutas probadas', async () => {
    try {
      resolveAiHubDir(tmp);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AiHubDirNotFoundError);
      expect((error as AiHubDirNotFoundError).tried.length).toBeGreaterThan(0);
    }
  });
});

describe('readAiHubRc', () => {
  it('devuelve null cuando no existe', () => {
    expect(readAiHubRc(tmp)).toBeNull();
  });

  it('rechaza un JSON inválido', async () => {
    await fs.writeFile(path.join(tmp, '.ai-hubrc.json'), '{nope');
    expect(() => readAiHubRc(tmp)).toThrow(AiHubRcError);
  });

  it('acepta la versión 2 con preset y guardMode', async () => {
    await fs.writeFile(
      path.join(tmp, '.ai-hubrc.json'),
      JSON.stringify({
        version: 2,
        preset: 'generic-ts',
        guardMode: 'enforce',
        targets: ['claude'],
      }),
    );
    const rc = readAiHubRc(tmp);
    expect(rc).toMatchObject({ version: 2, preset: 'generic-ts', guardMode: 'enforce' });
  });

  it('rechaza una versión desconocida', async () => {
    await fs.writeFile(path.join(tmp, '.ai-hubrc.json'), JSON.stringify({ version: 3 }));
    expect(() => readAiHubRc(tmp)).toThrow(AiHubRcError);
  });

  it('rechaza targets que no son lista de textos', async () => {
    await fs.writeFile(
      path.join(tmp, '.ai-hubrc.json'),
      JSON.stringify({ version: 1, targets: [1] }),
    );
    expect(() => readAiHubRc(tmp)).toThrow(AiHubRcError);
  });
});
