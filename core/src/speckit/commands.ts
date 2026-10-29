import path from 'node:path';
import { existsSync } from 'node:fs';
import { TARGETS } from '../sync/targets.js';
import { succeeded, type ProcessRunner } from './runner.js';
import type { SpeckitSettings } from './settings.js';
import { parseSpecifyVersion, uvxRange } from './version.js';

/**
 * Argumentos de `uvx` que fijan el paquete: el rango soportado como única fuente,
 * o la versión exacta cuando el proyecto la declara (design D6). Nunca una fecha de resolución.
 */
export function uvxPrefix(settings: SpeckitSettings): string[] {
  const requirement =
    settings.version === null
      ? `${settings.package}${uvxRange(settings.supported)}`
      : `${settings.package}==${settings.version}`;
  return ['--from', requirement, 'specify'];
}

/**
 * Secuencia de instalación (design D1, D3). Cada elemento son los argumentos de `uvx`.
 * Antepone un `specify init` por cada script no elegido y deja el elegido al final: los init
 * se acumulan sin pisarse, así una sola invocación del usuario deja los tres directorios y
 * `init-options.json` registra el script elegido. Nunca incluye `extension add --force`.
 * `integration use` registra de forma aditiva las extensiones ya instaladas.
 */
export function speckitSequence(settings: SpeckitSettings): string[][] {
  const defaultIntegration = settings.defaultIntegration;
  if (defaultIntegration === null) {
    return [];
  }
  const prefix = uvxPrefix(settings);
  const extensions = Object.keys(settings.extensions)
    .sort()
    .reverse()
    .flatMap((id) => ['--extension', id]);
  const initFor = (script: 'sh' | 'ps' | 'py'): string[] => [
    ...prefix,
    'init',
    '.',
    '--here',
    '--force',
    '--non-interactive',
    '--integration',
    defaultIntegration,
    '--script',
    script,
    ...extensions,
  ];
  const steps: string[][] = (['sh', 'ps', 'py'] as const)
    .filter((script) => script !== settings.script)
    .map((script) => initFor(script));
  steps.push(initFor(settings.script));
  for (const integration of settings.integrations.slice(1)) {
    steps.push([...prefix, 'integration', 'install', integration, '--script', settings.script]);
    steps.push([...prefix, 'integration', 'use', integration]);
  }
  if (settings.integrations.length > 1) {
    steps.push([...prefix, 'integration', 'use', defaultIntegration]);
  }
  return steps;
}

export interface SpeckitEnvironment {
  uvx: 'found' | 'missing';
  cached: 'yes' | 'no' | 'unknown';
  /** Versión que `uvx` resuelve dentro del rango; null si no se pudo resolver. */
  version: string | null;
  shell: 'found' | 'missing';
  shellCommand: string;
}

export interface ShellCandidate {
  command: string;
  args: string[];
}

/**
 * Rutas estándar de Git for Windows (design D1), construidas desde el entorno del proceso;
 * una variable ausente omite sus candidatos. Nunca hay rutas de usuario hardcodeadas.
 */
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const programFiles = env['ProgramFiles'];
  const programFilesX86 = env['ProgramFiles(x86)'];
  const localAppData = env['LOCALAPPDATA'];
  if (programFiles !== undefined) {
    candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  }
  if (programFilesX86 !== undefined) {
    candidates.push(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  }
  if (localAppData !== undefined) {
    candidates.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  if (programFiles !== undefined) {
    candidates.push(path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  return candidates;
}

/**
 * Candidatos del script declarado, en orden de preferencia. Para `sh` en Windows va primero el
 * `bash` del PATH y después las rutas estándar de Git for Windows; en Linux y macOS sólo el del PATH.
 */
export function shellCandidates(
  settings: SpeckitSettings,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellCandidate[] {
  if (settings.script === 'ps') {
    return [
      { command: 'pwsh', args: ['-NoProfile', '-Command', 'echo ok'] },
      { command: 'powershell', args: ['-NoProfile', '-Command', 'echo ok'] },
    ];
  }
  if (platform !== 'win32') {
    return [{ command: 'bash', args: ['-c', 'echo ok'] }];
  }
  return [
    { command: 'bash', args: ['-c', 'echo ok'] },
    ...gitBashCandidates(env).map((command) => ({ command, args: ['-c', 'echo ok'] })),
  ];
}

export interface ShellProbe {
  ok: boolean;
  command: string;
  /** Comandos probados en orden; las rutas absolutas inexistentes no se prueban. */
  tried: string[];
}

/**
 * Ejecuta el shell en lugar de buscarlo en el PATH: en Windows `bash` puede ser el lanzador
 * de WSL, que existe pero no ejecuta sin una distribución instalada.
 */
export async function probeShell(
  settings: SpeckitSettings,
  runner: ProcessRunner,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShellProbe> {
  const candidates = shellCandidates(settings, platform, env).filter(
    (candidate) => !path.isAbsolute(candidate.command) || existsSync(candidate.command),
  );
  const tried: string[] = [];
  for (const candidate of candidates) {
    tried.push(candidate.command);
    const result = await runner(candidate.command, candidate.args, { cwd, timeoutMs: 30_000 });
    if (succeeded(result) && result.stdout.trim() === 'ok') {
      return { ok: true, command: candidate.command, tried };
    }
  }
  return { ok: false, command: candidates[0]?.command ?? 'bash', tried };
}

async function uvxAvailable(runner: ProcessRunner, cwd: string): Promise<boolean> {
  return succeeded(await runner('uvx', ['--version'], { cwd, timeoutMs: 30_000 }));
}

/** Sonda del entorno para el plan: describe la máquina y no entra en el hash. */
export async function probeEnvironment(
  settings: SpeckitSettings,
  runner: ProcessRunner,
  cwd: string,
): Promise<SpeckitEnvironment> {
  const uvx = await uvxAvailable(runner, cwd);
  let cached: SpeckitEnvironment['cached'] = 'unknown';
  let version: string | null = null;
  if (uvx) {
    const offline = await runner('uvx', ['--offline', ...uvxPrefix(settings), '--version'], { cwd, timeoutMs: 60_000 });
    cached = succeeded(offline) ? 'yes' : 'no';
    // La versión resuelta es la del sondeo real: caché si la hay, red si no.
    const probe = cached === 'yes' ? offline : await runner('uvx', [...uvxPrefix(settings), '--version'], { cwd });
    version = succeeded(probe) ? parseSpecifyVersion(probe.stdout) : null;
  }
  const shell = await probeShell(settings, runner, cwd);
  return {
    uvx: uvx ? 'found' : 'missing',
    cached,
    version,
    shell: shell.ok ? 'found' : 'missing',
    shellCommand: shell.command,
  };
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  /** Versión que `uvx` resolvió dentro del rango; null si no se pudo resolver. */
  version: string | null;
}

/**
 * Preflight (design D3, paso 6). Se ejecuta antes de escribir cualquier archivo.
 * Comprueba uv, la resolución de la versión fijada (caché o red) y el shell del script declarado.
 * `command` nombra la bandera exacta en el mensaje; nunca se remite a un manifest que no existe.
 */
export async function speckitPreflight(
  settings: SpeckitSettings,
  runner: ProcessRunner,
  cwd: string,
  command: 'init' | 'install' = 'init',
): Promise<PreflightResult> {
  const problems: string[] = [];
  if (!(await uvxAvailable(runner, cwd))) {
    problems.push(
      'uv no está disponible (uvx no está en el PATH). Instálalo: https://docs.astral.sh/uv/getting-started/installation/ ' +
        '— o repite con --no-speckit para instalar sin Spec Kit (el arnés quedará degradado).',
    );
    return { ok: false, problems, version: null };
  }
  const resolved = await runner('uvx', [...uvxPrefix(settings), '--version'], { cwd });
  if (!succeeded(resolved)) {
    problems.push(
      `no se pudo resolver el rango soportado de ${settings.package} (${settings.supported}) con uvx: sin red y sin caché, o el rango no tiene ninguna versión estable. ` +
        'Ejecuta una vez con red (uvx descarga y cachea la última versión del rango) o usa --no-speckit.' +
        (resolved.stderr.trim() !== '' ? `\n${resolved.stderr.trim().split(/\r?\n/).slice(-3).join('\n')}` : ''),
    );
  }
  const version = succeeded(resolved) ? parseSpecifyVersion(resolved.stdout) : null;
  const shell = await probeShell(settings, runner, cwd);
  if (!shell.ok) {
    problems.push(
      settings.script === 'ps'
        ? `PowerShell no ejecuta \`echo ok\` (probados: ${shell.tried.join(', ')}). ` +
            `Instala PowerShell (pwsh o powershell). Alternativa: ai-hub ${command} --script sh.`
        : `ningún bash ejecuta \`bash -c "echo ok"\` (probados: ${shell.tried.join(', ')}). ` +
            'En Windows instala Git for Windows (Git Bash); el lanzador de WSL sin distribución no sirve. ' +
            `Alternativa sin bash: ai-hub ${command} --script ps.`,
    );
  }
  return { ok: problems.length === 0, problems, version };
}

export interface SpeckitRunResult {
  ok: boolean;
  steps: string[][];
  failure: string | null;
}

/** Ejecuta la secuencia de instalación en `root`. Se detiene en el primer paso fallido. */
export async function runSpeckitSequence(
  settings: SpeckitSettings,
  runner: ProcessRunner,
  root: string,
): Promise<SpeckitRunResult> {
  const steps = speckitSequence(settings);
  for (const step of steps) {
    const result = await runner('uvx', step, { cwd: root });
    if (!succeeded(result)) {
      const detail = (result.error ?? result.stderr ?? result.stdout).trim().split(/\r?\n/).slice(-5).join('\n');
      return { ok: false, steps, failure: `uvx ${step.join(' ')} falló (${result.status ?? 'sin código'}): ${detail}` };
    }
  }
  return { ok: true, steps, failure: null };
}

/** Comando de Spec Kit en la notación de un destino: `/speckit-bug-assess` o `/speckit.bug.assess`. */
export function invocationFor(canonical: string, separator: '-' | '.'): string {
  return `/${canonical.replace(/\./g, separator)}`;
}

export function speckitTargetOf(tool: keyof typeof TARGETS): (typeof TARGETS)[keyof typeof TARGETS]['speckit'] {
  return TARGETS[tool].speckit;
}
