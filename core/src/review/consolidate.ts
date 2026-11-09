import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliContext, ParsedArgs } from '../cli/types.js';

/**
 * Consolidación mecánica del panel de refutación (factory-evolution A4, M-14). Criterio adaptado de
 * rsc-harness `lib/review-findings.js` (MIT, ver core/NOTICE.md): une hallazgos del mismo archivo a
 * ±3 líneas o con la misma evidencia, y degrada a `question` lo que no trae archivo, línea o
 * escenario de fallo. Es pura: lee los informes y escribe SOLO por stdout.
 */
export const SEVERITIES = ['blocker', 'should-fix', 'nit', 'question'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const LINE_WINDOW = 3;

export interface Finding {
  lens?: string;
  severity?: string;
  file?: string;
  line?: number;
  claim?: string;
  failure_scenario?: string;
  evidence?: string;
}

export interface ConsolidatedFinding {
  lenses: string[];
  severity: Severity;
  file: string | null;
  lines: number[];
  claims: string[];
  failure_scenario: string | null;
  evidence: string[];
  /** `true` si se degradó a `question` por faltar archivo, línea o escenario. */
  demoted: boolean;
}

function rank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

function normalizeSeverity(value: unknown): Severity {
  return (SEVERITIES as readonly unknown[]).includes(value) ? (value as Severity) : 'question';
}

/** Extrae los bloques ```json findings de un informe. */
export function extractFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of text.matchAll(/```json findings\s*\n([\s\S]*?)```/g)) {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) {
      throw new Error('un bloque json findings debe ser una lista');
    }
    findings.push(...(parsed as Finding[]));
  }
  return findings;
}

function supported(finding: Finding): boolean {
  return (
    typeof finding.file === 'string' &&
    finding.file !== '' &&
    typeof finding.line === 'number' &&
    typeof finding.failure_scenario === 'string' &&
    finding.failure_scenario.trim() !== ''
  );
}

function sameSpot(group: ConsolidatedFinding, finding: Finding): boolean {
  if (finding.evidence && group.evidence.includes(finding.evidence)) {
    return true;
  }
  return (
    group.file !== null &&
    group.file === finding.file &&
    typeof finding.line === 'number' &&
    group.lines.some((line) => Math.abs(line - (finding.line as number)) <= LINE_WINDOW)
  );
}

export function consolidateFindings(findings: Finding[]): ConsolidatedFinding[] {
  const groups: ConsolidatedFinding[] = [];
  for (const finding of findings) {
    const demoted = !supported(finding);
    const severity: Severity = demoted ? 'question' : normalizeSeverity(finding.severity);
    const group = demoted ? undefined : groups.find((candidate) => !candidate.demoted && sameSpot(candidate, finding));
    if (group === undefined) {
      groups.push({
        lenses: finding.lens ? [finding.lens] : [],
        severity,
        file: typeof finding.file === 'string' && finding.file !== '' ? finding.file : null,
        lines: typeof finding.line === 'number' ? [finding.line] : [],
        claims: finding.claim ? [finding.claim] : [],
        failure_scenario: finding.failure_scenario?.trim() ? finding.failure_scenario : null,
        evidence: finding.evidence ? [finding.evidence] : [],
        demoted,
      });
      continue;
    }
    if (finding.lens && !group.lenses.includes(finding.lens)) {
      group.lenses.push(finding.lens);
    }
    if (rank(severity) < rank(group.severity)) {
      group.severity = severity;
    }
    if (typeof finding.line === 'number' && !group.lines.includes(finding.line)) {
      group.lines.push(finding.line);
      group.lines.sort((a, b) => a - b);
    }
    if (finding.claim && !group.claims.includes(finding.claim)) {
      group.claims.push(finding.claim);
    }
    if (finding.evidence && !group.evidence.includes(finding.evidence)) {
      group.evidence.push(finding.evidence);
    }
  }
  return groups.sort((a, b) => rank(a.severity) - rank(b.severity));
}

const USAGE = 'Uso: ai-hub review consolidate <informe…> (lee bloques ```json findings; escribe solo por stdout)';

export async function cmdReview(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub, ...reports] = args.positionals;
  if (sub !== 'consolidate' || reports.length === 0) {
    ctx.io.err(USAGE);
    return 2;
  }
  const findings: Finding[] = [];
  for (const report of reports) {
    const text = await fs.readFile(path.resolve(ctx.cwd, report), 'utf8').catch(() => null);
    if (text === null) {
      ctx.io.err(`no se puede leer el informe ${report}`);
      return 2;
    }
    try {
      findings.push(...extractFindings(text));
    } catch (error) {
      ctx.io.err(`${report}: ${(error as Error).message}`);
      return 2;
    }
  }
  const consolidated = consolidateFindings(findings);
  ctx.io.out(
    JSON.stringify(
      {
        input: findings.length,
        findings: consolidated,
        demoted: consolidated.filter((item) => item.demoted).length,
      },
      null,
      2,
    ),
  );
  return 0;
}
