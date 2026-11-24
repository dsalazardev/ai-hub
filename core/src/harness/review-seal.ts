import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isReviewVerdict, type ReviewVerdict } from '../speckit/seal.js';

/** Registro del sello de revisión: bajo `runs/` (ignorado), nunca versionado ni dentro del diff. */
export const REVIEW_SEAL_FILE = '.ai-hub/runs/review-seal.json';

/**
 * Registro de revisión. v2 (R-059, 4.51) añade el candidato congelado y el tier de riesgo, ambos opcionales; un
 * registro v1 conserva su comprobación de ship pero no sirve como candidato del panel.
 */
export interface ReviewSealRecord {
  v: 1 | 2;
  base: string;
  verdict: ReviewVerdict;
  diff: string;
  seal: string;
  candidate?: { tree: string; commit: string } | null;
  tier?: 'low' | 'high' | null;
}

function git(root: string, args: string[]): Buffer | null {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 && result.stdout ? result.stdout : null;
}

/** Base por defecto: el merge-base con la rama por defecto; si no hay, `HEAD`. */
export function reviewBase(root: string, defaultBranch: string): string {
  const base = git(root, ['merge-base', 'HEAD', defaultBranch])?.toString('utf8').trim();
  return base && base.length > 0 ? base : 'HEAD';
}

/**
 * Bytes del diff real contra `base`: cambios rastreados (`git diff --binary`) más los archivos sin
 * rastrear, con una cabecera `diff --git` para que sus rutas también cuenten. `null` si git falla.
 */
export function readReviewDiff(root: string, base: string): Buffer | null {
  const tracked = git(root, ['diff', '--binary', base, '--']);
  const untrackedList = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (tracked === null || untrackedList === null) {
    return null;
  }
  const parts: Buffer[] = [tracked];
  const untracked = untrackedList
    .toString('utf8')
    .split('\0')
    .filter((file) => file !== '' && !file.startsWith('.ai-hub/runs/'))
    .sort();
  for (const file of untracked) {
    parts.push(Buffer.from(`diff --git a/${file} b/${file}\nnew file\n`, 'utf8'));
    parts.push(readFileSync(path.join(root, file)));
  }
  return Buffer.concat(parts);
}

/** Candidato del panel de un registro: solo v2 con candidato; un v1 exige congelar uno nuevo. */
export function panelCandidateOf(record: ReviewSealRecord): { tree: string; commit: string } | null {
  return record.v === 2 && record.candidate ? record.candidate : null;
}

export function readReviewSealRecord(root: string): ReviewSealRecord | null {
  const file = path.join(root, REVIEW_SEAL_FILE);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReviewSealRecord>;
    if (
      typeof record.base === 'string' &&
      typeof record.diff === 'string' &&
      typeof record.seal === 'string' &&
      typeof record.verdict === 'string' &&
      isReviewVerdict(record.verdict)
    ) {
      const candidate =
        record.v === 2 && record.candidate && typeof record.candidate.tree === 'string' && typeof record.candidate.commit === 'string'
          ? { tree: record.candidate.tree, commit: record.candidate.commit }
          : null;
      const tier = record.v === 2 && (record.tier === 'low' || record.tier === 'high') ? record.tier : null;
      return record.v === 2
        ? { v: 2, base: record.base, verdict: record.verdict, diff: record.diff, seal: record.seal, candidate, tier }
        : { v: 1, base: record.base, verdict: record.verdict, diff: record.diff, seal: record.seal };
    }
  } catch {
    return null;
  }
  return null;
}
