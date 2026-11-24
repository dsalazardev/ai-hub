import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { acquireLock, projectLockPath, type LockHandle, type LockOptions } from '../harness/lock.js';

/**
 * Procesos del runner (R-095, R-096, R-097, R-098, R-102). Lock exclusivo del worktree con dueño; cancelación del
 * árbol completo del harness por timeout; clasificación del fallo según haya o no arrancado un proceso en el contexto
 * del proyecto (solo antes del arranque se prueba otro harness); marcadores de run para reconciliar efectos remotos
 * sin duplicarlos; issue por ejecución apagada por defecto e idempotente. La salida del harness se conserva solo en
 * memoria (la cola final, para leer la línea de cierre) y nunca se persiste.
 */

/** 5.10: lock exclusivo del worktree; un dueño vivo rechaza la nueva ejecución nombrándolo (`LockHeldError`). */
export async function lockWorktree(root: string, worktree: string, run: string, options: LockOptions = {}): Promise<LockHandle> {
  const key = createHash('sha256').update(path.resolve(worktree).toLowerCase()).digest('hex').slice(0, 16);
  return acquireLock(projectLockPath(root, `worktree-${key}`), `ejecución ${run} en el worktree`, { waitMs: 0, ...options });
}

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Cola de la salida estándar (como mucho `tailBytes`), solo en memoria. */
  tail: string;
  /** `false` si el binario no llegó a arrancar (ENOENT, EACCES): fallo anterior al arranque. */
  started: boolean;
  pid: number | null;
}

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  tailBytes?: number;
}

/** Termina el proceso y todos sus descendientes. Windows: `taskkill /T /F`; POSIX: señal al grupo del proceso. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ya terminó.
    }
  }
}

/** Ejecuta el harness con timeout; al vencer, cancela el árbol completo. */
export function runHarnessProcess(request: ProcessRequest): Promise<ProcessResult> {
  const started = Date.now();
  const limit = request.tailBytes ?? 8192;
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<ProcessResult, 'durationMs' | 'tail'>): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, tail, durationMs: Date.now() - started });
      }
    };
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...(request.env ?? {}) },
      stdio: ['ignore', 'pipe', 'ignore'],
      // POSIX: grupo propio para poder señalar a todo el árbol; Windows: taskkill /T recorre el árbol.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-limit);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        killTree(child.pid);
      }
    }, request.timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, timedOut, started: !['ENOENT', 'EACCES'].includes(error.code ?? ''), pid: child.pid ?? null });
    });
    child.on('close', (code) => {
      finish({ exitCode: code, timedOut, started: true, pid: child.pid ?? null });
    });
  });
}

/** Fase alcanzada por un intento: decide si el fallo admite probar otro harness. */
export type AttemptPhase = 'resolve' | 'version' | 'refused' | 'started' | 'task_delivered' | 'completed';

export type FailureDisposition = 'fallback' | 'reconcile';

/**
 * 5.11: solo los fallos anteriores a cualquier proceso en el contexto del proyecto (resolución del binario, versión
 * en un directorio temporal vacío, concesión o lock rechazados) admiten el siguiente harness. Desde que arranca un
 * proceso en el proyecto (hooks de arranque, plugins, sesión, entrega de la tarea) el fallo es incierto.
 */
export function classifyFailure(phase: AttemptPhase): FailureDisposition {
  return phase === 'resolve' || phase === 'version' || phase === 'refused' ? 'fallback' : 'reconcile';
}

export interface Attempt {
  harness: string;
  phase: AttemptPhase;
  ok: boolean;
  reason?: string;
}

export type FallbackOutcome =
  | { kind: 'completed'; harness: string; tried: Attempt[] }
  | { kind: 'held'; harness: string; tried: Attempt[] }
  | { kind: 'exhausted'; tried: Attempt[] };

/** Prueba los candidatos en orden; se detiene y retiene para reconciliar ante cualquier fallo tras el arranque. */
export async function runWithFallback(candidates: string[], attempt: (harness: string) => Promise<Attempt>): Promise<FallbackOutcome> {
  const tried: Attempt[] = [];
  for (const harness of candidates) {
    const result = await attempt(harness);
    tried.push(result);
    if (result.ok) {
      return { kind: 'completed', harness, tried };
    }
    if (classifyFailure(result.phase) === 'reconcile') {
      return { kind: 'held', harness, tried };
    }
  }
  return { kind: 'exhausted', tried };
}

/** 5.12: marcador del run en notas y peticiones remotas (comentario HTML: invisible al lector). */
export function runMarker(run: string): string {
  return `<!-- ai-hub:run=${run} -->`;
}

export interface NoteSink {
  issueNotes(iid: number): Promise<Array<{ body: string }>>;
  postIssueNote(iid: number, body: string): Promise<void>;
}

/** Publica la nota del run solo si una lectura completa no la encuentra ya (no asume exactly-once del tracker). */
export async function postNoteOnce(sink: NoteSink, iid: number, run: string, body: string): Promise<'posted' | 'already_present'> {
  const marker = runMarker(run);
  if ((await sink.issueNotes(iid)).some((note) => note.body.includes(marker))) {
    return 'already_present';
  }
  await sink.postIssueNote(iid, `${body}\n\n${marker}`);
  return 'posted';
}

export interface RunIssueSink {
  /** Lectura completa: issues cuya descripción lleva el marcador. */
  findIssuesWithMarker(marker: string): Promise<number[]>;
  createIssue(title: string, description: string): Promise<number>;
}

/** 5.16: issue por ejecución, apagada por defecto; con ella activa, una sola issue por run id aunque se reintente. */
export async function ensureRunIssue(
  sink: RunIssueSink,
  run: string,
  input: { enabled?: boolean; title: string; description: string },
): Promise<{ state: 'disabled' } | { state: 'existing' | 'created'; iid: number }> {
  if (input.enabled !== true) {
    return { state: 'disabled' };
  }
  const marker = runMarker(run);
  const found = await sink.findIssuesWithMarker(marker);
  if (found.length > 0) {
    return { state: 'existing', iid: Math.min(...found) };
  }
  return { state: 'created', iid: await sink.createIssue(input.title, `${input.description}\n\n${marker}`) };
}
