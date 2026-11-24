/**
 * Descubrimiento, sondas y selección de harnesses (R-091, R-092, R-116). Presencia, compatibilidad y operabilidad se
 * informan por separado; la operabilidad solo la decide un comando de estado documentado y declarado con su
 * evidencia, ejecutado fuera del proyecto, y nada aquí lee archivos de credenciales (el módulo no abre archivos: solo
 * recibe un resolutor de binarios, un ejecutor y un directorio temporal vacío). Una sonda de diagnóstico da
 * `diagnosed`, nunca `operable`. Mientras el experimento 2.6 no verifique los comandos de estado, ningún harness real
 * declara uno: todos son «no verificable» y la ejecución real queda deshabilitada por construcción.
 */

export const DEFAULT_HARNESS_ORDER = ['claude', 'codex', 'opencode'] as const;

export interface CommandDeclaration {
  args: string[];
  /** Cita de la evidencia (documentación o experimento) que fija el comando y sus efectos. */
  evidence: string;
}

export interface StatusDeclaration extends CommandDeclaration {
  /** Interpreta el resultado del comando de estado; nunca recibe ni devuelve secretos. */
  operable(result: { exitCode: number | null; stdout: string }): boolean;
}

export interface SessionDeclaration {
  /** Extrae el id de sesión de la salida, si el harness lo expone. */
  sessionId(stdout: string): string | null;
  /** Argumentos para reanudar una sesión registrada. */
  resumeArgs(sessionId: string): string[];
  evidence: string;
}

export interface HarnessDeclaration {
  id: string;
  binary: string;
  version: CommandDeclaration & { parse(stdout: string): string | null; range: { min: string; max: string } | null };
  status: StatusDeclaration | null;
  probe: CommandDeclaration | null;
  /** Argumentos de ejecución sin interfaz con la tarea; `null` = no verificado, no se lanza. */
  /**
   * Ejecución sin interfaz medida: argumentos y lectura de su salida (texto final, del que sale la línea de cierre, e id
   * de sesión). `null` = no verificada, no se lanza.
   */
  headless: (CommandDeclaration & { build(task: string): string[]; output(stdout: string): { text: string; sessionId: string | null } }) | null;
  session: SessionDeclaration | null;
}

const semver = (stdout: string): string | null => /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

const EVIDENCE_26 = '.planning/findings.md › Hito 2 › 2.6 (2026-11-24)';

/**
 * Declaraciones por harness y versión (2.6, D-31). Solo lo medido: el rango de versiones se cierra en la versión
 * medida; la ejecución sin interfaz usa los argumentos medidos (sin permisos de escritura: escribir no se midió). Una
 * verificación de un harness no habilita a otro.
 */
export const HARNESS_DECLARATIONS: readonly HarnessDeclaration[] = [
  {
    id: 'claude',
    binary: 'claude',
    version: { args: ['--version'], evidence: EVIDENCE_26, parse: semver, range: { min: '2.1.330', max: '2.1.330' } },
    // `claude auth status`: JSON con `loggedIn`, salida 0; sin secretos (correo y organización no se leen).
    status: { args: ['auth', 'status'], evidence: EVIDENCE_26, operable: ({ exitCode, stdout }) => exitCode === 0 && /"loggedIn"\s*:\s*true/.test(stdout) },
    probe: null,
    headless: {
      args: ['-p', '<tarea>', '--output-format', 'json'],
      evidence: EVIDENCE_26,
      build: (task) => ['-p', task, '--output-format', 'json'],
      output: (stdout) => {
        const result = jsonLines(stdout).find((event) => event.type === 'result') ?? {};
        return { text: typeof result.result === 'string' ? result.result : '', sessionId: typeof result.session_id === 'string' ? result.session_id : null };
      },
    },
    session: {
      sessionId: (stdout) => {
        const result = jsonLines(stdout).find((event) => event.type === 'result') ?? {};
        return typeof result.session_id === 'string' ? result.session_id : null;
      },
      resumeArgs: (id) => ['--resume', id],
      evidence: EVIDENCE_26,
    },
  },
  {
    id: 'codex',
    binary: 'codex',
    version: { args: ['--version'], evidence: EVIDENCE_26, parse: semver, range: { min: '0.172.0', max: '0.172.0' } },
    // `codex login status`: documentado como salida 0 con credenciales; el texto («Logged in using …») va a stderr, que
    // no se captura (2.6). La operabilidad se decide solo por la salida 0.
    status: { args: ['login', 'status'], evidence: EVIDENCE_26, operable: ({ exitCode }) => exitCode === 0 },
    probe: null,
    headless: {
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '<tarea>'],
      evidence: EVIDENCE_26,
      build: (task) => ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', task],
      output: (stdout) => {
        const events = jsonLines(stdout);
        const thread = events.find((event) => event.type === 'thread.started');
        const messages = events
          .filter((event) => event.type === 'item.completed')
          .map((event) => (event.item ?? {}) as Record<string, unknown>)
          .filter((item) => item.type === 'agent_message' && typeof item.text === 'string');
        return { text: messages.length > 0 ? String(messages[messages.length - 1].text) : '', sessionId: typeof thread?.thread_id === 'string' ? thread.thread_id : null };
      },
    },
    session: {
      sessionId: (stdout) => {
        const thread = jsonLines(stdout).find((event) => event.type === 'thread.started');
        return typeof thread?.thread_id === 'string' ? thread.thread_id : null;
      },
      resumeArgs: (id) => ['exec', 'resume', id, '--json', '--skip-git-repo-check'],
      evidence: EVIDENCE_26,
    },
  },
  {
    // OpenCode 2.3.2: `auth list` solo lista credenciales guardadas, no valida la sesión → no verificable. Además, sin
    // interfaz ejecuta herramientas de lectura sin aprobación (2.6). No seleccionable.
    id: 'opencode',
    binary: 'opencode',
    version: { args: ['--version'], evidence: EVIDENCE_26, parse: semver, range: null },
    status: null,
    probe: null,
    headless: null,
    session: null,
  },
];

export type Operability = 'operable' | 'not_operable' | 'not_verifiable';

export interface Discovery {
  id: string;
  present: boolean;
  version: string | null;
  compatible: boolean | 'unknown';
  operability: Operability | null;
  /** Motivo por el que no es elegible; `null` si lo es. */
  reason: string | null;
}

export interface DiscoveryDeps {
  resolveBinary(binary: string): Promise<string | null>;
  /** Ejecuta un comando en `cwd` (siempre un directorio temporal vacío fuera de proyectos) con timeout. */
  run(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number | null; stdout: string; started: boolean }>;
  /** Directorio temporal vacío, fuera de cualquier proyecto. */
  emptyDir(): Promise<string>;
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export async function discoverHarness(declaration: HarnessDeclaration, deps: DiscoveryDeps, timeoutMs = 10_000): Promise<Discovery> {
  const base = { id: declaration.id, version: null, compatible: 'unknown' as const, operability: null };
  const binary = await deps.resolveBinary(declaration.binary);
  if (binary === null) {
    return { ...base, present: false, reason: 'binario ausente' };
  }
  const cwd = await deps.emptyDir();
  const versionRun = await deps.run(binary, declaration.version.args, { cwd, timeoutMs });
  const version = versionRun.exitCode === 0 ? declaration.version.parse(versionRun.stdout) : null;
  const range = declaration.version.range;
  const compatible: boolean | 'unknown' = version === null || range === null ? 'unknown' : compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0;
  if (compatible === false) {
    return { ...base, present: true, version, compatible, reason: `versión ${version} fuera del rango ${range?.min}–${range?.max}` };
  }
  if (declaration.status === null) {
    return { ...base, present: true, version, compatible, operability: 'not_verifiable', reason: 'no verificable: sin comando de estado documentado y verificado' };
  }
  const status = await deps.run(binary, declaration.status.args, { cwd, timeoutMs });
  const operable = status.started && declaration.status.operable({ exitCode: status.exitCode, stdout: status.stdout });
  if (!operable) {
    return { ...base, present: true, version, compatible, operability: 'not_operable', reason: 'no operativo: el comando de estado no informa una sesión válida' };
  }
  if (compatible === 'unknown') {
    return { ...base, present: true, version, compatible, operability: 'operable', reason: 'compatibilidad sin verificar: sin rango de versiones declarado' };
  }
  return { ...base, present: true, version, compatible, operability: 'operable', reason: null };
}

export interface Selection {
  selected: Discovery | null;
  /** Elegibles en orden (el primero es el seleccionado; los demás, candidatos de fallback). */
  eligible: Discovery[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Orden configurable (por defecto Claude Code, Codex, OpenCode): el primero presente, compatible y operable. */
export async function selectHarness(
  declarations: readonly HarnessDeclaration[],
  deps: DiscoveryDeps,
  order: readonly string[] = DEFAULT_HARNESS_ORDER,
): Promise<Selection> {
  const eligible: Discovery[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of order) {
    const declaration = declarations.find((item) => item.id === id);
    if (declaration === undefined) {
      skipped.push({ id, reason: 'sin declaración para este harness' });
      continue;
    }
    const found = await discoverHarness(declaration, deps);
    if (found.reason === null) {
      eligible.push(found);
    } else {
      skipped.push({ id, reason: found.reason });
    }
  }
  return { selected: eligible[0] ?? null, eligible, skipped };
}

export function describeNoCandidate(skipped: Array<{ id: string; reason: string }>): string {
  return `ningún harness elegible: ${skipped.map((item) => `${item.id} (${item.reason})`).join('; ')}`;
}

export type ProbeResult = { result: 'capability_unverified'; started: false } | { result: 'diagnosed'; started: true; exitCode: number | null };

/** Sonda de diagnóstico: solo la declarada, fuera de proyectos y sin tarea; nunca hace operable al harness. */
export async function runProbe(declaration: HarnessDeclaration, deps: DiscoveryDeps, timeoutMs = 10_000): Promise<ProbeResult> {
  if (declaration.probe === null) {
    return { result: 'capability_unverified', started: false };
  }
  const binary = await deps.resolveBinary(declaration.binary);
  if (binary === null) {
    return { result: 'capability_unverified', started: false };
  }
  const run = await deps.run(binary, declaration.probe.args, { cwd: await deps.emptyDir(), timeoutMs });
  return { result: 'diagnosed', started: true, exitCode: run.exitCode };
}
