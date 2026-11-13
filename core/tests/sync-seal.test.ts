import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runSync, sealLock, SyncSourceCheckoutError } from '../src/sync/sync.js';
import { harness, type Harness } from './control-harness.js';

/**
 * fabrica-verificable 4.1 (design §D5): sellar el lock no escribe destinos. Renderiza en memoria, reutiliza `buildLock`
 * y, si ningún hash de destino cambia, escribe solo `sync.lock.json`. Si alguno cambia, no sella y devuelve cuántos.
 */
let h: Harness;

beforeEach(async () => {
  h = await harness();
  // El consumidor del arnés añade `tracker` al manifiesto después de `init`: el lock queda con el hash viejo.
  await h.consumer({ control: false });
});

afterEach(async () => {
  await h.dispose();
});

const lockFile = (): string => path.join(h.root, 'sync.lock.json');
const readLockJson = async (): Promise<{ sources: Record<string, string>; files: Record<string, { sha256: string; source: string; region?: string }> }> =>
  JSON.parse(await fs.readFile(lockFile(), 'utf8'));

/** Huella (contenido y fecha de modificación) de todos los destinos del lock. */
async function targetsFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of Object.keys((await readLockJson()).files).sort()) {
    const abs = path.join(h.root, rel);
    hash.update(rel);
    hash.update(await fs.readFile(abs));
    hash.update(String((await fs.stat(abs)).mtimeMs));
  }
  return hash.digest('hex');
}

async function plainTarget(): Promise<string> {
  const lock = await readLockJson();
  const rel = Object.keys(lock.files).find((name) => lock.files[name].region === undefined && name.endsWith('.md'));
  expect(rel).toBeDefined();
  return rel!;
}

describe('fabrica-verificable 4.1 — sealLock', () => {
  it('only the manifest changed: no target is written, the lock records the new manifest hash and check-lock exits 0', async () => {
    expect((await h.cli(['sync', '--check-lock'])).code).toBe(1);
    const before = await targetsFingerprint();
    const staleManifestHash = (await readLockJson()).sources['manifest.yaml'];
    const result = await sealLock(h.root);
    expect(result).toEqual({ sealed: true, differing: 0 });
    expect(await targetsFingerprint()).toBe(before);
    expect((await readLockJson()).sources['manifest.yaml']).not.toBe(staleManifestHash);
    const check = await h.cli(['sync', '--check-lock']);
    expect(check.code, check.out + check.err).toBe(0);
  }, 60_000);

  it('a hand-edited target survives the seal and drift still reports it', async () => {
    const rel = await plainTarget();
    const edited = `${await fs.readFile(path.join(h.root, rel), 'utf8')}\nEDICION-LOCAL-DEL-OPERADOR\n`;
    await fs.writeFile(path.join(h.root, rel), edited);
    expect((await sealLock(h.root)).sealed).toBe(true);
    expect(await fs.readFile(path.join(h.root, rel), 'utf8')).toBe(edited);
    const drift = await runSync(h.root, { check: true });
    expect(drift.problems.join('\n')).toContain(`editado a mano: ${rel}`);
  }, 60_000);

  it('a change that alters a rendered target seals nothing and returns how many targets differ', async () => {
    await sealLock(h.root);
    const lock = await readLockJson();
    const rel = Object.keys(lock.files).find((name) => lock.files[name].source.startsWith('.ai-hub/') && lock.files[name].region === undefined);
    expect(rel).toBeDefined();
    await fs.appendFile(path.join(h.root, lock.files[rel!].source), '\nLinea nueva en la fuente.\n');
    const lockBefore = await fs.readFile(lockFile());
    const before = await targetsFingerprint();
    const result = await sealLock(h.root);
    expect(result.sealed).toBe(false);
    expect(result.differing).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(lockFile())).toEqual(lockBefore);
    expect(await targetsFingerprint()).toBe(before);
  }, 60_000);

  it('the sealed lock is byte-identical to the one a full sync writes', async () => {
    expect((await sealLock(h.root)).sealed).toBe(true);
    const sealed = await fs.readFile(lockFile());
    await runSync(h.root, { check: false });
    expect(await fs.readFile(lockFile())).toEqual(sealed);
  }, 60_000);

  it('without a previous lock nothing is sealed', async () => {
    await fs.rm(lockFile());
    const result = await sealLock(h.root);
    expect(result.sealed).toBe(false);
    expect(result.differing).toBeGreaterThan(0);
    await expect(fs.access(lockFile())).rejects.toThrow();
  }, 60_000);

  it('refuses the engine checkout like sync does', async () => {
    await expect(sealLock(path.resolve(__dirname, '..', '..'))).rejects.toBeInstanceOf(SyncSourceCheckoutError);
  });
});
