import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { updateManifestBlock, writeManifestText } from '../src/manifest/write.js';

/**
 * fabrica-verificable 3.1 / 3.2 (design §D4): `manifest.yaml` tiene un único escritor, atómico (temporal + rename).
 * Una interrupción deja el archivo anterior byte a byte, y ningún otro módulo de `core/src` puede escribirlo.
 */
const ORIGINAL = ['# cabecera del proyecto', 'version: 2', 'project:', '  id: demo # comentario en línea', 'targets:', '  - claude', '# pie', ''].join('\n');

let root: string;
let file: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-manifest-write-'));
  file = path.join(root, 'manifest.yaml');
  await fs.writeFile(file, ORIGINAL, 'utf8');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const leftovers = async (): Promise<string[]> => (await fs.readdir(root)).filter((name) => name !== 'manifest.yaml');
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

describe('fabrica-verificable 3.1 — escritor atómico de manifest.yaml', () => {
  it('writes the new content through a temporary file in the same directory', async () => {
    const rename = vi.spyOn(fs, 'rename');
    await writeManifestText(root, 'version: 2\nproject:\n  id: otro\n');
    expect(await fs.readFile(file, 'utf8')).toBe('version: 2\nproject:\n  id: otro\n');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(path.dirname(String(rename.mock.calls[0][0]))).toBe(root);
    expect(String(rename.mock.calls[0][1])).toBe(file);
    expect(await leftovers()).toEqual([]);
  });

  it('a failure halfway through the temporary write leaves the manifest byte-identical and no temporary file', async () => {
    const original = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
      // El proceso muere con la mitad del contenido volcado.
      await original(target as never, String(data).slice(0, Math.floor(String(data).length / 2)), options as never);
      throw errno('EIO');
    });
    await expect(writeManifestText(root, 'version: 2\nproject:\n  id: nuevo-contenido-largo\n')).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await fs.readFile(file, 'utf8')).toBe(ORIGINAL);
    expect(parseYaml(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 2 });
    expect(await leftovers()).toEqual([]);
  });

  it('a rename that keeps failing leaves the manifest byte-identical, names the file and removes the temporary file', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(errno('EPERM'));
    await expect(writeManifestText(root, 'version: 2\n')).rejects.toThrow(/manifest\.yaml/);
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    vi.restoreAllMocks();
    expect(await fs.readFile(file, 'utf8')).toBe(ORIGINAL);
    expect(await leftovers()).toEqual([]);
  });

  it.each(['EPERM', 'EBUSY'])('one transient %s at the rename is retried and the write succeeds', async (code) => {
    const real = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 1) {
        throw errno(code);
      }
      return real(from, to);
    });
    await writeManifestText(root, 'version: 2\nproject:\n  id: reintento\n');
    expect(calls).toBe(2);
    vi.restoreAllMocks();
    expect(await fs.readFile(file, 'utf8')).toContain('id: reintento');
    expect(await leftovers()).toEqual([]);
  });

  it('a block update keeps every other line, comment and key order byte-identical', async () => {
    const result = await updateManifestBlock(root, 'tracker', { kind: 'gitlab', urlEnv: 'GITLAB_URL', tokenEnv: 'GITLAB_TOKEN' });
    expect(result).toEqual({ state: 'written' });
    const text = await fs.readFile(file, 'utf8');
    for (const line of ORIGINAL.split('\n').filter((item) => item !== '')) {
      expect(text.split('\n')).toContain(line);
    }
    expect(text.indexOf('# cabecera del proyecto')).toBe(0);
    expect(text.indexOf('version: 2')).toBeLessThan(text.indexOf('project:'));
    expect(parseYaml(text)).toMatchObject({ project: { id: 'demo' }, tracker: { kind: 'gitlab', urlEnv: 'GITLAB_URL', tokenEnv: 'GITLAB_TOKEN' } });
  });

  it('a block update receives the previous value and reports unchanged without writing', async () => {
    await updateManifestBlock(root, 'control', { approvers: ['1'], pollMinutes: 7 });
    const seen: unknown[] = [];
    const before = await fs.readFile(file, 'utf8');
    const write = vi.spyOn(fs, 'writeFile');
    const result = await updateManifestBlock(root, 'control', (previous) => {
      seen.push(previous);
      return { approvers: ['1'], pollMinutes: 7 };
    });
    expect(seen).toEqual([{ approvers: ['1'], pollMinutes: 7 }]);
    expect(result).toEqual({ state: 'unchanged' });
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it.each([
    ['a sequence', '- a\n- b\n', 'no es un mapping YAML'],
    ['duplicate keys', 'version: 2\nversion: 3\n', 'tiene claves duplicadas'],
  ])('a block update on %s fails closed, names the problem and writes nothing', async (_label, text, problem) => {
    await fs.writeFile(file, text, 'utf8');
    expect(await updateManifestBlock(root, 'tracker', { kind: 'gitlab' })).toEqual({ state: 'invalid', problem });
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });

  it('a block update without a manifest reports absent', async () => {
    await fs.rm(file);
    expect(await updateManifestBlock(root, 'tracker', { kind: 'gitlab' })).toEqual({ state: 'absent' });
    expect(await leftovers()).toEqual([]);
  });
});

describe('fabrica-verificable 3.2 — ningún otro módulo escribe manifest.yaml', () => {
  it('only core/src/manifest/write.ts contains a write, append, copy or rename that targets manifest.yaml', async () => {
    const src = path.resolve(__dirname, '..', 'src');
    const WRITE = /\b(writeFile|appendFile|rename|copyFile|createWriteStream|writeFileSync|appendFileSync|renameSync)\s*\(/;
    const offenders: string[] = [];
    for (const entry of await fs.readdir(src, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) {
        continue;
      }
      const abs = path.join(entry.parentPath, entry.name);
      const rel = path.relative(src, abs).split(path.sep).join('/');
      if (rel === 'manifest/write.ts') {
        continue;
      }
      const lines = (await fs.readFile(abs, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        // La llamada puede partir sus argumentos en la línea siguiente.
        const statement = `${line} ${lines[index + 1] ?? ''}`;
        if (WRITE.test(line) && /manifest\.yaml/.test(statement) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')) {
          offenders.push(`core/src/${rel}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
