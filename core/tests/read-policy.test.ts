import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHook } from '../src/cli/hook.js';
import { caseInsensitiveFs, recognizedReads, resolveReadTarget } from '../src/harness/guards/adapters/read-targets.js';
import { evaluateRead, matchSensitive, shellReads } from '../src/harness/guards/read-policy.js';
import { readRunEvents } from '../src/harness/runs.js';
import { writeInventory } from '../src/manifest/manifest.js';
import { seedFixture } from './fixtures.js';

/** Política de lectura (4.29–4.34, R-047–R-053): núcleo puro, adaptador y hook `pre` con payloads de Claude y OpenCode. */

const SSH_SENTINEL = 'AIHUB_SSH_KEY_SENTINEL_9f3e';
const ENV_SENTINEL = 'AIHUB_ENV_SENTINEL_51ab';
let root: string;
let home: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-read-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-read-home-'));
  await fs.mkdir(path.join(home, '.ssh'));
  await fs.writeFile(path.join(home, '.ssh', 'id_ed25519'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${SSH_SENTINEL}\n`);
});
afterEach(async () => {
  for (const dir of [root, home]) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function consumer(guardMode: 'shadow' | 'enforce', optOuts: string[] = []): Promise<void> {
  await seedFixture(root);
  const file = path.join(root, 'manifest.yaml');
  const manifest = parse(await fs.readFile(file, 'utf8')) as { policy: { guardMode: string; optOuts: string[] } };
  manifest.policy.guardMode = guardMode;
  manifest.policy.optOuts = optOuts;
  await fs.writeFile(file, stringify(manifest));
  await writeInventory(root);
  await fs.writeFile(path.join(root, '.env'), `GITLAB_TOKEN=${ENV_SENTINEL}\n`);
  await fs.writeFile(path.join(root, 'src.ts'), 'export const a = 1;\n');
}

const claudeRead = (file: string, sessionId = 'read-test'): string =>
  JSON.stringify({ session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file }, cwd: root });
const claudeBash = (command: string): string =>
  JSON.stringify({ session_id: 'read-test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root });

function decision(output: Record<string, unknown>): string | undefined {
  return (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;
}

describe('patrones sensibles y modos (4.29, R-050)', () => {
  it('clave SSH: denegada en enforce nombrando el patrón, sin ruta ni contenido', async () => {
    await consumer('enforce');
    const key = path.join(home, '.ssh', 'id_ed25519');
    const outcome = await runHook('pre', claudeRead(key), root);
    expect(decision(outcome.output)).toBe('deny');
    const text = JSON.stringify(outcome.output);
    expect(text).toContain('read:ssh_key');
    expect(text).not.toContain(SSH_SENTINEL);
    expect(text).not.toContain('id_ed25519');
  });

  it('la misma lectura en shadow se permite con aviso redactado', async () => {
    await consumer('shadow');
    const outcome = await runHook('pre', claudeRead(path.join(home, '.ssh', 'id_ed25519')), root);
    expect(decision(outcome.output)).not.toBe('deny');
    expect(String(outcome.output.systemMessage)).toContain('[shadow] read:ssh_key');
  });

  it('un archivo normal del proyecto se permite sin aviso', async () => {
    await consumer('enforce');
    const outcome = await runHook('pre', claudeRead(path.join(root, 'src.ts')), root);
    expect(decision(outcome.output)).not.toBe('deny');
    expect(JSON.stringify(outcome.output)).not.toContain('read:');
  });

  it('opt-out de la política: la lectura pasa y las demás guardias siguen aplicando', async () => {
    await consumer('enforce', ['read']);
    // Las demás guardias necesitan un repositorio git para construir su contexto (sin él fallan abiertas).
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('git', ['init', '-q', '-b', 'feat'], { cwd: root, windowsHide: true }).status).toBe(0);
    const git = (...args: string[]): number | null => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: root, windowsHide: true }).status;
    expect(git('add', '-A')).toBe(0);
    expect(git('commit', '-q', '-m', 'base')).toBe(0);
    expect(decision((await runHook('pre', claudeRead(path.join(root, '.env')), root)).output)).not.toBe('deny');
    const danger = await runHook('pre', claudeBash('rm -rf /'), root);
    expect(['ask', 'deny']).toContain(decision(danger.output));
  });

  it('.env.example no es sensible; .env.local sí', () => {
    expect(matchSensitive('/repo/.env.example', false)).toBeNull();
    expect(matchSensitive('/repo/.env.local', false)).toBe('env_file');
    expect(matchSensitive('/home/u/.aws/credentials', false)).toBe('cloud_credentials');
    expect(matchSensitive('/home/u/.hermes/profiles/hermes-control/.env', false)).toBe('env_file');
    expect(matchSensitive('C:/Users/u/AppData/Local/hermes/profiles/hermes-control/config.yaml', true)).toBe('hermes_profile');
    expect(matchSensitive('/repo/certs/server.pem', false)).toBe('private_key');
  });
});

describe('normalización de rutas (4.30, R-052)', () => {
  it('Windows con mayúsculas y separadores mezclados: ..\\Project\\.ENV coincide con .env', async () => {
    const target = await resolveReadTarget('..\\Project\\.ENV', { cwd: 'C:\\work\\repo', home: 'C:\\Users\\u', platform: 'win32' });
    expect(target.requested).toBe('C:/work/Project/.ENV');
    expect(evaluateRead({ tool: 'Read', action: 'read', targets: [target] }, 'enforce', caseInsensitiveFs('win32')).rule).toBe('read:env_file');
  });

  it('sistema sensible a mayúsculas: .ENVIRONMENT.md no coincide con .env', async () => {
    const target = await resolveReadTarget('docs/.ENVIRONMENT.md', { cwd: '/repo', home: '/home/u', platform: 'linux' });
    expect(evaluateRead({ tool: 'Read', action: 'read', targets: [target] }, 'enforce', caseInsensitiveFs('linux')).decision).toBe('allow');
    expect(matchSensitive('/repo/.ENV', false)).toBeNull();
  });

  it('~ y rutas relativas se resuelven antes de comparar', async () => {
    const env = { cwd: root, home, platform: process.platform };
    const tilde = await resolveReadTarget('~/.ssh/id_ed25519', env);
    expect(evaluateRead({ tool: 'Read', action: 'read', targets: [tilde] }, 'enforce', caseInsensitiveFs(process.platform)).rule).toBe('read:ssh_key');
    const relative = await resolveReadTarget('./sub/../.env', env);
    expect(relative.requested?.endsWith('/.env')).toBe(true);
  });

  it('un enlace a un .env se compara por su destino real', async (context) => {
    await fs.writeFile(path.join(home, '.env'), `TOKEN=${ENV_SENTINEL}\n`);
    const link = path.join(root, 'notes.txt');
    try {
      await fs.symlink(path.join(home, '.env'), link, 'file');
    } catch (error) {
      // Windows sin modo desarrollador no permite crear enlaces: la prueba se omite y queda para CI POSIX.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip();
      }
      throw error;
    }
    const target = await resolveReadTarget(link, { cwd: root, home, platform: process.platform });
    expect(evaluateRead({ tool: 'Read', action: 'read', targets: [target] }, 'enforce', caseInsensitiveFs(process.platform)).rule).toBe('read:env_file');
  });

  it('un destino inexistente no se da por seguro: se compara por su nombre', async () => {
    const target = await resolveReadTarget('missing/.env', { cwd: root, home, platform: process.platform });
    expect(target.real).toBeNull();
    expect(evaluateRead({ tool: 'Read', action: 'read', targets: [target] }, 'enforce', caseInsensitiveFs(process.platform)).rule).toBe('read:env_file');
  });
});

describe('excepción acotada al fallo abierto (4.31, R-047, R-048)', () => {
  it('lectura reconocida sin destino verificable: denegada en enforce, permitida con aviso en shadow', async () => {
    await consumer('enforce');
    const unknown = JSON.stringify({ tool_name: 'Read', tool_input: {}, cwd: root });
    expect(decision((await runHook('pre', unknown, root)).output)).toBe('deny');
    await consumer('shadow');
    const shadow = await runHook('pre', unknown, root);
    expect(decision(shadow.output)).not.toBe('deny');
    expect(String(shadow.output.systemMessage)).toContain('read:unverifiable');
  });

  it('con el manifiesto ilegible la lectura se permite (modo desconocido)', async () => {
    await consumer('enforce');
    await fs.writeFile(path.join(root, 'manifest.yaml'), 'policy: [roto');
    expect((await runHook('pre', claudeRead(path.join(root, '.env')), root)).output).toEqual({});
  });

  it('una operación que no es lectura sigue fallando abierto sin git', async () => {
    await consumer('enforce');
    expect(decision((await runHook('pre', claudeBash('npm test'), root)).output)).not.toBe('deny');
  });
});

describe('lectores de shell reconocidos (4.33, R-051)', () => {
  it.each([
    ['cat $F', 'read:unverifiable'],
    ['Get-Content $env:TARGET', 'read:unverifiable'],
    ['grep -r token $HOME/proyecto', 'read:unverifiable'],
    ['cat .env', 'read:env_file'],
    ['head -n 5 src.ts | cat .env', 'read:env_file'],
  ])('enforce: «%s» se deniega como %s sin pedir confirmación', async (command, rule) => {
    await consumer('enforce');
    const outcome = await runHook('pre', claudeBash(command), root);
    expect(decision(outcome.output)).toBe('deny');
    expect(JSON.stringify(outcome.output)).toContain(rule);
    expect(JSON.stringify(outcome.output)).not.toContain(ENV_SENTINEL);
  });

  it('shadow: «cat $F» se permite con un aviso que nombra la lectura no verificable', async () => {
    await consumer('shadow');
    const outcome = await runHook('pre', claudeBash('cat $F'), root);
    expect(decision(outcome.output)).not.toBe('deny');
    expect(String(outcome.output.systemMessage)).toContain('read:unverifiable');
  });

  it('un comando no reconocido no se evalúa aunque pueda leer archivos', async () => {
    expect(shellReads('python -c "open(\'.env\').read()"')).toEqual([]);
    await consumer('enforce');
    expect(JSON.stringify((await runHook('pre', claudeBash('python leer.py .env'), root)).output)).not.toContain('read:');
  });

  it('una búsqueda de Claude con ruta no resoluble se deniega en enforce', async () => {
    await consumer('enforce');
    const grep = JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '$HOME' }, cwd: root });
    expect(decision((await runHook('pre', grep, root)).output)).toBe('deny');
  });
});

describe('avisos de shadow visibles en OpenCode (4.34, R-053)', () => {
  it('lectura sensible en shadow: el mensaje y un registro redactado nombran patrón y herramienta', async () => {
    await consumer('shadow');
    const payload = JSON.stringify({ tool: 'read', args: { filePath: path.join(root, '.env') }, sessionID: 'oc-read' });
    const outcome = await runHook('pre', payload, root);
    expect(outcome.output.blocked).toBe(false);
    expect(String(outcome.output.message)).toContain('read:env_file');
    const note = (await readRunEvents(root, 'session-oc-read')).find((event) => event.note_type === 'guard');
    expect(note).toMatchObject({ v: 2, kind: 'note', note_type: 'guard' });
    expect(note?.note).toContain('read:env_file');
    expect(JSON.stringify(note)).not.toContain('.env');
    expect(JSON.stringify(note)).not.toContain(ENV_SENTINEL);
  });

  it('el adaptador reconoce las herramientas de OpenCode', async () => {
    const reads = await recognizedReads({ tool: 'grep', args: { pattern: 'x', path: 'src' } }, { cwd: root, home, platform: process.platform });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ tool: 'grep', action: 'search' });
  });
});

describe('cobertura degradada en doctor (4.35, R-048)', () => {
  it('sin el ejecutable del evaluador, la política se declara no efectiva en Claude y OpenCode', async () => {
    const { checkReadCoverage } = await import('../src/harness/guards/adapters/read-coverage.js');
    const absent = await checkReadCoverage({ root, targets: ['claude', 'opencode', 'cursor'], guardMode: 'enforce', optOuts: [], claudeHooks: true, env: { PATH: '' } });
    expect(absent.detail).toContain('claude: no efectiva (el hook no puede ejecutar el evaluador');
    expect(absent.detail).toContain('opencode: no efectiva');
    expect(absent.detail).toContain('cursor: no efectiva (el host no admite hooks)');
    expect(absent.detail).toContain('la shell arbitraria no está protegida');
    await fs.mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'ai-hub.cmd' : 'ai-hub'), '');
    const present = await checkReadCoverage({ root, targets: ['claude'], guardMode: 'enforce', optOuts: [], claudeHooks: true, env: { PATH: '' } });
    expect(present.detail).toContain('claude: efectiva');
  });
});

describe('documentación de la política de lectura (4.36, R-047, R-051)', () => {
  it('AGENTS.md §8 fija la tabla por modo y los límites frente a la shell arbitraria', async () => {
    const agents = await fs.readFile(path.resolve(__dirname, '..', '..', 'AGENTS.md'), 'utf8');
    const section = agents.slice(agents.indexOf('## 8. Guardias'), agents.indexOf('## 9.'));
    for (const text of ['| Caso | `shadow` | `enforce` |', 'read:unverifiable', 'policy.optOuts: [read]', 'la shell arbitraria **no** está protegida', 'note_type: guard', '`doctor` declara la política no efectiva']) {
      expect(section, text).toContain(text);
    }
  });
});

describe('eventos de lectura y búsqueda de Claude (4.32, R-051)', () => {
  it('el payload documentado en 1.9 (Read y Grep con todos sus campos) llega a la política', async () => {
    await consumer('enforce');
    const common = { session_id: 'doc-1-9', prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd: root, permission_mode: 'default', effort: 'medium', hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1' };
    const read = await runHook('pre', JSON.stringify({ ...common, tool_name: 'Read', tool_input: { file_path: path.join(root, '.env'), offset: 0, limit: 10 } }), root);
    expect(decision(read.output)).toBe('deny');
    const grep = await runHook('pre', JSON.stringify({ ...common, tool_name: 'Grep', tool_input: { pattern: 'TOKEN', path: path.join(home, '.ssh'), glob: '*', output_mode: 'content', '-i': true, multiline: false } }), root);
    expect(decision(grep.output)).toBe('deny');
    expect(JSON.stringify(grep.output)).toContain('read:ssh_key');
  });

  it('sync proyecta el hook pre para lecturas y búsquedas, y en shadow ninguna regla nativa bloquea', async () => {
    const { managedHooksFragment, PRE_TOOL_MATCHER } = await import('../src/sync/hooks.js');
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Bash']) {
      expect(PRE_TOOL_MATCHER.split('|')).toContain(tool);
    }
    await consumer('shadow');
    const fragment = JSON.stringify(managedHooksFragment());
    expect(fragment).toContain(PRE_TOOL_MATCHER);
    expect(fragment).not.toMatch(/permissions|"deny"/);
  });
});

describe('doctor informa los límites declarados (4.87, R-115)', () => {
  it('con la política habilitada y un aviso observado: capacidad, configuración y resultado; sin aviso: evidence_missing', async () => {
    const { verificationLimits, describeLimit } = await import('../src/harness/limits.js');
    const { loadManifestContext } = await import('../src/manifest/manifest.js');
    await consumer('shadow');
    const before = (await verificationLimits(root, (await loadManifestContext(root)).manifest)).find((item) => item.code === 'guard_coverage_limited')!;
    expect(before).toMatchObject({ capability: true, configuration: 'habilitado', observed: null });
    expect(describeLimit(before)).toContain('evidence_missing');
    await runHook('pre', claudeRead(path.join(root, '.env')), root);
    const after = (await verificationLimits(root, (await loadManifestContext(root)).manifest)).find((item) => item.code === 'guard_coverage_limited')!;
    expect(after.observed).toContain('read:env_file');
    expect(describeLimit(after)).not.toContain('evidence_missing');
    expect(describeLimit(after)).not.toMatch(/cumple/);
  });
});
