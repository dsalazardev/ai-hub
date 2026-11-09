import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifestContext, type ProjectManifest } from '../manifest/manifest.js';
import { SEALED_FILES, featureSeal } from '../speckit/seal.js';
import { shellCandidates } from '../speckit/commands.js';
import type { SpeckitSettings } from '../speckit/settings.js';
import type { ProcessRunner, RunResult } from '../speckit/runner.js';
import { flagString } from './args.js';
import type { CliContext, ParsedArgs } from './types.js';

/** Comandos del manifiesto que `gate` ejecuta, en orden; los ausentes se omiten. */
export const GATE_COMMANDS = ['typecheck', 'lint', 'test', 'verify'] as const;
const DEFAULT_WIP = 1;
const COMMAND_TIMEOUT_MS = 30 * 60_000;

export interface GateLine {
  id: string;
  ok: boolean;
  detail: string;
}

export interface FeatureState {
  name: string;
  missing: string[];
  inProgress: boolean;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Features de Spec Kit en `specs/`, con sus artefactos ausentes y si están a medio marcar. */
export async function readFeatures(root: string): Promise<FeatureState[]> {
  const specs = path.join(root, 'specs');
  const entries = await fs.readdir(specs, { withFileTypes: true }).catch(() => []);
  const features: FeatureState[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = path.join(specs, entry.name);
    const missing: string[] = [];
    for (const file of SEALED_FILES) {
      if (!(await exists(path.join(dir, file)))) {
        missing.push(file);
      }
    }
    const tasks = await fs.readFile(path.join(dir, 'tasks.md'), 'utf8').catch(() => '');
    const done = /^\s*[-*] \[[xX]\]/m.test(tasks);
    const open = /^\s*[-*] \[ \]/m.test(tasks);
    features.push({ name: entry.name, missing, inProgress: done && open });
  }
  return features;
}

export interface ResolvedShell {
  command: string;
  args: (script: string) => string[];
}

/**
 * Shell para los comandos del manifiesto, resuelto como los scripts de Spec Kit (F-12): se
 * ejecuta cada candidato en lugar de fiarse del PATH (en Windows `bash` puede ser el lanzador de
 * WSL sin distribución). Preferencia POSIX y, si no hay, PowerShell.
 */
export async function resolveCommandShell(
  runner: ProcessRunner,
  cwd: string,
  preferPowerShell = false,
): Promise<ResolvedShell | null> {
  const order: Array<'sh' | 'ps'> = preferPowerShell ? ['ps', 'sh'] : ['sh', 'ps'];
  for (const script of order) {
    for (const candidate of shellCandidates({ script } as SpeckitSettings)) {
      const probe = await runner(candidate.command, candidate.args, { cwd, timeoutMs: 30_000 });
      if (probe.status === 0 && probe.stdout.trim() === 'ok') {
        return script === 'sh'
          ? { command: candidate.command, args: (line) => ['-c', line] }
          : { command: candidate.command, args: (line) => ['-NoProfile', '-Command', line] };
      }
    }
  }
  return null;
}

function gateCommands(manifest: ProjectManifest): Array<[string, string]> {
  const seen = new Set<string>();
  const result: Array<[string, string]> = [];
  for (const id of GATE_COMMANDS) {
    const line = manifest.commands[id]?.trim();
    // Sin recursión: un comando que vuelve a llamar al gate (o a su alias) no se ejecuta.
    if (!line || seen.has(line) || /\bai-hub(?:-cli)?\s+(?:gate|verify)\b/.test(line)) {
      continue;
    }
    seen.add(line);
    result.push([id, line]);
  }
  return result;
}

function tail(result: RunResult, lines = 15): string {
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join('\n');
}

export interface GateOptions {
  seal?: string;
  feature?: string;
  quick?: boolean;
}

export interface GateReport {
  lines: GateLine[];
  ok: boolean;
  /** Entrada inválida: exit 2. */
  invalid?: string;
}

export async function runGate(root: string, runner: ProcessRunner, options: GateOptions): Promise<GateReport> {
  const lines: GateLine[] = [];
  let manifest: ProjectManifest;
  try {
    manifest = (await loadManifestContext(root)).manifest;
  } catch (error) {
    return { lines, ok: false, invalid: (error as Error).message };
  }
  const features = await readFeatures(root);
  if (features.length === 0) {
    lines.push({ id: 'gate:artifacts', ok: true, detail: 'sin features en specs/' });
  }
  for (const feature of features) {
    lines.push({
      id: `gate:artifacts`,
      ok: feature.missing.length === 0,
      detail:
        feature.missing.length === 0
          ? `specs/${feature.name}: spec, plan y tasks presentes`
          : `specs/${feature.name}: falta ${feature.missing.join(', ')}`,
    });
  }
  const wip = manifest.policy.wip ?? DEFAULT_WIP;
  const inProgress = features.filter((feature) => feature.inProgress).map((feature) => feature.name);
  lines.push({
    id: 'gate:wip',
    ok: inProgress.length <= wip,
    detail:
      inProgress.length <= wip
        ? `${inProgress.length} feature(s) en curso (máximo ${wip})`
        : `${inProgress.length} features en curso superan el máximo ${wip}: ${inProgress.join(', ')}`,
  });
  if (options.seal !== undefined) {
    const candidates = options.feature ? [options.feature] : inProgress.length === 1 ? inProgress : features.map((f) => f.name);
    if (candidates.length !== 1) {
      return { lines, ok: false, invalid: '--seal necesita --feature <NNN-slug> cuando hay más de una feature' };
    }
    const name = candidates[0];
    let actual: string | null = null;
    try {
      actual = await featureSeal(root, `specs/${name}`);
    } catch {
      actual = null;
    }
    const ok = actual !== null && actual === options.seal;
    lines.push({
      id: 'gate:seal',
      ok,
      detail: ok
        ? `specs/${name}: el sello coincide`
        : actual === null
          ? `specs/${name}: no se puede sellar (faltan artefactos)`
          : `specs/${name}: el sello no coincide con el aprobado (fail-closed)`,
    });
    if (!ok) {
      return { lines, ok: false };
    }
  }
  if (!options.quick) {
    const commands = gateCommands(manifest);
    if (commands.length > 0) {
      const preferPs = manifest.speckit?.script === 'ps';
      const shell = await resolveCommandShell(runner, root, preferPs);
      if (shell === null) {
        lines.push({ id: 'gate:shell', ok: false, detail: 'sin shell ejecutable (ni POSIX ni PowerShell)' });
      } else {
        for (const [id, line] of commands) {
          const result = await runner(shell.command, shell.args(line), { cwd: root, timeoutMs: COMMAND_TIMEOUT_MS });
          const ok = result.status === 0;
          lines.push({
            id: `gate:${id}`,
            ok,
            detail: ok ? `${line} (exit 0)` : `${line} (exit ${result.status ?? 'sin código'})\n${tail(result)}`,
          });
        }
      }
    }
  }
  return { lines, ok: lines.every((line) => line.ok) };
}

export async function cmdGate(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const sealFlag = args.flags.seal;
  if (sealFlag === true) {
    ctx.io.err('Uso: ai-hub gate [--seal <hash> [--feature <NNN-slug>]] [--quick]');
    return 2;
  }
  const report = await runGate(ctx.root, ctx.exec, {
    seal: flagString(args, 'seal') ?? undefined,
    feature: flagString(args, 'feature') ?? undefined,
    quick: Boolean(args.flags.quick),
  });
  for (const line of report.lines) {
    ctx.io.out(`${line.ok ? '[OK]  ' : '[FAIL]'} ${line.id}: ${line.detail}`);
  }
  if (report.invalid !== undefined) {
    ctx.io.err(report.invalid);
    return 2;
  }
  ctx.io.out(report.ok ? 'gate: verde' : 'gate: hay comprobaciones fallidas');
  return report.ok ? 0 : 1;
}
