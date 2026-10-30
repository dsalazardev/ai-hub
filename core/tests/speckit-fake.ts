import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner, RunResult } from '../src/speckit/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_DIR = path.join(__dirname, 'fixtures', 'speckit-1.2.3');

/** Directorios de comandos que escribe cada integración en la instantánea grabada de 1.2.3. */
const COMMAND_DIRS: Record<string, string> = {
  claude: '.claude/skills',
  opencode: '.opencode/commands',
  pi: '.pi/prompts',
  'cursor-agent': '.cursor/skills',
};

const EXTENSION_IDS: Record<string, string[]> = {
  bug: ['speckit.bug.assess', 'speckit.bug.fix', 'speckit.bug.test'],
  assess: [
    'speckit.assess.intake',
    'speckit.assess.research',
    'speckit.assess.define',
    'speckit.assess.shape',
    'speckit.assess.decide',
  ],
};

export interface FakeOptions {
  missing?: Array<'uvx' | 'bash' | 'pwsh' | 'powershell' | 'python' | 'python3' | 'py'>;
  /** `bash` existe pero no ejecuta (lanzador de WSL sin distribución). */
  brokenBash?: boolean;
  /** Sin red y sin caché: el rango soportado no se resuelve. */
  offline?: boolean;
  /** Integraciones cuyo `integration use` se omite (sonda de la verificación 9d). */
  skipUse?: string[];
  /** Se invoca justo antes de reproducir `specify init` (para observar el orden respecto a sync). */
  onSpecifyInit?: (root: string) => Promise<void>;
  /** Versión que el fake responde a `specify --version` (por defecto, la última dentro del rango). */
  resolveVersion?: string;
}

export interface FakeRunner {
  run: ProcessRunner;
  calls: string[][];
  specifyCalls(): string[][];
}

function snapshotPath(rel: string): string {
  const [head, ...rest] = rel.split('/');
  return path.join(SNAPSHOT_DIR, `dot${head}`, ...rest);
}

async function listSnapshot(relDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(snapshotPath(rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        files.push(child);
      }
    }
  }
  await walk(relDir);
  return files.sort();
}

async function copyFromSnapshot(root: string, rel: string, preserve = false): Promise<void> {
  const dest = path.join(root, ...rel.split('/'));
  if (preserve && (await fs.access(dest).then(() => true, () => false))) {
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(snapshotPath(rel), dest);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

function extensionFile(integration: string, id: string): string {
  const dir = COMMAND_DIRS[integration];
  return integration === 'claude' || integration === 'cursor-agent'
    ? `${dir}/${id.replace(/\./g, '-')}/SKILL.md`
    : `${dir}/${id}.md`;
}

interface IntegrationState {
  installed_integrations: string[];
  integration_settings: Record<string, unknown>;
  integration: string;
  default_integration: string;
  [key: string]: unknown;
}

interface RegistryState {
  extensions: Record<string, { registered_commands: Record<string, string[]>; [key: string]: unknown }>;
  [key: string]: unknown;
}

async function writeIntegrationState(root: string, update: (state: IntegrationState) => void): Promise<void> {
  const file = path.join(root, '.specify', 'integration.json');
  const state = await readJson<IntegrationState>(file);
  update(state);
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function registerExtensions(root: string, integration: string): Promise<void> {
  const file = path.join(root, '.specify', 'extensions', '.registry');
  const registry = await readJson<RegistryState>(file);
  for (const [extension, ids] of Object.entries(EXTENSION_IDS)) {
    const entry = registry.extensions[extension];
    if (entry === undefined) {
      continue;
    }
    entry.registered_commands[integration] = ids;
    for (const id of ids) {
      await copyFromSnapshot(root, extensionFile(integration, id));
    }
  }
  await fs.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

async function installCore(root: string, integration: string): Promise<void> {
  const manifestRel = `.specify/integrations/${integration}.manifest.json`;
  await copyFromSnapshot(root, manifestRel);
  const manifest = await readJson<{ files: Record<string, string> }>(snapshotPath(manifestRel));
  for (const rel of Object.keys(manifest.files)) {
    await copyFromSnapshot(root, rel);
  }
}

type FakeScript = 'sh' | 'ps' | 'py';

/** Versión que el fake resuelve dentro del rango soportado (la última publicada, como uvx). */
export const FAKE_VERSION = '1.2.5';

const SCRIPT_DIRS: Record<FakeScript, string> = { sh: 'bash', ps: 'powershell', py: 'python' };
const SCRIPT_EXTS: Record<FakeScript, string> = { sh: '.sh', ps: '.ps1', py: '.py' };

function scriptOf(args: string[]): FakeScript {
  const value = args[args.indexOf('--script') + 1];
  return value === 'ps' ? 'ps' : value === 'py' ? 'py' : 'sh';
}

/**
 * Efecto de `--script` sobre `.specify/`: el campo `script` de init-options.json y el directorio
 * de scripts del tipo elegido. Los init se ACUMULAN (evidencia medida): cada tipo añade su
 * directorio sin borrar los demás, y el manifiesto de integridad se reconstruye desde los
 * directorios que existen en disco. La instantánea grabada es de una instalación bash;
 * `ps` y `py` son aproximaciones con los mismos scripts renombrados (hash conservado).
 */
async function applyScript(root: string, script: FakeScript): Promise<void> {
  const optionsFile = path.join(root, '.specify', 'init-options.json');
  const options = await readJson<Record<string, unknown>>(optionsFile);
  options.script = script;
  await fs.writeFile(optionsFile, `${JSON.stringify(options, null, 2)}\n`, 'utf8');
  const scriptsDir = path.join(root, '.specify', 'scripts');
  // Un init real crea sólo el directorio de su tipo, desde el material bash de la
  // instantánea; los directorios existentes se acumulan sin borrarse (evidencia medida).
  const targetDir = path.join(scriptsDir, SCRIPT_DIRS[script]);
  await fs.mkdir(targetDir, { recursive: true });
  for (const rel of await listSnapshot('.specify/scripts/bash')) {
    const name = path.basename(rel);
    await fs.copyFile(snapshotPath(rel), path.join(targetDir, name.replace(/\.sh$/, SCRIPT_EXTS[script])));
  }
  // El manifiesto declara lo que hay en disco: 6 entradas por directorio existente.
  // Los hashes de los scripts vienen del manifiesto de la instantánea (instalación bash
  // grabada): el manifiesto actual puede haber retirado las entradas bash en un init
  // anterior, y un init posterior de `sh` debe poder recuperarlas.
  const manifestFile = path.join(root, '.specify', 'integrations', 'speckit.manifest.json');
  const manifest = await readJson<{ files: Record<string, string> }>(manifestFile);
  const snapshotManifest = await readJson<{ files: Record<string, string> }>(
    snapshotPath('.specify/integrations/speckit.manifest.json'),
  );
  const bashHashes: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(snapshotManifest.files)) {
    const bashMatch = /^\.specify\/scripts\/bash\/(.+)$/.exec(rel);
    if (bashMatch !== null) {
      bashHashes[bashMatch[1]] = hash;
    }
  }
  const files: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (!rel.startsWith('.specify/scripts/')) {
      files[rel] = hash;
    }
  }
  for (const dir of await fs.readdir(scriptsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue;
    }
    for (const file of await fs.readdir(path.join(scriptsDir, dir.name))) {
      const rel = `.specify/scripts/${dir.name}/${file}`;
      if (files[rel] !== undefined) {
        continue;
      }
      const hash = bashHashes[file.replace(/\.(ps1|py)$/, '.sh')];
      if (hash !== undefined) {
        files[rel] = hash;
      }
    }
  }
  manifest.files = files;
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function specifyInit(root: string, integration: string, script: FakeScript, version: string): Promise<void> {
  for (const rel of await listSnapshot('.specify')) {
    if (rel.startsWith('.specify/integrations/') && !rel.endsWith('/speckit.manifest.json')) {
      continue;
    }
    if (rel.startsWith('.specify/scripts/')) {
      // Los directorios de scripts los materializa applyScript: sólo el del tipo
      // elegido, acumulando sin borrar los existentes.
      continue;
    }
    await copyFromSnapshot(root, rel, rel === '.specify/memory/constitution.md');
  }
  await installCore(root, integration);
  await writeIntegrationState(root, (state) => {
    state.installed_integrations = [integration];
    state.integration_settings = { [integration]: (state.integration_settings as Record<string, unknown>)[integration] };
    state.integration = integration;
    state.default_integration = integration;
  });
  const registryFile = path.join(root, '.specify', 'extensions', '.registry');
  const registry = await readJson<RegistryState>(registryFile);
  for (const entry of Object.values(registry.extensions)) {
    entry.registered_commands = {};
  }
  await fs.writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await registerExtensions(root, integration);
  // La versión registrada es la que el sondeo resolvió, no la de la instantánea.
  const optionsFile = path.join(root, '.specify', 'init-options.json');
  const options = await readJson<Record<string, unknown>>(optionsFile);
  options.speckit_version = version;
  await fs.writeFile(optionsFile, `${JSON.stringify(options, null, 2)}\n`, 'utf8');
  await applyScript(root, script);
}

function ok(stdout = ''): RunResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr: string, status = 1): RunResult {
  return { status, stdout: '', stderr };
}

function notFound(command: string): RunResult {
  return { status: null, stdout: '', stderr: '', error: `spawn ${command} ENOENT` };
}

/** Runner que reproduce sobre `cwd` el efecto de cada invocación de Spec Kit, resolviendo la última versión del rango. */
export function fakeRunner(options: FakeOptions = {}): FakeRunner {
  const calls: string[][] = [];
  const missing = new Set(options.missing ?? []);
  const run: ProcessRunner = async (command, args, runOptions) => {
    calls.push([command, ...args]);
    if (missing.has(command as 'uvx')) {
      return notFound(command);
    }
    if (command === 'bash') {
      return options.brokenBash ? fail('WSL: no hay distribuciones instaladas') : ok('ok\n');
    }
    if (command === 'pwsh' || command === 'powershell' || command === 'python' || command === 'python3' || command === 'py') {
      return ok('ok\n');
    }
    if (command !== 'uvx') {
      return notFound(command);
    }
    if (args[0] === '--version') {
      return ok('uv 0.12.18\n');
    }
    const at = args.indexOf('specify');
    if (at < 0) {
      return fail('uso inesperado de uvx');
    }
    if (options.offline) {
      return fail('error: Failed to fetch: `https://pypi.org/simple/specify-cli/`', 2);
    }
    const sub = args.slice(at + 1);
    const root = runOptions.cwd;
    const version = options.resolveVersion ?? FAKE_VERSION;
    if (sub[0] === '--version') {
      return ok(`specify ${version}\n`);
    }
    if (sub[0] === 'init') {
      await options.onSpecifyInit?.(root);
      const integration = sub[sub.indexOf('--integration') + 1];
      await specifyInit(root, integration, scriptOf(sub), version);
      return ok('Project ready.\n');
    }
    if (sub[0] === 'integration' && sub[1] === 'install') {
      await installCore(root, sub[2]);
      await writeIntegrationState(root, (state) => {
        if (!state.installed_integrations.includes(sub[2])) {
          state.installed_integrations.push(sub[2]);
        }
        state.integration_settings[sub[2]] = { script: scriptOf(sub), invoke_separator: sub[2] === 'opencode' || sub[2] === 'pi' ? '.' : '-' };
      });
      return ok(`Integration '${sub[2]}' installed successfully\n`);
    }
    if (sub[0] === 'integration' && sub[1] === 'use') {
      if ((options.skipUse ?? []).includes(sub[2])) {
        return ok('');
      }
      await registerExtensions(root, sub[2]);
      await writeIntegrationState(root, (state) => {
        state.integration = sub[2];
        state.default_integration = sub[2];
      });
      return ok(`Default integration set to ${sub[2]}.\n`);
    }
    return fail(`subcomando no soportado por el fake: ${sub.join(' ')}`);
  };
  return {
    run,
    calls,
    specifyCalls: () => calls.filter((call) => call[0] === 'uvx' && call.includes('specify')),
  };
}
