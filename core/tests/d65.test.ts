import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import type { CliIO } from '../src/cli/types.js';
import { runSync } from '../src/sync/sync.js';
import { writeInventory } from '../src/manifest/manifest.js';
import { missingClaudeHooks } from '../src/sync/hooks.js';
import { createExclusive, listProposals, prepareProposal } from '../src/writes/proposals.js';
import { credentialGate, ensureHarnessGitignore, HARNESS_GITIGNORE_CONTENT, ignoreStatus } from '../src/writes/credential-ignore.js';
import { seedFixture } from './fixtures.js';
import { fakeRunner } from './speckit-fake.js';

const SENTINEL = 'glpat-d65-sentinel-not-a-real-token';
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-d65-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function git(args: string[]): number {
  return spawnSync('git', args, { cwd: root, windowsHide: true }).status ?? 1;
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await runCli(argv, { cwd: root, io, exec: fakeRunner().run });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function consumerWithSettings(settings: string): Promise<string> {
  await seedFixture(root);
  await writeInventory(root);
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  const file = path.join(root, '.claude', 'settings.json');
  await fs.writeFile(file, settings, 'utf8');
  return file;
}

describe('configuración ajena por archivo nuevo o propuesta (3.25, R-113, R-121)', () => {
  it('preparación sin modificación: el archivo queda byte a byte igual y sin copia junto a él', async () => {
    const original = `{"env":{"GITLAB_TOKEN":"${SENTINEL}"}}`;
    const file = await consumerWithSettings(original);
    const result = await runSync(root, { check: false });
    expect(result.pending.join('\n')).toContain('claude-hooks');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.startsWith('settings.json'))).toEqual(['settings.json']);
    const [proposal] = await listProposals(root);
    // La propuesta guarda el fragmento gestionado y la huella, nunca los bytes (ni el secreto) del archivo.
    expect(JSON.stringify(proposal)).not.toContain(SENTINEL);
    expect(proposal.fragment).toContain('ai-hub hook pre');
  });

  it('reanudar no duplica: la misma propuesta conserva su id', async () => {
    await consumerWithSettings('{"model":"x"}');
    await runSync(root, { check: false });
    const first = await listProposals(root);
    await runSync(root, { check: false });
    expect((await listProposals(root)).map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('archivo cambiado tras la propuesta: la obsoleta no se vuelve a ofrecer y se sustituye', async () => {
    const file = await consumerWithSettings('{"model":"x"}');
    await runSync(root, { check: false });
    const [first] = await listProposals(root);
    await fs.writeFile(file, '{"model":"y"}', 'utf8');
    await runSync(root, { check: false });
    const after = await listProposals(root);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(first.id);
    expect(after[0].baseFingerprint).not.toBe(first.baseFingerprint);
  });

  it('la persona aplica el fragmento: se reconoce por contenido, se cierra y la capacidad queda activa', async () => {
    const file = await consumerWithSettings('{"model":"x"}');
    await runSync(root, { check: false });
    const [proposal] = await listProposals(root);
    const fragment = JSON.parse(proposal.fragment) as { hooks: unknown };
    await fs.writeFile(file, JSON.stringify({ model: 'x', hooks: fragment.hooks }), 'utf8');
    const again = await runSync(root, { check: false });
    expect(again.pending.filter((line) => line.includes('claude-hooks'))).toEqual([]);
    expect(await listProposals(root)).toEqual([]);
    expect(missingClaudeHooks(JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>)).toEqual([]);
  });

  it('la creación exclusiva que pierde la carrera nunca sobrescribe', async () => {
    const file = path.join(root, 'AGENTS.md');
    await fs.writeFile(file, 'del usuario\n', 'utf8');
    expect(await createExclusive(file, 'del motor\n')).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('del usuario\n');
    const prepared = await prepareProposal(root, { capability: 'managed-region', file, display: 'AGENTS.md', fragment: 'x', instructions: 'i', check: 'c' });
    expect(prepared.status).toBe('new');
    expect(await fs.readFile(file, 'utf8')).toBe('del usuario\n');
  });
});

describe('credenciales detrás de un ignorado verificado (3.28, R-117, R-123)', () => {
  it('.ai-hub/.gitignore protege la credencial sin tocar el .gitignore raíz', async () => {
    expect(git(['init', '-q'])).toBe(0);
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    expect(await ensureHarnessGitignore(root)).toBe('created');
    expect(await fs.readFile(path.join(root, '.ai-hub', '.gitignore'), 'utf8')).toBe(HARNESS_GITIGNORE_CONTENT);
    expect(ignoreStatus(root, '.ai-hub/.env')).toBe('ignored');
    expect(ignoreStatus(root, '.ai-hub/runs/x/events.jsonl')).toBe('ignored');
    expect(ignoreStatus(root, '.ai-hub/.env.example')).toBe('not_ignored');
    expect(ignoreStatus(root, '.ai-hub/work/a.md')).toBe('not_ignored');
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('un .ai-hub/.gitignore ajeno sin la regla: el paso no escribe nada', async () => {
    expect(git(['init', '-q'])).toBe(0);
    await fs.mkdir(path.join(root, '.ai-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-hub', '.gitignore'), '*.log\n', 'utf8');
    const gate = await credentialGate(root, '.ai-hub/.env');
    expect(gate).toMatchObject({ ok: false, reason: 'credential_ignore_unverified' });
    expect(await fs.readFile(path.join(root, '.ai-hub', '.gitignore'), 'utf8')).toBe('*.log\n');
  });

  it('fuera de un repositorio git se informa not_a_git_repository', async () => {
    expect(ignoreStatus(root, '.ai-hub/.env')).toBe('not_a_git_repository');
    expect((await credentialGate(root, '.ai-hub/.env')).ok).toBe(true);
  });

  it('un MCP con credenciales no se genera si git no lo ignora', async () => {
    expect(git(['init', '-q'])).toBe(0);
    await seedFixture(root);
    await writeInventory(root);
    const result = await runSync(root, { check: false });
    expect(result.pending.join('\n')).toMatch(/pendiente: mcp · \.mcp\.json no se genera/);
    await expect(fs.access(path.join(root, '.mcp.json'))).rejects.toThrow();
    await fs.writeFile(path.join(root, '.gitignore'), '.mcp.json\n.cursor/mcp.json\n.vscode/mcp.json\n', 'utf8');
    const again = await runSync(root, { check: false });
    expect(again.pending.join('\n')).not.toContain('pendiente: mcp');
    await expect(fs.access(path.join(root, '.mcp.json'))).resolves.toBeUndefined();
  });
});

describe('resultado de instalación con capacidades pendientes (3.29, R-118, R-122, R-124)', () => {
  it('instalación degradada: init sale 1, lista lo pendiente y doctor no lo da por sano', async () => {
    expect(git(['init', '-q'])).toBe(0);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude', 'settings.json'), '{"model":"x"}', 'utf8');
    const init = await cli(['init', '--preset-only', '--yes', '--no-speckit']);
    expect(init.code).toBe(1);
    expect(init.out).toContain('pendiente: root-gitignore');
    expect(init.out).toContain('pendiente: claude-hooks');
    expect(init.out).toContain('instalación degradada');
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    const doctor = await cli(['doctor']);
    expect(doctor.code).toBe(1);
    expect(doctor.out).toMatch(/pending: instalación degradada/);
    // La memoria de agente va en la propuesta del .gitignore raíz (agentMemory por defecto: ignored).
    const gitignoreProposal = (await listProposals(root)).find((item) => item.capability === 'root-gitignore');
    expect(gitignoreProposal?.fragment).toContain('.claude/agent-memory/');
  });

  it('sync con pendientes sale 0 y los informa', async () => {
    await consumerWithSettings('{"model":"x"}');
    const sync = await cli(['sync']);
    expect(sync.code).toBe(0);
    expect(sync.out).toContain('pendiente: claude-hooks');
  });

  it('instalación completa: sin pendientes, init sale 0 y no deja propuestas', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const init = await cli(['init', '--preset-only', '--yes', '--no-speckit']);
    expect(init.code, init.out + init.err).toBe(0);
    expect(await listProposals(root)).toEqual([]);
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toContain('.ai-hub/.env');
  });
});

describe('JSON ajeno inválido, con claves duplicadas o con comentarios (3.4, R-033)', () => {
  it.each([
    ['inválido', '{"model": '],
    ['claves duplicadas', '{"model":"x","model":"y"}'],
    ['comentarios', '{\n  // mío\n  "model": "x"\n}'],
  ])('%s: se informa, queda byte a byte igual y no se propone nada', async (_label, text) => {
    const file = await consumerWithSettings(text);
    const result = await runSync(root, { check: false });
    expect(result.problems.join('\n')).toContain('.claude/settings.json');
    expect(await fs.readFile(file, 'utf8')).toBe(text);
    expect(await listProposals(root)).toEqual([]);
  });
});

describe('copias sensibles adyacentes de versiones previas (3.9, R-040)', () => {
  it('doctor informa la presencia sin contenido y el comando explícito las mueve sin dejar copia junto al original', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect((await cli(['init', '--preset-only', '--yes', '--no-speckit'])).code).toBe(0);
    const hermes = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hermes-'));
    const profile = path.join(hermes, 'profiles', 'hermes-control');
    await fs.mkdir(profile, { recursive: true });
    const copy = path.join(profile, 'config.yaml.pre-ai-hub');
    await fs.writeFile(copy, `token: ${SENTINEL}\n`);
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-private-'));
    const previous = { home: process.env.HERMES_HOME, priv: process.env.AI_HUB_PRIVATE_DIR };
    process.env.HERMES_HOME = hermes;
    process.env.AI_HUB_PRIVATE_DIR = privateDir;
    try {
      const doctor = await cli(['doctor']);
      expect(doctor.out).toContain('config.yaml.pre-ai-hub');
      expect(doctor.out).toContain('ai-hub backups move-sensitive --yes');
      expect(doctor.out + doctor.err).not.toContain(SENTINEL);
      expect((await cli(['backups', 'move-sensitive'])).code).toBe(2);
      expect(await fs.readFile(copy, 'utf8')).toContain(SENTINEL);
      const moved = await cli(['backups', 'move-sensitive', '--yes']);
      expect(moved.code, moved.err).toBe(0);
      await expect(fs.access(copy)).rejects.toThrow();
      const inPrivate = await fs.readdir(privateDir);
      expect(inPrivate).toHaveLength(1);
      expect(await fs.readFile(path.join(privateDir, inPrivate[0]), 'utf8')).toContain(SENTINEL);
      expect(moved.out + moved.err).not.toContain(SENTINEL);
    } finally {
      process.env.HERMES_HOME = previous.home;
      if (previous.priv === undefined) {
        delete process.env.AI_HUB_PRIVATE_DIR;
      } else {
        process.env.AI_HUB_PRIVATE_DIR = previous.priv;
      }
      await fs.rm(hermes, { recursive: true, force: true });
      await fs.rm(privateDir, { recursive: true, force: true });
    }
  });

  it('sin almacenamiento privado no se mueve ni se borra nada', async () => {
    const hermes = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hermes-'));
    const copy = path.join(hermes, 'profiles', 'default', '.env.pre-ai-hub');
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(copy, `X=${SENTINEL}\n`);
    const { moveSensitiveCopies } = await import('../src/writes/sensitive-copies.js');
    const result = await moveSensitiveCopies(root, hermes, { platform: 'win32', env: {} });
    expect(result).toMatchObject({ ok: false, reason: 'private_storage_unconfigured' });
    expect(await fs.readFile(copy, 'utf8')).toContain(SENTINEL);
    await fs.rm(hermes, { recursive: true, force: true });
  });
});
