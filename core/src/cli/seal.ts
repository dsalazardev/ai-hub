import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readReviewDiff, reviewBase, REVIEW_SEAL_FILE, type ReviewSealRecord } from '../harness/review-seal.js';
import { isApproving, isReviewVerdict, REVIEW_VERDICTS, reviewSeal } from '../speckit/seal.js';
import type { CliContext, ParsedArgs } from './types.js';

const USAGE = `Uso: ai-hub seal review --verdict <${REVIEW_VERDICTS.join('|')}> [--base <ref>]`;

function defaultBranch(root: string): string {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const ref = result.status === 0 ? result.stdout.trim().replace(/^origin\//, '') : '';
  return ref !== '' ? ref : 'main';
}

/**
 * `ai-hub seal review` (M-31): sella el veredicto de la revisión a los bytes del diff real. Un
 * diff que toca `specs/<feature>/` no se puede aprobar: invalida la aprobación humana de la spec
 * (§5), que se vuelve a pedir por la puerta humana. No mueve etiquetas ni aprueba nada por sí solo.
 */
export async function cmdSeal(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  const verdict = typeof args.flags.verdict === 'string' ? args.flags.verdict.toUpperCase() : '';
  if (sub !== 'review' || !isReviewVerdict(verdict)) {
    ctx.io.err(USAGE);
    return 2;
  }
  const base =
    typeof args.flags.base === 'string' ? args.flags.base : reviewBase(ctx.root, defaultBranch(ctx.root));
  const diff = readReviewDiff(ctx.root, base);
  if (diff === null) {
    ctx.io.err(`no se pudo leer el diff contra ${base} (¿repositorio git?)`);
    return 2;
  }
  const sealed = reviewSeal(diff, verdict);
  if (isApproving(verdict) && sealed.specs.length > 0) {
    ctx.io.err(
      `[FAIL]  el diff toca la spec aprobada (${sealed.specs.join(', ')}): la aprobación humana queda invalidada; vuelve a sellar la spec por la puerta humana (§5) antes de aprobar la revisión`,
    );
    return 1;
  }
  const record: ReviewSealRecord = { v: 1, base, verdict, diff: sealed.diff, seal: sealed.seal };
  const file = path.join(ctx.root, REVIEW_SEAL_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  ctx.io.out(`[OK]    review ${verdict} sellada · diff=${sealed.diff} · seal=${sealed.seal}`);
  return 0;
}
