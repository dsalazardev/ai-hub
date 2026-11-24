import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendRunEvent } from '../harness/runs.js';
import { transactWrite } from '../writes/transaction.js';

/**
 * Candidato congelado del panel de refutación (R-056–R-061). Un candidato es un commit inmutable cuyo padre es una
 * base resuelta a commit (nunca una referencia simbólica) y cuyo árbol recoge exactamente el estado revisado:
 * cambios rastreados, archivos sin rastrear no ignorados, binarios, borrados y bit de ejecución; excluye la
 * telemetría (`.ai-hub/runs/`) y lo ignorado. Se fija con una ref privada (`refs/ai-hub/candidates/<commit>`) y se
 * conserva hasta su eliminación explícita. El commit es reproducible: autor, fecha y mensaje fijos.
 */

export const CANDIDATE_REF_PREFIX = 'refs/ai-hub/candidates/';
export const PANEL_RECORD_FILE = '.ai-hub/runs/review-panel.json';
export const PANEL_AGENTS = ['refuter-correctness', 'refuter-security', 'refuter-tests', 'finding-verifier'] as const;

/** Familias de veredicto cerradas y separadas (R-059). */
export const SEAL_VERDICTS = ['APPROVE', 'APPROVE_WITH_NITS', 'CHANGES_REQUESTED'] as const;
export const PANEL_VERDICTS = ['REFUTED', 'NOT-REFUTED'] as const;
export const FINDING_VERDICTS = ['CONFIRMED', 'REFUTED', 'UNPROVEN'] as const;
export type PanelVerdict = (typeof PANEL_VERDICTS)[number];
export type FindingVerdict = (typeof FINDING_VERDICTS)[number];

export interface Candidate {
  v: 1;
  base: string;
  tree: string;
  commit: string;
}

export class CandidateError extends Error {
  constructor(
    readonly reasonCode: 'base_unresolvable' | 'candidate_changed' | 'candidate_referenced' | 'candidate_unknown' | 'git_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CandidateError';
  }
}

const FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: 'ai-hub',
  GIT_AUTHOR_EMAIL: 'candidate@ai-hub.invalid',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'ai-hub',
  GIT_COMMITTER_EMAIL: 'candidate@ai-hub.invalid',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): { ok: boolean; out: Buffer } {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { ok: result.status === 0, out: result.stdout ?? Buffer.alloc(0) };
}

function gitText(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = git(root, args, env);
  if (!result.ok) {
    throw new CandidateError('git_failed', `git ${args[0]} falló al preparar el candidato`);
  }
  return result.out.toString('utf8').trim();
}

/** Base inmutable: la referencia dada o el merge-base con la rama por defecto, resuelta a commit (R-056). */
export function resolveBase(root: string, reference: string): string {
  const resolved = git(root, ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`]);
  const sha = resolved.out.toString('utf8').trim();
  if (!resolved.ok || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new CandidateError('base_unresolvable', `la base «${reference}» no se resuelve a un commit inmutable; el sellado se rechaza`);
  }
  return sha;
}

export function defaultBase(root: string, defaultBranch: string): string {
  const merge = git(root, ['merge-base', 'HEAD', defaultBranch]);
  const sha = merge.out.toString('utf8').trim();
  if (!merge.ok || sha === '') {
    throw new CandidateError('base_unresolvable', `sin merge-base entre HEAD y ${defaultBranch}: no hay base inmutable; el sellado se rechaza`);
  }
  return resolveBase(root, sha);
}

/** Árbol del estado actual en un índice temporal (el índice real no se toca). */
export async function candidateTree(root: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-hub-candidate-'));
  const env = { GIT_INDEX_FILE: path.join(dir, `index-${randomBytes(4).toString('hex')}`) };
  try {
    if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
      gitText(root, ['read-tree', 'HEAD'], env);
    }
    gitText(root, ['add', '-A', '--', '.'], env);
    // La telemetría nunca entra, ni siquiera si un proyecto no la ignora (un pathspec de exclusión falla si está ignorada).
    gitText(root, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.ai-hub/runs'], env);
    return gitText(root, ['write-tree'], env);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Congela el estado actual como candidato inmutable sobre una base resuelta. */
export async function freezeCandidate(root: string, base: string): Promise<Candidate> {
  const baseSha = resolveBase(root, base);
  const tree = await candidateTree(root);
  const commit = gitText(root, ['commit-tree', tree, '-p', baseSha, '-m', 'ai-hub frozen candidate'], FIXED_IDENTITY);
  gitText(root, ['update-ref', `${CANDIDATE_REF_PREFIX}${commit}`, commit]);
  return { v: 1, base: baseSha, tree, commit };
}

/** ¿Sigue el estado actual siendo exactamente el candidato y existe su ref? */
export async function candidateIntact(root: string, candidate: Candidate): Promise<boolean> {
  const ref = git(root, ['rev-parse', '--verify', '--quiet', `${CANDIDATE_REF_PREFIX}${candidate.commit}`]);
  if (!ref.ok || ref.out.toString('utf8').trim() !== candidate.commit) {
    return false;
  }
  return (await candidateTree(root)) === candidate.tree;
}

export interface CandidateEntry {
  path: string;
  kind: 'file' | 'symlink' | 'submodule';
  executable: boolean;
  object: string;
  /** Texto del enlace (symlink) o commit registrado (submódulo); los archivos se materializan aparte. */
  value?: string;
}

/** Entradas del candidato desde sus objetos: los enlaces como texto (nunca seguidos) y los submódulos como commit. */
export function candidateEntries(root: string, candidate: Candidate): CandidateEntry[] {
  const listing = git(root, ['ls-tree', '-r', '-z', '--full-tree', candidate.commit]);
  if (!listing.ok) {
    throw new CandidateError('candidate_unknown', `el candidato ${candidate.commit.slice(0, 12)} no existe en el repositorio`);
  }
  const entries: CandidateEntry[] = [];
  for (const record of listing.out.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, , object] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (mode === '160000') {
      entries.push({ path: file, kind: 'submodule', executable: false, object, value: object });
    } else if (mode === '120000') {
      entries.push({ path: file, kind: 'symlink', executable: false, object, value: git(root, ['cat-file', 'blob', object]).out.toString('utf8') });
    } else {
      entries.push({ path: file, kind: 'file', executable: mode === '100755', object });
    }
  }
  return entries;
}

/**
 * Materializa solo los bytes del candidato en `dir` (las lentes leen ahí y en ningún otro sitio): archivos desde
 * sus blobs; los enlaces simbólicos y los submódulos no se crean, se listan en las entradas con su texto o commit.
 */
export async function materializeCandidate(root: string, candidate: Candidate, dir: string): Promise<CandidateEntry[]> {
  const entries = candidateEntries(root, candidate);
  for (const entry of entries.filter((item) => item.kind === 'file')) {
    const target = path.join(dir, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, git(root, ['cat-file', 'blob', entry.object]).out, { mode: entry.executable ? 0o755 : 0o644 });
  }
  return entries;
}

/** Las cuatro entradas del contrato del panel, idénticas para cada lente y el verificador (R-056, 4.52). */
export interface PanelInputs {
  taskContract: string;
  approvedSpec: string;
  sourceState: { base: string; tree: string; commit: string };
  entryPoint: string;
}

export function panelInputs(candidate: Candidate, contract: { taskContract: string; approvedSpec: string; entryPoint: string }): Record<(typeof PANEL_AGENTS)[number], PanelInputs> {
  const inputs: PanelInputs = {
    taskContract: contract.taskContract,
    approvedSpec: contract.approvedSpec,
    sourceState: { base: candidate.base, tree: candidate.tree, commit: candidate.commit },
    entryPoint: contract.entryPoint,
  };
  return Object.fromEntries(PANEL_AGENTS.map((agent) => [agent, { ...inputs, sourceState: { ...inputs.sourceState } }])) as Record<(typeof PANEL_AGENTS)[number], PanelInputs>;
}

export interface PanelRecord {
  v: 1;
  candidate: { base: string; tree: string; commit: string };
  verdict: PanelVerdict;
  findings: Array<{ id: string; verdict: FindingVerdict }>;
  recordedAt: string;
}

export interface PanelOutcome {
  status: 'recorded' | 'stopped';
  diagnostic?: 'CANDIDATE_CHANGED';
  record?: PanelRecord;
}

/**
 * Despacha las lentes comprobando la identidad del candidato antes de cada una y antes de registrar (R-058). Un
 * cambio detiene el panel con `CANDIDATE_CHANGED` (motivo persistido `candidate_changed`) sin veredicto.
 */
export async function runPanel(
  root: string,
  candidate: Candidate,
  dispatch: (agent: (typeof PANEL_AGENTS)[number], inputs: PanelInputs) => Promise<{ verdict?: PanelVerdict; findings?: Array<{ id: string; verdict: FindingVerdict }> }>,
  contract: { taskContract: string; approvedSpec: string; entryPoint: string },
  run: string,
  now: Date = new Date(),
): Promise<PanelOutcome> {
  const inputs = panelInputs(candidate, contract);
  const stop = async (): Promise<PanelOutcome> => {
    await appendRunEvent(root, { ts: now.toISOString(), run, kind: 'status', reason_code: 'candidate_changed' }).catch(() => undefined);
    return { status: 'stopped', diagnostic: 'CANDIDATE_CHANGED' };
  };
  let refuted = false;
  const findings: Array<{ id: string; verdict: FindingVerdict }> = [];
  for (const agent of PANEL_AGENTS) {
    if (!(await candidateIntact(root, candidate))) {
      return stop();
    }
    const result = await dispatch(agent, inputs[agent]);
    if (result.verdict !== undefined && !(PANEL_VERDICTS as readonly string[]).includes(result.verdict)) {
      throw new CandidateError('git_failed', `veredicto de panel fuera de su familia: ${result.verdict}`);
    }
    for (const finding of result.findings ?? []) {
      if (!(FINDING_VERDICTS as readonly string[]).includes(finding.verdict)) {
        throw new CandidateError('git_failed', `veredicto de hallazgo fuera de su familia: ${finding.verdict}`);
      }
      findings.push(finding);
    }
    refuted ||= result.verdict === 'REFUTED';
  }
  if (!(await candidateIntact(root, candidate))) {
    return stop();
  }
  // Solo un hallazgo CONFIRMED puede bloquear; NOT-REFUTED no es una aprobación humana.
  const verdict: PanelVerdict = refuted || findings.some((finding) => finding.verdict === 'CONFIRMED') ? 'REFUTED' : 'NOT-REFUTED';
  const record: PanelRecord = { v: 1, candidate: { base: candidate.base, tree: candidate.tree, commit: candidate.commit }, verdict, findings, recordedAt: now.toISOString() };
  const written = await transactWrite({ root, file: path.join(root, ...PANEL_RECORD_FILE.split('/')), module: 'review/candidate.ts', capture: false, transform: () => `${JSON.stringify(record, null, 2)}\n` });
  if (written.status === 'stopped') {
    throw new CandidateError('git_failed', `no se pudo registrar el veredicto del panel (${written.reason})`);
  }
  return { status: 'recorded', record };
}

/** Candidatos referenciados por un veredicto registrado. */
async function referencedCandidates(root: string): Promise<Map<string, string>> {
  const text = await fs.readFile(path.join(root, ...PANEL_RECORD_FILE.split('/')), 'utf8').catch(() => null);
  const refs = new Map<string, string>();
  if (text !== null) {
    try {
      const record = JSON.parse(text) as Partial<PanelRecord>;
      if (record.candidate?.commit && record.verdict) {
        refs.set(record.candidate.commit, `veredicto ${record.verdict} del ${record.recordedAt ?? '?'}`);
      }
    } catch {
      // Un registro ilegible no libera nada: se trata como si referenciara todo.
      refs.set('*', 'registro del panel ilegible');
    }
  }
  return refs;
}

/** Eliminación explícita (R-061): rechaza un candidato referenciado por un veredicto salvo forzado. */
export async function removeCandidate(root: string, commit: string, force = false): Promise<void> {
  const ref = `${CANDIDATE_REF_PREFIX}${commit}`;
  if (!git(root, ['rev-parse', '--verify', '--quiet', ref]).ok) {
    throw new CandidateError('candidate_unknown', `no hay ningún candidato ${commit.slice(0, 12)}`);
  }
  const refs = await referencedCandidates(root);
  const holder = refs.get(commit) ?? refs.get('*');
  if (holder !== undefined && !force) {
    throw new CandidateError('candidate_referenced', `el candidato ${commit.slice(0, 12)} lo referencia el ${holder}; no se elimina sin --force`);
  }
  gitText(root, ['update-ref', '-d', ref, commit]);
}
