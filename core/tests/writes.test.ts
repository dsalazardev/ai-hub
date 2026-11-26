import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveSensitivity, externalTarget, findTarget, requireTarget, secretLikeKeys, UndeclaredTargetError } from '../src/writes/targets.js';
import { listCaptures, lockFor, releaseCapture, SimulatedCrash, transactWrite, type WriteRequest } from '../src/writes/transaction.js';
import { acquireLock, inspectLock, LockHeldError } from '../src/harness/lock.js';
import { detectSyncedFolder, resolvePrivateStorage, type PrivateStorageHost } from '../src/writes/private-storage.js';

const SENTINEL = 'sentinel-7f3a9c1e-not-a-real-token';
let root: string;
let privateDir: string;
const USER_SID = 'S-1-5-21-1-2-3-1001';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-writes-'));
  privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-private-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(privateDir, { recursive: true, force: true });
});

/** Host de almacenamiento privado determinista: ACL solo con el usuario y SYSTEM. */
function okHost(env: NodeJS.ProcessEnv = {}): PrivateStorageHost {
  return { platform: 'win32', env: { AI_HUB_PRIVATE_DIR: privateDir, ...env }, userSid: () => USER_SID, readAcl: () => [{ sid: USER_SID, allow: true }, { sid: 'S-1-5-18', allow: true }] };
}

const lock = { host: 'h', pid: 4242, isAlive: (pid: number) => pid === 4242, waitMs: 5000, pollMs: 5 };

function request(rel: string, transform: WriteRequest['transform'], extra: Partial<WriteRequest> = {}): WriteRequest {
  return { root, file: path.join(root, ...rel.split('/')), module: 'test', transform, lock, privateHost: okHost(), env: {}, ...extra };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await filesUnder(dir)) {
    if ((await fs.readFile(file, 'utf8')).includes(needle)) {
      hits.push(path.relative(dir, file));
    }
  }
  return hits;
}

describe('registro de destinos (3.2, R-031)', () => {
  it('un destino no declarado falla nombrando módulo y destino', () => {
    expect(() => requireTarget('cli/nuevo.ts', 'misterio/config.toml')).toThrow(UndeclaredTargetError);
    expect(() => requireTarget('cli/nuevo.ts', 'misterio/config.toml')).toThrow(/misterio\/config.toml.*cli\/nuevo.ts/);
  });

  it('una clave con nombre de token eleva a sensible sin exponer valores', () => {
    const gitignore = findTarget('.gitignore');
    expect(gitignore?.sensitivity).toBe('internal');
    const content = `{"api_key": "${SENTINEL}"}`;
    expect(effectiveSensitivity(gitignore!, content)).toBe('sensitive');
    expect(secretLikeKeys(content)).toEqual(['api_key']);
    expect(JSON.stringify(secretLikeKeys(content))).not.toContain(SENTINEL);
  });

  it('un generado con credenciales es regenerable y sensible a la vez', () => {
    const mcp = findTarget('.mcp.json');
    expect(mcp).toMatchObject({ ownership: 'generated', sensitivity: 'sensitive', regenerable: true });
    expect(findTarget('.ai-hub/runs/control/state/associations.json')?.id).toBe('durable-state');
    expect(findTarget('sub/AGENTS.md')?.id).toBe('region-files');
  });
});

describe('transacción X2 (3.3, R-034–R-036)', () => {
  const STATE = '.ai-hub/runs/control/state/data.json';

  it('bytes iguales: no escribe ni copia', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'node_modules/\n');
    const before = (await fs.stat(file)).mtimeMs;
    const result = await transactWrite(request('.gitignore', (current) => current ?? ''));
    expect(result.status).toBe('unchanged');
    expect((await fs.stat(file)).mtimeMs).toBe(before);
    // Solo el directorio de locks del motor (estado), ninguna copia ni temporal.
    expect((await fs.readdir(root)).filter((name) => name !== '.ai-hub')).toEqual(['.gitignore']);
  });

  it('dos escritores del motor con claves distintas conservan ambas', async () => {
    const add = (key: string) =>
      transactWrite(
        request(STATE, async (current) => {
          const data = current ? (JSON.parse(current) as Record<string, string>) : {};
          await new Promise((resolve) => setTimeout(resolve, 20));
          return JSON.stringify({ ...data, [key]: 'ok' });
        }),
      );
    const [a, b] = await Promise.all([add('a'), add('b')]);
    expect([a.status, b.status]).toEqual(['written', 'written']);
    expect(JSON.parse(await fs.readFile(path.join(root, STATE), 'utf8'))).toEqual({ a: 'ok', b: 'ok' });
  });

  it('una edición externa durante la transformación se conserva y se recalcula', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'a\n');
    const result = await transactWrite(
      request('.gitignore', (current) => `${current}engine\n`, {
        hooks: {
          afterRead: async (attempt) => {
            if (attempt === 1) {
              await fs.writeFile(file, 'a\nperson\n');
            }
          },
        },
      }),
    );
    expect(result).toMatchObject({ status: 'written', attempts: 2 });
    expect(await fs.readFile(file, 'utf8')).toBe('a\nperson\nengine\n');
  });

  it('con un lock ya tomado que cubre el destino no toma uno por archivo ni lo suelta, y conserva la última comprobación', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'a\n');
    const alive = (pid: number) => pid === 4242 || pid === 5151;
    const base = request('.gitignore', (current) => `${current}engine\n`, { lock: { ...lock, isAlive: alive, waitMs: 0 } });
    // El lock por archivo lo tiene otro dueño vivo: sin el lock del llamador, la escritura no se haría.
    const perFile = await acquireLock(await lockFor(base, requireTarget('test', '.gitignore')), 'otro escritor', { host: 'h', pid: 5151, isAlive: alive });
    await expect(transactWrite(base)).rejects.toBeInstanceOf(LockHeldError);
    expect(await fs.readFile(file, 'utf8')).toBe('a\n');
    const held = await acquireLock(path.join(root, 'sync-targets.lock'), 'sync', { host: 'h', pid: 4242, isAlive: alive });
    const result = await transactWrite({
      ...base,
      heldLock: held,
      hooks: {
        afterRead: async (attempt) => {
          if (attempt === 1) {
            await fs.writeFile(file, 'a\nperson\n');
          }
        },
      },
    });
    // La edición externa se detecta en la última comprobación y se recalcula, igual que con el lock por archivo.
    expect(result).toMatchObject({ status: 'written', attempts: 2 });
    expect(await fs.readFile(file, 'utf8')).toBe('a\nperson\nengine\n');
    expect((await inspectLock(held.file, { host: 'h', isAlive: alive })).kind).toBe('live');
    await held.release();
    await perFile.release();
  });

  it('contención en cada comprobación agota los intentos sin reemplazar ni dejar temporales', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'x\n');
    let n = 0;
    const result = await transactWrite(
      request('.gitignore', (current) => `${current}engine\n`, {
        hooks: {
          beforeLastCheck: async () => {
            n += 1;
            await fs.writeFile(file, `x\nedit-${n}\n`);
          },
        },
      }),
    );
    expect(result).toMatchObject({ status: 'stopped', reason: 'write_contention', attempts: 3 });
    expect(await fs.readFile(file, 'utf8')).toBe('x\nedit-3\n');
    expect((await fs.readdir(root)).filter((name) => name.includes('ai-hub-tmp'))).toEqual([]);
  });

  it('proceso terminado antes del reemplazo: original y copia intactos, temporal informado y lock recuperado', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'original\n');
    const crashLock = { host: 'h', pid: 9999, isAlive: () => false, waitMs: 1000, pollMs: 5 };
    await expect(
      transactWrite(
        request('.gitignore', () => 'nuevo\n', {
          lock: crashLock,
          hooks: {
            afterLastCheck: () => {
              throw new SimulatedCrash('kill');
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await fs.readFile(file, 'utf8')).toBe('original\n');
    expect(await fs.readFile(`${file}.pre-ai-hub`, 'utf8')).toBe('original\n');
    const next = await transactWrite(request('.gitignore', () => 'nuevo\n', { lock: { ...crashLock, pid: 10000, isAlive: (pid: number) => pid === 10000 } }));
    expect(next.status).toBe('written');
    expect(next.leftoverTemps).toHaveLength(1);
    expect(next.leftoverTemps[0]).toContain('.gitignore.ai-hub-tmp-');
    expect(await fs.readFile(file, 'utf8')).toBe('nuevo\n');
  });

  it('fallo del rename: original y copia intactos', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'original\n');
    const failing = async () => {
      const error = new Error('disco lleno') as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      throw error;
    };
    await expect(transactWrite(request('.gitignore', () => 'nuevo\n', { hooks: { rename: failing } }))).rejects.toThrow('disco lleno');
    expect(await fs.readFile(file, 'utf8')).toBe('original\n');
    expect(await fs.readFile(`${file}.pre-ai-hub`, 'utf8')).toBe('original\n');
    expect((await fs.readdir(root)).filter((name) => name.includes('ai-hub-tmp'))).toEqual([]);
  });
});

describe('retención de copias (3.5, R-037)', () => {
  it('la sexta escritura deja cinco copias y poda solo tras verificar', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'v0\n');
    for (let index = 1; index <= 6; index += 1) {
      const result = await transactWrite(request('.gitignore', () => `v${index}\n`, { capture: false }));
      expect(result.status).toBe('written');
    }
    const backups = (await fs.readdir(root)).filter((name) => name.startsWith('.gitignore.pre-ai-hub')).sort();
    expect(backups).toHaveLength(5);
    expect(await fs.readFile(path.join(root, '.gitignore.pre-ai-hub.5'), 'utf8')).toBe('v5\n');
    expect(backups).not.toContain('.gitignore.pre-ai-hub');
  });

  it('una escritura fallida o con pérdida detectada no poda copias ni capturas', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'v0\n');
    for (let index = 1; index <= 5; index += 1) {
      await transactWrite(request('.gitignore', () => `v${index}\n`, { capture: false }));
    }
    const failing = async () => {
      throw Object.assign(new Error('x'), { code: 'EIO' });
    };
    await expect(transactWrite(request('.gitignore', () => 'v6\n', { hooks: { rename: failing }, capture: false }))).rejects.toThrow();
    expect((await fs.readdir(root)).filter((name) => name.startsWith('.gitignore.pre-ai-hub'))).toHaveLength(6);
    const detected = await transactWrite(
      request('.gitignore', () => 'v7\n', {
        hooks: { afterLastCheck: () => fs.writeFile(file, 'externo-en-el-sitio\n') },
      }),
    );
    expect(detected).toMatchObject({ status: 'written', capture: { status: 'external_write_detected' }, pruned: [] });
    expect((await fs.readdir(root)).filter((name) => name.startsWith('.gitignore.pre-ai-hub'))).toHaveLength(7);
  });
});

describe('almacenamiento privado validado (3.6, R-039)', () => {
  it('sin configuración se detiene y nombra la variable', async () => {
    const result = await resolvePrivateStorage(root, { platform: 'win32', env: {} });
    expect(result).toMatchObject({ ok: false, reason: 'private_storage_unconfigured' });
    expect(JSON.stringify(result)).toContain('AI_HUB_PRIVATE_DIR');
  });

  it('una ubicación sincronizada o dentro del repositorio se rechaza', async () => {
    const synced = await resolvePrivateStorage(root, { ...okHost(), env: { AI_HUB_PRIVATE_DIR: path.join(privateDir, 'OneDrive', 'p') } });
    expect(synced).toMatchObject({ ok: false, reason: 'private_storage_invalid' });
    const inRepo = await resolvePrivateStorage(root, { ...okHost(), env: { AI_HUB_PRIVATE_DIR: path.join(root, 'p') } });
    expect(inRepo).toMatchObject({ ok: false, reason: 'private_storage_invalid' });
    expect(detectSyncedFolder('C:\\Users\\u\\OneDrive - Empresa\\x', {})).not.toBeNull();
  });

  it('una lista de acceso ilegible o con identidades ajenas se rechaza', async () => {
    const unreadable = await resolvePrivateStorage(root, { ...okHost(), readAcl: () => null });
    expect(unreadable).toMatchObject({ ok: false, reason: 'private_storage_invalid' });
    const foreign = await resolvePrivateStorage(root, { ...okHost(), readAcl: () => [{ sid: USER_SID, allow: true }, { sid: 'S-1-1-0', allow: true }] });
    expect(foreign).toMatchObject({ ok: false, reason: 'private_storage_invalid' });
    expect(await resolvePrivateStorage(root, okHost())).toEqual({ ok: true, dir: path.resolve(privateDir) });
  });

  it.skipIf(process.platform === 'win32')('POSIX exige modo 700', async () => {
    await fs.chmod(privateDir, 0o755);
    const lax = await resolvePrivateStorage(root, { platform: process.platform, env: { AI_HUB_PRIVATE_DIR: privateDir } });
    expect(lax).toMatchObject({ ok: false, reason: 'private_storage_invalid' });
    await fs.chmod(privateDir, 0o700);
    expect(await resolvePrivateStorage(root, { platform: process.platform, env: { AI_HUB_PRIVATE_DIR: privateDir }, uid: () => process.getuid!() })).toMatchObject({ ok: true });
  });

  it.runIf(process.platform === 'win32')('Windows real: la ACL de la carpeta se lee por SID', async () => {
    const result = await resolvePrivateStorage(root, { ...(await import('../src/writes/private-storage.js')).defaultHost(), env: { AI_HUB_PRIVATE_DIR: privateDir } });
    expect(result.ok).toBe(true);
  });
});

describe('custodia por sensibilidad (3.7, R-032)', () => {
  it('config.yaml de Hermes con secreto en línea: copia solo en almacenamiento privado', async () => {
    const profile = path.join(root, 'hermes-home', 'profiles', 'default');
    await fs.mkdir(profile, { recursive: true });
    const config = path.join(profile, 'config.yaml');
    await fs.writeFile(config, `model: x\nplatforms:\n  discord:\n    token: ${SENTINEL}\n`);
    const result = await transactWrite({
      root,
      file: config,
      module: 'control/webhook-config.ts',
      target: externalTarget('hermes-profile-config'),
      transform: (current) => `${current}platforms_webhook: true\n`,
      lock,
      privateHost: okHost(),
      env: { AI_HUB_LOCK_DIR: path.join(root, 'locks') },
    });
    expect(result).toMatchObject({ status: 'written', capture: { status: 'external_guard_reduced' } });
    expect(await grepTree(profile, SENTINEL)).toEqual(['config.yaml']);
    expect(await grepTree(privateDir, SENTINEL)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('settings de Claude con un secreto en env: sin copia adyacente ni centinela en el informe', async () => {
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    const file = path.join(root, '.claude', 'settings.json');
    await fs.writeFile(file, JSON.stringify({ env: { GITLAB_TOKEN: SENTINEL } }));
    const result = await transactWrite(request('.claude/settings.json', (current) => JSON.stringify({ ...JSON.parse(current!), hooks: {} })));
    expect(result.status).toBe('written');
    expect(await fs.readdir(path.join(root, '.claude'))).toEqual(['settings.json']);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('MCP generado con credencial: al regenerarse no queda copia fuera del almacenamiento privado', async () => {
    const file = path.join(root, '.mcp.json');
    await fs.writeFile(file, JSON.stringify({ servers: { a: { env: { TOKEN: SENTINEL } } } }));
    const result = await transactWrite(request('.mcp.json', () => JSON.stringify({ servers: { a: { env: { TOKEN: SENTINEL } }, b: {} } })));
    expect(result.status).toBe('written');
    expect(await grepTree(root, SENTINEL)).toEqual(['.mcp.json']);
  });

  it('sin almacenamiento privado, un destino sensible se detiene sin escribir', async () => {
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    const file = path.join(root, '.claude', 'settings.json');
    await fs.writeFile(file, '{}');
    const result = await transactWrite(request('.claude/settings.json', () => '{"a":1}', { privateHost: { platform: 'win32', env: {} } }));
    expect(result).toMatchObject({ status: 'stopped', reason: 'private_storage_unconfigured' });
    expect(await fs.readFile(file, 'utf8')).toBe('{}');
  });
});

describe('captura y detección posterior (3.23, R-105)', () => {
  it('escritura externa en el sitio tras la última comprobación: la captura la conserva', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'base\n');
    const result = await transactWrite(request('.gitignore', () => 'engine\n', { hooks: { afterLastCheck: () => fs.writeFile(file, 'externo\n') } }));
    expect(result).toMatchObject({ status: 'written', capture: { status: 'external_write_detected' } });
    const capture = (result as { capture: { file: string } }).capture.file;
    expect(await fs.readFile(capture, 'utf8')).toBe('externo\n');
    expect(await fs.readFile(file, 'utf8')).toBe('engine\n');
  });

  it('reemplazo externo por rename tras la última comprobación: no se informa como protegido (riesgo residual)', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'base\n');
    const result = await transactWrite(
      request('.gitignore', () => 'engine\n', {
        hooks: {
          afterLastCheck: async () => {
            await fs.writeFile(path.join(root, 'other.tmp'), 'externo-por-rename\n');
            await fs.rename(path.join(root, 'other.tmp'), file);
          },
        },
      }),
    );
    expect(result.status).toBe('written');
    const capture = (result as { capture: { status: string } }).capture.status;
    expect(capture).not.toBe('external_write_detected');
    expect(['no_inplace_change', 'external_guard_reduced']).toContain(capture);
    // La edición externa se perdió: es la ventana declarada en D-58, no una protección.
    expect(await fs.readFile(file, 'utf8')).toBe('engine\n');
  });

  it('carpeta sincronizada detectada o destino sensible: sin captura y external_guard_reduced', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'base\n');
    const result = await transactWrite(request('.gitignore', () => 'engine\n', { env: { OneDrive: root } }));
    expect(result).toMatchObject({ status: 'written', capture: { status: 'external_guard_reduced' } });
    expect(await listCaptures(file)).toEqual([]);
  });

  it('cupo reservado antes de la última comprobación: con tres capturas no se reemplaza; liberar devuelve la plaza', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'base\n');
    for (let index = 0; index < 3; index += 1) {
      await transactWrite(request('.gitignore', () => `engine-${index}\n`, { hooks: { afterLastCheck: () => fs.writeFile(file, `ext-${index}\n`) } }));
    }
    expect(await listCaptures(file)).toHaveLength(3);
    const full = await transactWrite(request('.gitignore', () => 'nuevo\n'));
    expect(full).toMatchObject({ status: 'stopped', reason: 'capture_quota_full' });
    expect(await fs.readFile(file, 'utf8')).toBe('engine-2\n');
    await releaseCapture((await listCaptures(file))[0]);
    expect((await transactWrite(request('.gitignore', () => 'nuevo\n'))).status).toBe('written');
  });

  it('rename fallido una vez con edición externa antes del reintento: se recalcula y cuenta en el límite', async () => {
    const file = path.join(root, '.gitignore');
    await fs.writeFile(file, 'base\n');
    let calls = 0;
    const flaky = async (from: string, to: string) => {
      calls += 1;
      if (calls === 1) {
        await fs.writeFile(file, 'base\nperson\n');
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      await fs.rename(from, to);
    };
    const result = await transactWrite(request('.gitignore', (current) => `${current}engine\n`, { hooks: { rename: flaky }, capture: false }));
    expect(result).toMatchObject({ status: 'written', attempts: 3 });
    expect(await fs.readFile(file, 'utf8')).toBe('base\nperson\nengine\n');
  });
});

describe('lock de destinos externos (3.11)', () => {
  it('un destino externo con root en su propio directorio no crea .ai-hub dentro del directorio ajeno', async () => {
    const profile = path.join(root, 'profile');
    await fs.mkdir(profile);
    const file = path.join(profile, 'SOUL.md');
    await fs.writeFile(file, 'old\n', 'utf8');
    const result = await transactWrite({
      root: profile,
      file,
      module: 'control/identity.ts',
      target: externalTarget('hermes-profile-soul'),
      retention: 0,
      capture: false,
      transform: () => 'new\n',
    });
    expect(result.status).toBe('written');
    expect(await fs.readFile(file, 'utf8')).toBe('new\n');
    expect((await fs.readdir(profile)).sort()).toEqual(['SOUL.md']);
  });
});

describe('nombre de captura ignorado por init (3.23, R-105)', () => {
  it('el .gitignore que crea init ignora las capturas junto a cualquier destino y no los propios destinos', async () => {
    const { spawnSync } = await import('node:child_process');
    const { ensureProjectIgnores } = await import('../src/cli/onboarding.js');
    expect(spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true }).status).toBe(0);
    expect(await ensureProjectIgnores(root)).toEqual([]);
    const ignored = (file: string): boolean => spawnSync('git', ['check-ignore', '-q', file], { cwd: root, windowsHide: true }).status === 0;
    expect(ignored('AGENTS.md.ai-hub-capture-20261123-1')).toBe(true);
    expect(ignored('docs/AGENTS.md.ai-hub-capture-20261123-2')).toBe(true);
    expect(ignored('AGENTS.md')).toBe(false);
  });
});

describe('comando de liberación de capturas (3.23, R-105)', () => {
  it('captures list cuenta las plazas y release --yes libera solo capturas del motor', async () => {
    const { runCli } = await import('../src/cli/run.js');
    const { CAPTURE_QUOTA } = await import('../src/writes/transaction.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-captures-'));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
      const run = (argv: string[]) => runCli(argv, { cwd: dir, io } as never);
      await fs.writeFile(path.join(dir, 'destino.txt'), 'actual\n');
      const capture = 'destino.txt.ai-hub-capture-20261123T100000Z-abc';
      await fs.writeFile(path.join(dir, capture), 'externo\n');
      expect(await run(['captures', 'list', 'destino.txt'])).toBe(0);
      expect(out.join('\n')).toContain(`1 de ${CAPTURE_QUOTA}`);
      expect(await run(['captures', 'release', capture])).toBe(2);
      expect(await run(['captures', 'release', 'destino.txt', '--yes'])).toBe(1);
      expect(await fs.readFile(path.join(dir, 'destino.txt'), 'utf8')).toBe('actual\n');
      expect(await run(['captures', 'release', capture, '--yes'])).toBe(0);
      await expect(fs.access(path.join(dir, capture))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
