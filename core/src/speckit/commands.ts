import { TARGETS } from '../sync/targets.js';
import { succeeded, type ProcessRunner } from './runner.js';
import type { SpeckitSettings } from './settings.js';

/** Argumentos de `uvx` que fijan el paquete y la fecha de resolución. */
export function uvxPrefix(settings: SpeckitSettings): string[] {
  return ['--from', `${settings.package}==${settings.version}`, '--exclude-newer', settings.excludeNewer, 'specify'];
}

/**
 * Secuencia de instalación (design D3, paso 9). Cada elemento son los argumentos de `uvx`.
 * Nunca incluye `extension add --force`: borra la extensión de la integración anterior.
 * `integration use` registra de forma aditiva las extensiones ya instaladas.
 */
export function speckitSequence(settings: SpeckitSettings): string[][] {
  if (settings.defaultIntegration === null) {
    return [];
  }
  const prefix = uvxPrefix(settings);
  const extensions = Object.keys(settings.extensions)
    .sort()
    .reverse()
    .flatMap((id) => ['--extension', id]);
  const steps: string[][] = [
    [
      ...prefix,
      'init',
      '.',
      '--here',
      '--force',
      '--non-interactive',
      '--integration',
      settings.defaultIntegration,
      '--script',
      settings.script,
      ...extensions,
    ],
  ];
  for (const integration of settings.integrations.slice(1)) {
    steps.push([...prefix, 'integration', 'install', integration, '--script', settings.script]);
    steps.push([...prefix, 'integration', 'use', integration]);
  }
  if (settings.integrations.length > 1) {
    steps.push([...prefix, 'integration', 'use', settings.defaultIntegration]);
  }
  return steps;
}

export interface SpeckitEnvironment {
  uvx: 'found' | 'missing';
  cached: 'yes' | 'no' | 'unknown';
  shell: 'found' | 'missing';
  shellCommand: string;
}

function shellCandidates(settings: SpeckitSettings): Array<{ command: string; args: string[] }> {
  return settings.script === 'ps'
    ? [
        { command: 'pwsh', args: ['-NoProfile', '-Command', 'echo ok'] },
        { command: 'powershell', args: ['-NoProfile', '-Command', 'echo ok'] },
      ]
    : [{ command: 'bash', args: ['-c', 'echo ok'] }];
}

/**
 * Ejecuta el shell en lugar de buscarlo en el PATH: en Windows `bash` puede ser el lanzador
 * de WSL, que existe pero no ejecuta sin una distribución instalada.
 */
export async function probeShell(
  settings: SpeckitSettings,
  runner: ProcessRunner,
  cwd: string,
): Promise<{ ok: boolean; command: string }> {
  const candidates = shellCandidates(settings);
  for (const candidate of candidates) {
    const result = await runner(candidate.command, candidate.args, { cwd, timeoutMs: 30_000 });
    if (succeeded(result) && result.stdout.trim() === 'ok') {
      return { ok: true, command: candidate.command };
    }
  }
  return { ok: false, command: candidates[0].command };
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
  if (uvx) {
    const offline = await runner('uvx', ['--offline', ...uvxPrefix(settings), '--version'], { cwd, timeoutMs: 60_000 });
    cached = succeeded(offline) ? 'yes' : 'no';
  }
  const shell = await probeShell(settings, runner, cwd);
  return {
    uvx: uvx ? 'found' : 'missing',
    cached,
    shell: shell.ok ? 'found' : 'missing',
    shellCommand: shell.command,
  };
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
}

/**
 * Preflight (design D3, paso 6). Se ejecuta antes de escribir cualquier archivo.
 * Comprueba uv, la resolución de la versión fijada (caché o red) y el shell del script declarado.
 */
export async function speckitPreflight(
  settings: SpeckitSettings,
  runner: ProcessRunner,
  cwd: string,
): Promise<PreflightResult> {
  const problems: string[] = [];
  if (!(await uvxAvailable(runner, cwd))) {
    problems.push(
      'uv no está disponible (uvx no está en el PATH). Instálalo: https://docs.astral.sh/uv/getting-started/installation/ ' +
        '— o repite con --no-speckit para instalar sin Spec Kit (el arnés quedará degradado).',
    );
    return { ok: false, problems };
  }
  const resolved = await runner('uvx', [...uvxPrefix(settings), '--version'], { cwd });
  if (!succeeded(resolved)) {
    problems.push(
      `no se pudo resolver ${settings.package}==${settings.version} con uvx: sin red y sin caché, o la versión no existe. ` +
        'Ejecuta una vez con red (uvx descarga y cachea la versión fijada) o usa --no-speckit.' +
        (resolved.stderr.trim() !== '' ? `\n${resolved.stderr.trim().split(/\r?\n/).slice(-3).join('\n')}` : ''),
    );
  }
  const shell = await probeShell(settings, runner, cwd);
  if (!shell.ok) {
    problems.push(
      settings.script === 'ps'
        ? 'PowerShell no está disponible (pwsh o powershell) y speckit.script es ps. Instala PowerShell o usa speckit.script: sh.'
        : 'bash no está disponible o no ejecuta `bash -c "echo ok"`, y speckit.script es sh. ' +
            'En Windows instala Git for Windows (Git Bash) y ponlo en el PATH; el lanzador de WSL sin distribución no sirve. ' +
            'Alternativa: declara speckit.script: ps en manifest.yaml.',
    );
  }
  return { ok: problems.length === 0, problems };
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
