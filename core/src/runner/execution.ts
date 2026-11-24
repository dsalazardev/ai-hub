import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendRunEvent, newRunId } from '../harness/runs.js';
import { loadEngine } from '../engine/engine.js';
import { loadManifest } from '../manifest/manifest.js';
import { PACKAGE_VERSION } from '../package-info.js';
import { parseStatusLine, statusContract, type StatusLine } from '../speckit/status.js';
import { LOCK_PATH, readLock } from '../sync/lock.js';
import { TARGETS, isToolId, type ToolId } from '../sync/targets.js';

/**
 * Lado del runner sobre una ejecución (R-100, R-101, R-103, R-107). Asigna el run id compartido y lo registra en
 * `runs` v2 sin salida capturada; verifica el contexto canónico antes de arrancar (proyecto, worktree, proyección
 * del destino y lock fresco) y acepta un resultado solo si la línea de cierre nombra ese run. Que el cierre lleve el
 * run id no prueba que el harness usara las reglas o skills canónicas: el uso del contexto queda «no observado».
 * El runner no escribe ninguna ruta de Spec Kit: solo telemetría bajo `.ai-hub/runs/`.
 */

/** Variable de entorno con la que el harness recibe el run id asignado. */
export const RUN_ID_ENV = 'AI_HUB_RUN_ID';

export interface RunAssignment {
  harness: string;
  harnessVersion: string;
  links?: { issue?: number; change_request?: number; commit?: string };
  now?: Date;
}

/** 5.15: asigna el run id con el formato de `newRunId`, lo registra y lo devuelve al llamador. */
export async function assignRun(root: string, input: RunAssignment): Promise<string> {
  const now = input.now ?? new Date();
  const run = newRunId(now);
  await appendRunEvent(root, {
    ts: now.toISOString(),
    run,
    kind: 'start',
    harness: input.harness,
    harness_version: input.harnessVersion,
    origin: 'runner',
    ...(input.links ? { links: input.links } : {}),
  });
  return run;
}

/** Entorno adicional del proceso del harness: solo el run id, nunca credenciales. */
export function harnessEnvironment(run: string): Record<string, string> {
  return { [RUN_ID_ENV]: run };
}

export type ContextRefusal = 'manifest_unreadable' | 'project_mismatch' | 'unknown_target' | 'projection_missing' | 'lock_stale';

export interface ContextIdentity {
  project: string;
  worktree: string;
  target: ToolId;
  engineVersion: string;
  lockHash: string;
  speckit: string;
}

export type ContextCheck = { ok: true; identity: ContextIdentity } | { ok: false; reason: ContextRefusal; detail: string };

export interface ContextRequest {
  worktree: string;
  /** Id del proyecto concedido (`manifest.project.id`). */
  project: string;
  target: string;
}

export interface ContextDeps {
  /** Comprobación del lock de sync (por defecto `checkLock`); inyectable para no renderizar en pruebas. */
  lockFresh?: (worktree: string) => Promise<boolean>;
}

async function defaultLockFresh(worktree: string): Promise<boolean> {
  const { checkLock } = await import('../sync/sync.js');
  return (await checkLock(worktree)).ok;
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

/** 5.14: verificación previa del contexto canónico. No escribe nada. */
export async function verifyCanonicalContext(request: ContextRequest, deps: ContextDeps = {}): Promise<ContextCheck> {
  let manifest;
  try {
    manifest = await loadManifest(request.worktree);
  } catch (error) {
    return { ok: false, reason: 'manifest_unreadable', detail: `el worktree no tiene un manifest.yaml válido (${(error as Error).name})` };
  }
  if (manifest.project.id !== request.project) {
    return { ok: false, reason: 'project_mismatch', detail: `el worktree es del proyecto ${manifest.project.id}, no del concedido ${request.project}` };
  }
  if (!isToolId(request.target)) {
    return { ok: false, reason: 'unknown_target', detail: `destino desconocido: ${request.target}` };
  }
  const target = request.target;
  const lock = await readLock(request.worktree).catch(() => null);
  const prefixes = [TARGETS[target].skills, TARGETS[target].agents, TARGETS[target].rules].filter((item): item is string => item !== null);
  const projected = lock === null ? [] : Object.keys(lock.files).filter((file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  const present = await Promise.all(projected.map((file) => exists(path.join(request.worktree, file))));
  if (!manifest.targets.includes(target) || projected.length === 0 || present.includes(false)) {
    return { ok: false, reason: 'projection_missing', detail: `falta la proyección de ${target} en el worktree (ejecuta ai-hub sync)` };
  }
  if (!(await (deps.lockFresh ?? defaultLockFresh)(request.worktree))) {
    return { ok: false, reason: 'lock_stale', detail: `${LOCK_PATH} no coincide con lo que generaría sync` };
  }
  const lockText = await fs.readFile(path.join(request.worktree, LOCK_PATH), 'utf8');
  return {
    ok: true,
    identity: {
      project: manifest.project.id,
      worktree: path.resolve(request.worktree),
      target,
      engineVersion: PACKAGE_VERSION,
      lockHash: createHash('sha256').update(lockText).digest('hex'),
      speckit: manifest.speckit?.version ?? 'no declarado',
    },
  };
}

/** Registra la identidad del contexto verificado (sin rutas ni contenido: proyecto, destino, versiones y hash). */
export async function recordContext(root: string, run: string, identity: ContextIdentity, now: Date = new Date()): Promise<void> {
  await appendRunEvent(root, {
    ts: now.toISOString(),
    run,
    kind: 'note',
    note_type: 'decision',
    note: `contexto verificado: proyecto ${identity.project}, destino ${identity.target}, motor ${identity.engineVersion}, lock ${identity.lockHash.slice(0, 12)}, spec kit ${identity.speckit}`,
  });
}

export type ClosingRefusal = 'context_unverified' | 'invalid_status' | 'run_mismatch';
export type ClosingResult = { accepted: true; status: StatusLine } | { accepted: false; reason: ClosingRefusal };

/**
 * 5.14: vincula el cierre al run asignado. Solo se mira la última línea no vacía de la salida, en memoria; la salida
 * nunca se persiste. Aceptado solo con `run` igual al asignado; el uso del contexto se registra como no observado.
 */
export async function bindClosing(root: string, run: string, output: string, now: Date = new Date()): Promise<ClosingResult> {
  const contract = statusContract(await loadEngine());
  const last = output.split(/\r?\n/).filter((line) => line.trim() !== '').at(-1)?.trim() ?? '';
  let result: ClosingResult;
  if (!last.startsWith(`${contract.prefix}:`)) {
    result = { accepted: false, reason: 'context_unverified' };
  } else {
    let parsed: StatusLine | null = null;
    try {
      parsed = parseStatusLine(last, contract);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      result = { accepted: false, reason: 'invalid_status' };
    } else if (parsed.runId === undefined || parsed.runId === null) {
      result = { accepted: false, reason: 'context_unverified' };
    } else if (parsed.runId !== run) {
      result = { accepted: false, reason: 'run_mismatch' };
    } else {
      result = { accepted: true, status: parsed };
    }
  }
  const ts = now.toISOString();
  if (result.accepted) {
    await appendRunEvent(root, {
      ts,
      run,
      kind: 'status',
      state: result.status.state,
      ...(result.status.artifact ? { artifact: result.status.artifact } : {}),
      ...(result.status.reasonCode ? { reason_code: result.status.reasonCode } : {}),
    });
    await appendRunEvent(root, { ts, run, kind: 'note', note_type: 'decision', note: 'resultado vinculado al run; uso del contexto canónico no observado' });
  } else {
    // Ningún efecto de la línea se aplica: ni estado ni artefacto, solo el motivo.
    await appendRunEvent(root, { ts, run, kind: 'status', reason_code: result.reason });
  }
  return result;
}
