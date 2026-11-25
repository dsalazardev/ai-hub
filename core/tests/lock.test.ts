import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLock,
  canonicalTargetKey,
  inspectLock,
  LockAccessError,
  LockHeldError,
  projectLockPath,
  releaseLockExplicit,
  sharedLockPath,
  userLockDir,
  withLock,
} from '../src/harness/lock.js';
import { cmdLocks } from '../src/cli/locks.js';
import type { CliContext } from '../src/cli/types.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-lock-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const HOST = 'host-a';
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe('lock X1 (R-038)', () => {
  it('un dueño vivo hace esperar y luego fallar nombrando pid, host y propósito', async () => {
    const file = projectLockPath(dir, 'target');
    const first = await acquireLock(file, 'escribir settings', { host: HOST, pid: 100, isAlive: alive([100]) });
    let slept = 0;
    const error = await acquireLock(file, 'otro', {
      host: HOST,
      pid: 200,
      isAlive: alive([100, 200]),
      waitMs: 30,
      pollMs: 10,
      sleep: async (ms) => {
        slept += ms;
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockHeldError);
    expect((error as Error).message).toContain('pid 100 en host-a');
    expect((error as Error).message).toContain('escribir settings');
    expect(slept).toBeGreaterThan(0);
    await first.release();
    expect((await inspectLock(file)).kind).toBe('free');
  });

  it('el segundo adquiere en cuanto el primero libera (espera acotada)', async () => {
    const file = projectLockPath(dir, 'target');
    const first = await acquireLock(file, 'uno', { host: HOST, pid: 1, isAlive: alive([1, 2]) });
    // La liberación se observa: su error, si lo hay, hace fallar la prueba.
    const released = new Promise<void>((resolve, reject) => setTimeout(() => first.release().then(resolve, reject), 20));
    let slept = 0;
    const second = await acquireLock(file, 'dos', {
      host: HOST,
      pid: 2,
      isAlive: alive([1, 2]),
      waitMs: 2000,
      pollMs: 5,
      sleep: async (ms) => {
        slept += 1;
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    await released;
    expect(slept).toBeGreaterThan(0);
    expect(second.owner.pid).toBe(2);
    await second.release();
  });

  describe('EPERM al crear o leer un lock que su dueño está borrando (Windows)', () => {
    const realReadFile = fs.readFile.bind(fs);
    const epermOn = (target: string, times: number) => {
      let left = times;
      return vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === target && left > 0) {
          left -= 1;
          throw Object.assign(new Error(`EPERM: operation not permitted, open '${target}'`), { code: 'EPERM', syscall: 'open', path: target });
        }
        return realReadFile(...args);
      }) as typeof fs.readFile);
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('un EPERM transitorio seguido de la liberación real: espera y adquiere por creación exclusiva', async () => {
      const file = projectLockPath(dir, 'target');
      const first = await acquireLock(file, 'uno', { host: HOST, pid: 1, isAlive: alive([1, 2]) });
      const spy = epermOn(file, 2);
      let sleeps = 0;
      const second = await acquireLock(file, 'dos', {
        host: HOST,
        pid: 2,
        isAlive: alive([1, 2]),
        waitMs: 2000,
        pollMs: 1,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) {
            await first.release();
          }
        },
      });
      expect(sleeps).toBe(2);
      expect(second.owner.pid).toBe(2);
      expect(await realReadFile(file, 'utf8')).toContain('"pid":2');
      expect(spy.mock.calls.filter((call) => String(call[0]) === file).length).toBeGreaterThanOrEqual(3);
      await second.release();
    });

    it('un EPERM persistente agota la espera con un error que nombra el lock y lo deja intacto', async () => {
      const file = projectLockPath(dir, 'target');
      await acquireLock(file, 'uno', { host: HOST, pid: 1, isAlive: alive([1, 2]) });
      const before = await realReadFile(file, 'utf8');
      epermOn(file, Number.POSITIVE_INFINITY);
      let sleeps = 0;
      const error = await acquireLock(file, 'dos', {
        host: HOST,
        pid: 2,
        isAlive: alive([1, 2]),
        waitMs: 30,
        pollMs: 5,
        sleep: async (ms) => {
          sleeps += 1;
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      }).catch((caught: unknown) => caught);
      vi.restoreAllMocks();
      expect(error).toBeInstanceOf(LockAccessError);
      expect((error as LockAccessError).code).toBe('EPERM');
      expect((error as Error).message).toContain(file);
      expect((error as Error).message).toContain('EPERM');
      expect(sleeps).toBeGreaterThan(0);
      expect(await realReadFile(file, 'utf8')).toBe(before);
      const state = await inspectLock(file, { host: HOST, isAlive: alive([1]) });
      expect(state.kind === 'live' && state.owner.pid).toBe(1);
    });

    const realWriteFile = fs.writeFile.bind(fs);
    const epermOnCreate = (target: string, times: number) => {
      let left = times;
      return vi.spyOn(fs, 'writeFile').mockImplementation((async (...args: Parameters<typeof fs.writeFile>) => {
        const flag = (args[2] as { flag?: string } | undefined)?.flag;
        if (String(args[0]) === target && flag === 'wx' && left > 0) {
          left -= 1;
          throw Object.assign(new Error(`EPERM: operation not permitted, open '${target}'`), { code: 'EPERM', syscall: 'open', path: target });
        }
        return realWriteFile(...args);
      }) as typeof fs.writeFile);
    };

    it('un EPERM transitorio en la creación exclusiva mientras el dueño borra: espera y adquiere', async () => {
      const file = projectLockPath(dir, 'target');
      const first = await acquireLock(file, 'uno', { host: HOST, pid: 1, isAlive: alive([1, 2]) });
      epermOnCreate(file, 1);
      let sleeps = 0;
      const second = await acquireLock(file, 'dos', {
        host: HOST,
        pid: 2,
        isAlive: alive([1, 2]),
        waitMs: 2000,
        pollMs: 1,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) {
            await first.release();
          }
        },
      });
      expect(sleeps).toBe(1);
      expect(second.owner.pid).toBe(2);
      expect(await realReadFile(file, 'utf8')).toContain('"pid":2');
      await second.release();
    });

    it('un EPERM persistente en la creación exclusiva agota la espera sin crear ni borrar nada', async () => {
      const file = projectLockPath(dir, 'target');
      const first = await acquireLock(file, 'uno', { host: HOST, pid: 1, isAlive: alive([1, 2]) });
      const before = await realReadFile(file, 'utf8');
      epermOnCreate(file, Number.POSITIVE_INFINITY);
      const error = await acquireLock(file, 'dos', { host: HOST, pid: 2, isAlive: alive([1, 2]), waitMs: 30, pollMs: 5 }).catch((caught: unknown) => caught);
      vi.restoreAllMocks();
      expect(error).toBeInstanceOf(LockAccessError);
      expect((error as Error).message).toContain(file);
      expect(await realReadFile(file, 'utf8')).toBe(before);
      await first.release();
      expect((await inspectLock(file)).kind).toBe('free');
    });

    it('otro código de error se propaga en el acto, sin esperar', async () => {
      const file = projectLockPath(dir, 'target');
      await acquireLock(file, 'uno', { host: HOST, pid: 1, isAlive: alive([1, 2]) });
      vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === file) {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return realReadFile(...args);
      }) as typeof fs.readFile);
      let sleeps = 0;
      const error = await acquireLock(file, 'dos', {
        host: HOST,
        pid: 2,
        isAlive: alive([1, 2]),
        waitMs: 2000,
        pollMs: 1,
        sleep: async () => {
          sleeps += 1;
        },
      }).catch((caught: unknown) => caught);
      expect((error as NodeJS.ErrnoException).code).toBe('EIO');
      expect(error).not.toBeInstanceOf(LockAccessError);
      expect(sleeps).toBe(0);
    });
  });

  it('recupera un lock cuyo pid murió en este host', async () => {
    const file = projectLockPath(dir, 'target');
    await acquireLock(file, 'muerto', { host: HOST, pid: 300, isAlive: alive([300]) });
    const handle = await acquireLock(file, 'nuevo', { host: HOST, pid: 400, isAlive: alive([400]) });
    expect(handle.owner.purpose).toBe('nuevo');
    expect(await fs.readFile(file, 'utf8')).toContain('"pid":400');
    await handle.release();
  });

  it('no recupera un lock de otro host y nombra el comando explícito', async () => {
    const file = projectLockPath(dir, 'target');
    await acquireLock(file, 'remoto', { host: 'host-b', pid: 500, isAlive: alive([]) });
    const error = await acquireLock(file, 'local', { host: HOST, pid: 600, isAlive: alive([600]) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockHeldError);
    expect((error as LockHeldError).state.kind).toBe('foreign-host');
    expect((error as Error).message).toContain('ai-hub locks release');
    expect(await fs.readFile(file, 'utf8')).toContain('host-b');
  });

  it('un lock ilegible no se recupera solo; la liberación explícita lo retira', async () => {
    const file = projectLockPath(dir, 'target');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'no-json', 'utf8');
    await expect(acquireLock(file, 'x', { host: HOST })).rejects.toBeInstanceOf(LockHeldError);
    expect((await releaseLockExplicit(file, { host: HOST })).kind).toBe('unreadable');
    expect((await inspectLock(file)).kind).toBe('free');
  });

  it('la liberación explícita se niega con un dueño vivo de este host', async () => {
    const file = projectLockPath(dir, 'target');
    await acquireLock(file, 'vivo', { host: HOST, pid: 700, isAlive: alive([700]) });
    await expect(releaseLockExplicit(file, { host: HOST, isAlive: alive([700]) })).rejects.toBeInstanceOf(LockHeldError);
  });

  it('un recuperador interrumpido deja el lock pendiente de liberación explícita', async () => {
    const file = projectLockPath(dir, 'target');
    await acquireLock(file, 'muerto', { host: HOST, pid: 800, isAlive: alive([]) });
    await fs.writeFile(`${file}.recover`, JSON.stringify({ v: 1, pid: 801, host: HOST, startedAt: 'x', purpose: 'recover' }), 'utf8');
    const error = await acquireLock(file, 'nuevo', { host: HOST, pid: 900, isAlive: alive([900]) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockHeldError);
    expect((error as LockHeldError).file).toBe(`${file}.recover`);
  });

  it('dos proyectos que cambian el mismo config.yaml de un perfil comparten el lock del usuario y conservan ambos cambios', async () => {
    const env = { AI_HUB_LOCK_DIR: path.join(dir, 'user-locks') } as NodeJS.ProcessEnv;
    const profile = path.join(dir, 'hermes', 'profiles', 'hermes-control');
    await fs.mkdir(profile, { recursive: true });
    const config = path.join(profile, 'config.yaml');
    await fs.writeFile(config, '{}', 'utf8');
    const fromA = await canonicalTargetKey(path.join(dir, 'hermes', 'profiles', '.', 'hermes-control', 'config.yaml'));
    const fromB = await canonicalTargetKey(path.join(profile, '..', 'hermes-control', 'config.yaml'));
    expect(sharedLockPath(fromA, env)).toBe(sharedLockPath(fromB, env));
    const update = (key: string, pid: number) =>
      withLock(
        sharedLockPath(fromA, env),
        `proyecto ${key}`,
        async () => {
          const data = JSON.parse(await fs.readFile(config, 'utf8')) as Record<string, string>;
          await new Promise((resolve) => setTimeout(resolve, 15));
          data[key] = 'ok';
          await fs.writeFile(config, JSON.stringify(data), 'utf8');
        },
        { host: HOST, pid, isAlive: alive([1, 2]), waitMs: 5000, pollMs: 5 },
      );
    await Promise.all([update('a', 1), update('b', 2)]);
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ a: 'ok', b: 'ok' });
  });

  it('el directorio de locks del usuario sigue XDG en POSIX y LOCALAPPDATA en Windows', () => {
    expect(userLockDir({ XDG_STATE_HOME: '/s' } as NodeJS.ProcessEnv, 'linux', '/home/u')).toBe(path.join('/s', 'ai-hub', 'locks'));
    expect(userLockDir({} as NodeJS.ProcessEnv, 'linux', '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'ai-hub', 'locks'));
    expect(userLockDir({ LOCALAPPDATA: 'C:\\L' } as NodeJS.ProcessEnv, 'win32', 'C:\\U')).toBe(path.join('C:\\L', 'ai-hub', 'locks'));
  });

  it('ai-hub locks release exige --yes y libera un lock ajeno a este host', async () => {
    const file = projectLockPath(dir, 'target');
    await acquireLock(file, 'remoto', { host: 'host-b', pid: 1, isAlive: alive([]) });
    const out: string[] = [];
    const err: string[] = [];
    const ctx = { cwd: dir, root: dir, source: null, io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) } } as unknown as CliContext;
    expect(await cmdLocks({ positionals: ['release', file], flags: {} }, ctx)).toBe(2);
    expect(await cmdLocks({ positionals: ['release', file], flags: { yes: true } }, ctx)).toBe(0);
    expect(out.join('\n')).toContain('foreign-host');
    expect((await inspectLock(file)).kind).toBe('free');
  });
});
