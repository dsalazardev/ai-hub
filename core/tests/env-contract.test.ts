import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli, createContext } from '../src/cli/run.js';
import { parseArgs } from '../src/cli/args.js';
import { cmdInit } from '../src/cli/onboarding.js';
import { offerTrackerStep, runTrackerStep, type AssistantPrompts } from '../src/cli/assistant.js';
import { parse as parseYaml } from 'yaml';
import { checkEnvIgnored, checkEnvKeys, checkTrackerToken, type FetchLike } from '../src/env/doctor.js';
import { parseDotenv } from '../src/env/dotenv.js';
import { createBackup } from '../src/backup/snapshots.js';
import { gitHookScript, FAIL_OPEN_PREFIX } from '../src/cli/githooks.js';
import { shellCandidates } from '../src/speckit/commands.js';
import type { SpeckitSettings } from '../src/speckit/settings.js';
import type { ProjectManifest } from '../src/manifest/manifest.js';
import type { CliIO } from '../src/cli/types.js';
import { fakeRunner } from './speckit-fake.js';
import { gitUnavailable, runGit } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, '..');

/** Centinela (PD-1): un valor falso que jamás debe aparecer en ninguna salida. */
const SENTINEL = 'AIHUB_TEST_SENTINEL_9f3c1e7a';
const GIT = gitUnavailable();

let root: string;

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

async function cli(argv: string[], cwd = root): Promise<{ code: number; out: string; err: string }> {
  const sink = capture();
  const code = await runCli(argv, { cwd, io: sink.io, exec: fakeRunner().run });
  return { code, out: sink.out.join('\n'), err: sink.err.join('\n') };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function checkIgnore(rel: string): number {
  return spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, shell: false }).status ?? 1;
}

async function initConsumer(extra: string[] = []): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  const result = await cli(['init', '--preset-only', '--yes', ...extra]);
  expect(result.code, result.err).toBe(0);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-env-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('PD-1: ignores and example (2.2, 2.3)', () => {
  it.skipIf(GIT !== null)('init ignores .ai-hub/.env and runs/, keeps the example and user rules', async () => {
    runGit(['init', '-q'], root);
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await initConsumer();
    const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(ignore.startsWith('node_modules/\n')).toBe(true);
    expect(checkIgnore('.ai-hub/.env')).toBe(0);
    expect(checkIgnore('.ai-hub/runs/r1/events.jsonl')).toBe(0);
    expect(checkIgnore('.ai-hub/.env.example')).toBe(1);
    expect(checkIgnore('.ai-hub/manifest.json')).toBe(1);
  });

  it('init writes only the example with CHANGEME values and never a .env', async () => {
    await initConsumer();
    const example = await fs.readFile(path.join(root, '.ai-hub', '.env.example'), 'utf8');
    expect(parseDotenv(example)).toEqual({ GITLAB_URL: 'CHANGEME', GITLAB_TOKEN: 'CHANGEME' });
    expect(await exists(path.join(root, '.ai-hub', '.env'))).toBe(false);
  });

  it('install leaves an existing .env byte for byte and never prints it', async () => {
    await initConsumer();
    const envFile = path.join(root, '.ai-hub', '.env');
    const content = `GITLAB_URL=https://tracker.example.test\nGITLAB_TOKEN=${SENTINEL}\n`;
    await fs.writeFile(envFile, content, 'utf8');
    const result = await cli(['install', '--yes', '--no-speckit']);
    expect(result.code, result.err).toBe(0);
    expect(await fs.readFile(envFile, 'utf8')).toBe(content);
    expect(`${result.out}\n${result.err}`).not.toContain(SENTINEL);
  });

  it('snapshots never copy the credentials file', async () => {
    await initConsumer();
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `GITLAB_TOKEN=${SENTINEL}\n`, 'utf8');
    const record = await createBackup(root, 'probe');
    expect(record.files).not.toContain('.ai-hub/.env');
    expect(record.files).toContain('.ai-hub/.env.example');
    const listing = await fs.readdir(path.join(root, '.backups'), { recursive: true });
    for (const rel of listing) {
      const abs = path.join(root, '.backups', rel);
      if ((await fs.stat(abs)).isFile()) {
        expect(await fs.readFile(abs, 'utf8'), rel).not.toContain(SENTINEL);
      }
    }
  });
});

describe('env exec (2.4)', () => {
  const node = process.execPath;

  it('the child inherits the harness variables', async () => {
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `AIHUB_PROBE=${SENTINEL}\n`, 'utf8');
    const result = await cli([
      'env',
      'exec',
      '--',
      node,
      '-e',
      `process.exit(process.env.AIHUB_PROBE === '${SENTINEL}' ? 0 : 3)`,
    ]);
    expect(result.code).toBe(0);
    expect(`${result.out}\n${result.err}`).not.toContain(SENTINEL);
  });

  it('without .env the command runs unchanged and its code propagates', async () => {
    const result = await cli(['env', 'exec', '--', node, '-e', 'process.exit(7)']);
    expect(result.code).toBe(7);
    expect(await exists(path.join(root, '.ai-hub'))).toBe(false);
  });

  it('a failing child does not leak values', async () => {
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `GITLAB_TOKEN=${SENTINEL}\n`, 'utf8');
    const result = await cli(['env', 'exec', '--', node, '-e', 'process.exit(5)']);
    expect(result.code).toBe(5);
    expect(`${result.out}\n${result.err}`).not.toContain(SENTINEL);
  });

  it('child flags after -- are passed through untouched', async () => {
    const result = await cli(['env', 'exec', '--', node, '-e', 'process.exit(process.argv.includes("--force") ? 0 : 4)', '--', '--force']);
    expect(result.code).toBe(0);
  });

  it('missing -- or command exits 2 with usage', async () => {
    expect((await cli(['env', 'exec'])).code).toBe(2);
    expect((await cli(['env', 'exec', '--'])).code).toBe(2);
    expect((await cli(['env'])).code).toBe(2);
    const missing = await cli(['env', 'exec', '--', 'ai-hub-no-such-binary-xyz']);
    expect(missing.code).toBe(127);
    expect(missing.err).toContain('comando no encontrado');
  });
});

describe('manifest.tracker and doctor checks (2.5, 2.6)', () => {
  it('an unknown tracker property fails naming it; no block reports not configured', async () => {
    await initConsumer();
    const plain = await cli(['doctor']);
    expect(plain.out).toContain('env:keys: tracker no configurado');
    expect(plain.out).toContain('tracker:token: omitido');
    const manifest = path.join(root, 'manifest.yaml');
    await fs.appendFile(manifest, 'tracker:\n  kind: gitlab\n  urlEnv: GITLAB_URL\n  tokenEnv: GITLAB_TOKEN\n  extra: 1\n');
    const bad = await cli(['doctor']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('"extra"');
  });

  it.skipIf(GIT !== null)('env:ignored covers the four states', async () => {
    runGit(['init', '-q'], root);
    expect((await checkEnvIgnored(root)).ok).toBe(true);
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `GITLAB_TOKEN=${SENTINEL}\n`, 'utf8');
    const unignored = await checkEnvIgnored(root);
    expect(unignored.ok).toBe(false);
    expect(unignored.detail).toContain('no está ignorado');
    await fs.writeFile(path.join(root, '.gitignore'), '.ai-hub/.env\n', 'utf8');
    expect((await checkEnvIgnored(root)).ok).toBe(true);
    runGit(['add', '-f', '.ai-hub/.env'], root);
    const tracked = await checkEnvIgnored(root);
    expect(tracked.ok).toBe(false);
    expect(tracked.detail).toContain('git rm --cached .ai-hub/.env');
    expect(tracked.detail).toContain('rota el token');
    for (const check of [unignored, tracked]) {
      expect(check.detail).not.toContain(SENTINEL);
    }
  });

  it.skipIf(GIT !== null)('doctor exits 1 when the credentials file is not ignored', async () => {
    runGit(['init', '-q'], root);
    await initConsumer();
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `GITLAB_TOKEN=${SENTINEL}\n`, 'utf8');
    const ignore = path.join(root, '.gitignore');
    const lines = (await fs.readFile(ignore, 'utf8')).split('\n').filter((line) => line !== '.ai-hub/.env');
    await fs.writeFile(ignore, lines.join('\n'), 'utf8');
    const result = await cli(['doctor']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[FAIL] env:ignored');
    expect(`${result.out}\n${result.err}`).not.toContain(SENTINEL);
  });

  it('env:keys names missing keys and never prints values', async () => {
    const manifest = { tracker: { kind: 'gitlab', urlEnv: 'GITLAB_URL', tokenEnv: 'GITLAB_TOKEN' } } as ProjectManifest;
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), `GITLAB_URL=${SENTINEL}\n`, 'utf8');
    const missing = await checkEnvKeys(root, manifest);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('GITLAB_TOKEN');
    expect(missing.detail).not.toContain(SENTINEL);
    await fs.appendFile(path.join(root, '.ai-hub', '.env'), `GITLAB_TOKEN=${SENTINEL}\n`);
    const present = await checkEnvKeys(root, manifest);
    expect(present.ok).toBe(true);
    expect(present.detail).not.toContain(SENTINEL);
  });
});

describe('doctor --online (2.7)', () => {
  const manifest = { tracker: { kind: 'gitlab', urlEnv: 'GITLAB_URL', tokenEnv: 'GITLAB_TOKEN' } } as ProjectManifest;

  function spy(status: number, body: unknown): { fetch: FetchLike; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetch: async (url) => {
        calls.push(url);
        return { status, json: async () => body };
      },
    };
  }

  beforeEach(async () => {
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.ai-hub', '.env'),
      `GITLAB_URL=https://tracker.example.test/\nGITLAB_TOKEN=${SENTINEL}\n`,
      'utf8',
    );
  });

  it('without --online there is no network call', async () => {
    const probe = spy(200, {});
    const check = await checkTrackerToken(root, manifest, { fetch: probe.fetch });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('omitido');
    expect(probe.calls).toHaveLength(0);
  });

  it('200 passes with a redacted identity and no secret or body', async () => {
    const probe = spy(200, { username: 'sentinel-user-name', private: SENTINEL });
    const check = await checkTrackerToken(root, manifest, { online: true, fetch: probe.fetch });
    expect(check.ok).toBe(true);
    expect(probe.calls).toEqual(['https://tracker.example.test/api/v4/user']);
    expect(check.detail).toBe('autenticado como s***');
    expect(check.detail).not.toContain(SENTINEL);
  });

  it('401 fails with the status code', async () => {
    const check = await checkTrackerToken(root, manifest, { online: true, fetch: spy(401, {}).fetch });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('401');
    expect(check.detail).not.toContain(SENTINEL);
  });
});

describe('opt-in tracker step (2.8)', () => {
  function prompts(replies: Array<string | null>, withPassword = true): { prompts: AssistantPrompts; asked: string[] } {
    const asked: string[] = [];
    let index = 0;
    const next = (): string | null => (index < replies.length ? replies[index++] : null);
    const base: AssistantPrompts = {
      intro: () => undefined,
      note: () => undefined,
      multiselect: async () => null,
      select: async () => null,
      text: async (message) => {
        asked.push(`text:${message}`);
        return next();
      },
      confirm: async () => null,
    };
    if (withPassword) {
      base.password = async (message) => {
        asked.push(`password:${message}`);
        return next();
      };
    }
    return { prompts: base, asked };
  }

  async function step(replies: Array<string | null>, withPassword = true): Promise<{ wrote: boolean; out: string; asked: string[] }> {
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const scripted = prompts(replies, withPassword);
    const wrote = await offerTrackerStep(scripted.prompts, ctx);
    return { wrote, out: `${sink.out.join('\n')}\n${sink.err.join('\n')}`, asked: scripted.asked };
  }

  it('is not offered without a masked prompt', async () => {
    const result = await step(['s'], false);
    expect(result.wrote).toBe(false);
    expect(result.asked).toHaveLength(0);
  });

  it('an empty answer skips and writes nothing', async () => {
    const result = await step(['']);
    expect(result.wrote).toBe(false);
    expect(await exists(path.join(root, '.ai-hub', '.env'))).toBe(false);
  });

  it('cancelling at the token writes nothing', async () => {
    const result = await step(['s', 'https://tracker.example.test', null]);
    expect(result.wrote).toBe(false);
    expect(await exists(path.join(root, '.ai-hub', '.env'))).toBe(false);
  });

  it('accepting writes only .ai-hub/.env through the masked prompt and never prints it', async () => {
    const result = await step(['s', 'https://tracker.example.test', SENTINEL]);
    expect(result.wrote).toBe(true);
    expect(result.asked.some((call) => call.startsWith('password:'))).toBe(true);
    const env = parseDotenv(await fs.readFile(path.join(root, '.ai-hub', '.env'), 'utf8'));
    expect(Object.keys(env).sort()).toEqual(['GITLAB_TOKEN', 'GITLAB_URL']);
    expect(result.out).not.toContain(SENTINEL);
  });

  it('an existing .env is never overwritten', async () => {
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.env'), 'KEEP=1\n', 'utf8');
    const result = await step(['s', 'https://tracker.example.test', SENTINEL]);
    expect(result.wrote).toBe(false);
    expect(await fs.readFile(path.join(root, '.ai-hub', '.env'), 'utf8')).toBe('KEEP=1\n');
  });

  it('init --yes never asks, even with a TTY and masked prompts', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const sink = capture();
    const base = await createContext(root, sink.io, fakeRunner().run);
    const scripted = prompts(['s', 'https://tracker.example.test', SENTINEL]);
    const code = await cmdInit(parseArgs(['--preset-only', '--yes']), {
      ...base,
      interactive: true,
      assistantPrompts: scripted.prompts,
    });
    expect(code).toBe(0);
    expect(scripted.asked).toHaveLength(0);
    expect(await exists(path.join(root, '.ai-hub', '.env'))).toBe(false);
  });

  it('the plan hash is identical when skipping and when accepting; only the tracker block and the lock seal differ', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-tracker-'));
    try {
      const run = async (dir: string, tracker: Array<string | null>): Promise<{ hash?: string; out: string }> => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
        const sink = capture();
        const ctx = await createContext(dir, sink.io, fakeRunner().run);
        const replies: Array<unknown> = [['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true, ...tracker];
        let index = 0;
        const next = (): unknown => (index < replies.length ? replies[index++] : null);
        const scripted: AssistantPrompts = {
          intro: () => undefined,
          note: () => undefined,
          multiselect: async () => {
            const reply = next();
            return Array.isArray(reply) ? (reply as string[]) : null;
          },
          select: async () => {
            const reply = next();
            return typeof reply === 'string' ? reply : null;
          },
          text: async () => {
            const reply = next();
            return typeof reply === 'string' ? reply : null;
          },
          confirm: async () => next() === true,
          password: async () => {
            const reply = next();
            return typeof reply === 'string' ? reply : null;
          },
        };
        // control-onboarding: sin Hermes en el host inyectado, el paso de control no pregunta ni ejecuta Hermes real.
        const noHermes = { platform: process.platform, env: { PATH: '' }, home: dir, cwd: dir, exec: fakeRunner().run, exists: async () => false };
        expect(await cmdInit(parseArgs([]), { ...ctx, interactive: true, assistantPrompts: scripted, controlHost: noHermes })).toBe(0);
        const out = `${sink.out.join('\n')}\n${sink.err.join('\n')}`;
        return { hash: /plan: ([0-9a-f]{64})/.exec(out)?.[1], out };
      };
      const skip = await run(path.join(base, 'skip', 'consumer'), ['']);
      const accept = await run(path.join(base, 'accept', 'consumer'), ['s', 'https://tracker.example.test', SENTINEL]);
      expect(skip.hash).toBeDefined();
      expect(accept.hash).toBe(skip.hash);
      expect(accept.out).not.toContain(SENTINEL);
      const tree = async (dir: string): Promise<string[]> =>
        (await fs.readdir(dir, { recursive: true })).map((rel) => rel.replace(/\\/g, '/')).sort();
      const skipTree = await tree(path.join(base, 'skip', 'consumer'));
      const acceptTree = (await tree(path.join(base, 'accept', 'consumer'))).filter((rel) => rel !== '.ai-hub/.env');
      expect(acceptTree).toEqual(skipTree);
      const read = (variant: string, rel: string): Promise<string> => fs.readFile(path.join(base, variant, 'consumer', rel), 'utf8');
      expect(await read('accept', '.gitignore')).toBe(await read('skip', '.gitignore'));
      // Contrato nuevo: completar el paso declara manifest.tracker (y re-sella el lock); el resto del manifiesto no cambia.
      expect(await read('accept', 'manifest.yaml')).toBe(
        `${await read('skip', 'manifest.yaml')}tracker:\n  kind: gitlab\n  urlEnv: GITLAB_URL\n  tokenEnv: GITLAB_TOKEN\n`,
      );
      const locks = [JSON.parse(await read('accept', 'sync.lock.json')), JSON.parse(await read('skip', 'sync.lock.json'))];
      expect(locks[0].files).toEqual(locks[1].files);
      expect(Object.keys(locks[0].sources)).toEqual(Object.keys(locks[1].sources));
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});

describe('tracker step declares manifest.tracker and re-seals the lock', () => {
  const TRACKER = { kind: 'gitlab', urlEnv: 'GITLAB_URL', tokenEnv: 'GITLAB_TOKEN' };
  const ACCEPT = ['s', 'https://tracker.example.test', SENTINEL];

  /** Asistente completo sobre `dir`: destinos, perfil, scripts, activo, idea vacía, confirmar y el paso del tracker. */
  async function assistant(dir: string, tracker: Array<string | null>, argv: string[] = []): Promise<{ code: number; out: string }> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    const sink = capture();
    const ctx = await createContext(dir, sink.io, fakeRunner().run);
    const replies: Array<unknown> = [['claude'], 'full', ['py', 'sh', 'ps'], 'sh', '', true, ...tracker];
    let index = 0;
    const next = (): unknown => (index < replies.length ? replies[index++] : null);
    const text = async (): Promise<string | null> => {
      const reply = next();
      return typeof reply === 'string' ? reply : null;
    };
    const scripted: AssistantPrompts = {
      intro: () => undefined,
      note: () => undefined,
      multiselect: async () => {
        const reply = next();
        return Array.isArray(reply) ? (reply as string[]) : null;
      },
      select: text,
      text,
      confirm: async () => next() === true,
      password: text,
    };
    const noHermes = { platform: process.platform, env: { PATH: '' }, home: dir, cwd: dir, exec: fakeRunner().run, exists: async () => false };
    const code = await cmdInit(parseArgs(argv), { ...ctx, interactive: true, assistantPrompts: scripted, controlHost: noHermes });
    return { code, out: `${sink.out.join('\n')}\n${sink.err.join('\n')}` };
  }

  const manifestOf = async (dir: string): Promise<Record<string, unknown>> =>
    parseYaml(await fs.readFile(path.join(dir, 'manifest.yaml'), 'utf8')) as Record<string, unknown>;

  async function filesWith(dir: string, needle: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && (await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8').catch(() => '')).includes(needle)) {
        found.push(path.relative(dir, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'));
      }
    }
    return found.sort();
  }

  it('completing the step declares the tracker, keeps the rest of the manifest, re-seals the lock and leaks nothing', async () => {
    // Mismo nombre de carpeta: el id del proyecto sale de él y no debe distinguir los dos manifiestos.
    const skip = path.join(root, 'skip', 'consumer');
    const done = path.join(root, 'done', 'consumer');
    expect((await assistant(skip, [''])).code).toBe(0);
    const result = await assistant(done, ACCEPT);
    expect(result.code, result.out).toBe(0);
    const manifest = await manifestOf(done);
    expect(manifest.tracker).toEqual(TRACKER);
    const { tracker: _tracker, ...rest } = manifest;
    expect(rest).toEqual(await manifestOf(skip));
    const lock = await cli(['sync', '--check-lock'], done);
    expect(lock.code, `${lock.out}\n${lock.err}`).toBe(0);
    expect(result.out).toContain('manifest.tracker');
    expect(result.out).not.toContain('Declara manifest.tracker');
    expect(result.out).not.toContain(SENTINEL);
    expect(result.out).not.toContain('tracker.example.test');
    expect(await filesWith(done, SENTINEL)).toEqual(['.ai-hub/.env']);
    expect(await filesWith(done, 'tracker.example.test')).toEqual(['.ai-hub/.env']);
  }, 180_000);

  it('a skipped step and init --yes never write the tracker, and the lock stays sealed', async () => {
    const skip = path.join(root, 'skip');
    expect((await assistant(skip, [''])).code).toBe(0);
    expect((await manifestOf(skip)).tracker).toBeUndefined();
    expect((await cli(['sync', '--check-lock'], skip)).code).toBe(0);
    const cancelled = path.join(root, 'cancelled');
    expect((await assistant(cancelled, ['s', 'https://tracker.example.test', null])).code).toBe(0);
    expect((await manifestOf(cancelled)).tracker).toBeUndefined();
    const yes = path.join(root, 'yes');
    expect((await assistant(yes, ACCEPT, ['--preset-only', '--yes'])).code).toBe(0);
    expect((await manifestOf(yes)).tracker).toBeUndefined();
    expect(await exists(path.join(yes, '.ai-hub', '.env'))).toBe(false);
  }, 180_000);

  it('an existing tracker with other variable names is kept as it is', async () => {
    const dir = path.join(root, 'own');
    expect((await assistant(dir, [''])).code).toBe(0);
    const own = { kind: 'gitlab', urlEnv: 'MY_TRACKER_URL', tokenEnv: 'MY_TRACKER_TOKEN' };
    await fs.appendFile(path.join(dir, 'manifest.yaml'), `tracker:\n  kind: gitlab\n  urlEnv: ${own.urlEnv}\n  tokenEnv: ${own.tokenEnv}\n`);
    const result = await assistant(dir, ACCEPT);
    expect(result.code, result.out).toBe(0);
    expect((await manifestOf(dir)).tracker).toEqual(own);
    expect(result.out).toContain('se conservó');
    expect((await cli(['sync', '--check-lock'], dir)).code).toBe(0);
  }, 180_000);

  it('a second run changes no byte of the manifest or the lock', async () => {
    const dir = path.join(root, 'twice');
    expect((await assistant(dir, ACCEPT)).code).toBe(0);
    const before = [await fs.readFile(path.join(dir, 'manifest.yaml')), await fs.readFile(path.join(dir, 'sync.lock.json'))];
    expect((await assistant(dir, ACCEPT)).code).toBe(0);
    expect(await fs.readFile(path.join(dir, 'manifest.yaml'))).toEqual(before[0]);
    expect(await fs.readFile(path.join(dir, 'sync.lock.json'))).toEqual(before[1]);
    expect((await cli(['sync', '--check-lock'], dir)).code).toBe(0);
  }, 180_000);

  it.each([
    ['duplicate keys', 'preset: a\npreset: b\n'],
    ['a sequence', '- uno\n- dos\n'],
  ])('fails closed on a manifest with %s: writes nothing and names the problem without the content', async (_label, broken) => {
    await fs.writeFile(path.join(root, 'manifest.yaml'), broken);
    const sink = capture();
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    let index = 0;
    const text = async (): Promise<string | null> => ACCEPT[index++] ?? null;
    const report = await runTrackerStep({ intro: () => undefined, note: () => undefined, multiselect: async () => null, select: async () => null, text, confirm: async () => null, password: text }, ctx);
    expect(report?.state).toBe('fallida');
    expect(await fs.readFile(path.join(root, 'manifest.yaml'), 'utf8')).toBe(broken);
    expect(await exists(path.join(root, '.ai-hub', '.env'))).toBe(false);
    const out = `${sink.out.join('\n')}\n${sink.err.join('\n')}`;
    expect(out).toContain('manifest.yaml');
    expect(out).not.toContain('uno');
    expect(out).not.toContain(SENTINEL);
  });
});

describe('catalog without client host, load-env or token requests (2.9)', () => {
  async function walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(abs)));
      } else if (/\.(md|mdc|ya?ml|json|txt)$/.test(entry.name)) {
        files.push(abs);
      }
    }
    return files;
  }

  it('no published file names the client host or load-env.sh', async () => {
    const hits: string[] = [];
    for (const dir of ['skills', 'agents', 'presets', 'engine', 'rules']) {
      for (const file of await walk(path.join(CORE, dir))) {
        const text = await fs.readFile(file, 'utf8');
        if (/onnadigital|load-env/i.test(text)) {
          hits.push(path.relative(CORE, file));
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('gitlab-auth uses env exec and the online doctor, and forbids asking for secrets', async () => {
    const skill = await fs.readFile(path.join(CORE, 'skills', 'shared', 'gitlab-auth', 'SKILL.md'), 'utf8');
    expect(skill).toContain('npx ai-hub env exec --');
    expect(skill).toContain('npx ai-hub doctor --online');
    expect(skill).toContain('${GITLAB_URL}');
    expect(skill).not.toMatch(/Get-Content \.ai-hub\/\.env/);
    expect(skill).toMatch(/NUNCA pedir el token/);
  });
});

describe('ci gitlab (2.10)', () => {
  it('init never writes it; it is written on request, guarded and portable', async () => {
    await initConsumer();
    expect(await exists(path.join(root, '.gitlab-ci.ai-hub.yml'))).toBe(false);
    expect((await cli(['ci', 'gitlab'])).code).toBe(0);
    const text = await fs.readFile(path.join(root, '.gitlab-ci.ai-hub.yml'), 'utf8');
    expect(text).toContain('image: node:22');
    expect(text).toContain('doctor');
    expect(text).toContain('sync --check-lock');
    expect(text.split('\n')).toContain('    - npx --yes @dsalazardev/ai-hub-cli gate');
    expect(text).not.toMatch(/\bbash /);
    expect(text).not.toMatch(/\bgrep\b/);
    const again = await cli(['ci', 'gitlab']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('--force');
    expect((await cli(['ci', 'gitlab', '--force'])).code).toBe(0);
    expect((await cli(['ci', 'nope'])).code).toBe(2);
  });
});

describe('fail-open git hooks (2.11)', () => {
  it('every hook starts with the fail-open prefix', () => {
    for (const name of ['post-merge', 'pre-commit'] as const) {
      const script = gitHookScript(name);
      expect(script.split('\n')[2]).toBe(FAIL_OPEN_PREFIX);
    }
  });

  it.skipIf(GIT !== null)('hooks install --pre-commit writes the hook and refuses a second copy', async () => {
    runGit(['init', '-q'], root);
    const first = await cli(['hooks', 'install', '--pre-commit']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('pre-commit instalado');
    const again = await cli(['hooks', 'install', '--pre-commit']);
    expect(again.out).toContain('already exists');
    expect((await cli(['hooks', 'install'])).code).toBe(2);
  });

  it('a hook exits 0 when npx is not on PATH', async () => {
    const settings = { script: 'sh' } as SpeckitSettings;
    const shell = shellCandidates(settings)
      .map((candidate) => candidate.command)
      .find((command) => spawnSync(command, ['-c', 'echo ok'], { encoding: 'utf8', shell: false }).stdout?.trim() === 'ok');
    if (shell === undefined) {
      return;
    }
    const hook = path.join(root, 'pre-commit');
    await fs.writeFile(hook, gitHookScript('pre-commit'), 'utf8');
    // PATH real sin las carpetas que contienen npx: el shell sigue arrancando (Git Bash necesita
    // sus DLL del PATH) pero `command -v npx` falla, como en un cliente git sin Node.
    const names = ['npx', 'npx.cmd', 'npx.exe'];
    const filtered = (process.env.PATH ?? process.env.Path ?? '')
      .split(path.delimiter)
      .filter((dir) => dir !== '' && !names.some((name) => existsSync(path.join(dir, name))))
      .join(path.delimiter);
    const env = { ...process.env, PATH: filtered, Path: filtered };
    const probe = spawnSync(shell, ['-c', 'command -v npx >/dev/null 2>&1 && echo found || echo missing'], { env, encoding: 'utf8', shell: false });
    expect(probe.stdout.trim()).toBe('missing');
    const result = spawnSync(shell, [hook], { env, encoding: 'utf8', shell: false });
    expect(result.status).toBe(0);
  });
});

describe('fabrica-verificable 5.3–5.7 — migración de 0.16.0: .env con las claves y sin manifest.tracker', () => {
  const TRACKER = { kind: 'gitlab', urlEnv: 'GITLAB_URL', tokenEnv: 'GITLAB_TOKEN' };
  const DECLARE = 'ai-hub init --yes --declare-tracker';
  const envFile = (): string => path.join(root, '.ai-hub', '.env');
  const manifestFile = (): string => path.join(root, 'manifest.yaml');
  const lockFile = (): string => path.join(root, 'sync.lock.json');
  const tracker = async (): Promise<unknown> => (parseYaml(await fs.readFile(manifestFile(), 'utf8')) as Record<string, unknown>).tracker;

  /** Instalación como la que dejó 0.16.0: paso del tracker completado (`.env` con las dos claves) y sin bloque. */
  async function legacy(env = `GITLAB_URL=https://tracker.example.test\nGITLAB_TOKEN=${SENTINEL}\n`): Promise<void> {
    await initConsumer();
    await fs.writeFile(envFile(), env);
    expect(await tracker()).toBeUndefined();
    expect((await cli(['sync', '--check-lock'])).code).toBe(0);
  }

  async function step(replies: Array<string | null>) {
    const sink = capture();
    const asked: string[] = [];
    let index = 0;
    const next = (): string | null => (index < replies.length ? replies[index++] : null);
    const prompts: AssistantPrompts = {
      intro: () => undefined,
      note: () => undefined,
      multiselect: async () => null,
      select: async () => null,
      text: async (message) => {
        asked.push(`text:${message}`);
        return next();
      },
      confirm: async () => null,
      password: async (message) => {
        asked.push(`password:${message}`);
        return next();
      },
    };
    const ctx = await createContext(root, sink.io, fakeRunner().run);
    const report = await runTrackerStep(prompts, ctx);
    return { report, asked, text: [...sink.out, ...sink.err].join('\n') };
  }

  async function everyFileWith(needle: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && (await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8').catch(() => '')).includes(needle)) {
        found.push(path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'));
      }
    }
    return found.sort();
  }

  it('the assistant offers the declaration, asks for no URL or token, and accepting declares the block and seals the lock', async () => {
    await legacy();
    const env = await fs.readFile(envFile());
    const result = await step(['s']);
    expect(result.report).toMatchObject({ name: 'tracker', state: 'completada' });
    expect(result.asked).toHaveLength(1);
    expect(result.asked[0]).toContain('manifest.yaml no declara el tracker');
    expect(result.asked[0]).toContain('no se pide el token');
    expect(result.asked.some((call) => call.startsWith('password:'))).toBe(false);
    expect(await tracker()).toEqual(TRACKER);
    expect(await fs.readFile(envFile())).toEqual(env);
    expect((await cli(['sync', '--check-lock'])).code).toBe(0);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).not.toContain('tracker.example.test');
    expect(await everyFileWith(SENTINEL)).toEqual(['.ai-hub/.env']);
  }, 120_000);

  it('declining writes nothing', async () => {
    await legacy();
    const before = [await fs.readFile(manifestFile()), await fs.readFile(lockFile())];
    const result = await step(['']);
    expect(result.report).toMatchObject({ name: 'tracker', state: 'no-solicitada' });
    expect([await fs.readFile(manifestFile()), await fs.readFile(lockFile())]).toEqual(before);
  }, 120_000);

  it('a credentials file without GITLAB_TOKEN names the missing key, declares nothing and stays pendiente', async () => {
    await legacy('GITLAB_URL=https://tracker.example.test\n');
    const result = await step(['s']);
    expect(result.report).toMatchObject({ name: 'tracker', state: 'pendiente' });
    expect(result.text).toContain('GITLAB_TOKEN');
    expect(result.asked.some((call) => call.startsWith('password:'))).toBe(false);
    expect(await tracker()).toBeUndefined();
  }, 120_000);

  it('init --yes alone never declares it and names the gap with the command', async () => {
    await legacy();
    const before = [await fs.readFile(manifestFile()), await fs.readFile(lockFile())];
    const result = await cli(['init', '--preset-only', '--yes']);
    expect(result.code, result.out + result.err).toBe(0);
    expect(await tracker()).toBeUndefined();
    expect([await fs.readFile(manifestFile()), await fs.readFile(lockFile())]).toEqual(before);
    expect(result.out + result.err).toContain(DECLARE);
    expect(result.out + result.err).not.toContain(SENTINEL);
  }, 120_000);

  it('init --yes --declare-tracker declares the block without touching .env, seals the lock and reports completada', async () => {
    await legacy();
    const env = await fs.readFile(envFile());
    const result = await cli(['init', '--preset-only', '--yes', '--declare-tracker']);
    expect(result.code, result.out + result.err).toBe(0);
    expect(await tracker()).toEqual(TRACKER);
    expect(await fs.readFile(envFile())).toEqual(env);
    expect((await cli(['sync', '--check-lock'])).code).toBe(0);
    expect(result.out.trimEnd().split('\n').at(-1)).toBe('ai-hub-integration: name=tracker state=completada stage=- action=-');
    expect(result.out + result.err).not.toContain(SENTINEL);
    // Segunda ejecución: ya declarado, nada cambia.
    const before = [await fs.readFile(manifestFile()), await fs.readFile(lockFile())];
    const again = await cli(['init', '--preset-only', '--yes', '--declare-tracker']);
    expect(again.out.trimEnd().split('\n').at(-1)).toBe('ai-hub-integration: name=tracker state=completada stage=- action=-');
    expect([await fs.readFile(manifestFile()), await fs.readFile(lockFile())]).toEqual(before);
    expect(await everyFileWith(SENTINEL)).toEqual(['.ai-hub/.env']);
  }, 180_000);

  it('--declare-tracker with a key absent declares nothing, names the key and stays pendiente with exit 0', async () => {
    await legacy(`GITLAB_TOKEN=${SENTINEL}\n`);
    const result = await cli(['init', '--preset-only', '--yes', '--declare-tracker']);
    expect(result.code, result.out + result.err).toBe(0);
    expect(await tracker()).toBeUndefined();
    expect(result.out.trimEnd().split('\n').at(-1)).toMatch(/^ai-hub-integration: name=tracker state=pendiente /);
    expect(result.out + result.err).toContain('GITLAB_URL');
    expect(result.out + result.err).not.toContain(SENTINEL);
  }, 120_000);

  it('--declare-tracker keeps the plan contract: nothing written and the same plan hash', async () => {
    await legacy();
    const before = [await fs.readFile(manifestFile()), await fs.readFile(lockFile())];
    const plain = await cli(['init', '--preset-only', '--dry-run']);
    const flagged = await cli(['init', '--preset-only', '--dry-run', '--declare-tracker']);
    const hash = (text: string): string | undefined => /"hash":\s*"([0-9a-f]{64})"/.exec(text)?.[1];
    expect(hash(plain.out)).toBeDefined();
    expect(hash(flagged.out)).toBe(hash(plain.out));
    expect([await fs.readFile(manifestFile()), await fs.readFile(lockFile())]).toEqual(before);
  }, 120_000);

  it('doctor names the undeclared tracker and its command without degrading the result', async () => {
    await legacy();
    const manifest = parseYaml(await fs.readFile(manifestFile(), 'utf8')) as ProjectManifest;
    const check = await checkEnvKeys(root, manifest);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(DECLARE);
    expect(check.detail).not.toContain(SENTINEL);
    const doctor = await cli(['doctor']);
    expect(doctor.out).toContain(DECLARE);
  }, 120_000);
});
