import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { planReap, type ReapReport, type WorktreeFacts } from '../harness/worktree/reaper.js';
import type { CliContext, ParsedArgs } from './types.js';

export interface RawWorktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
}

const GENERATED_PREFIXES = [
  '.claude/',
  '.opencode/',
  '.pi/',
  '.cursor/',
  'node_modules/',
  'dist/',
  '.backups/',
];

export function parseWorktreeList(text: string): RawWorktree[] {
  const entries: RawWorktree[] = [];
  let current: Partial<RawWorktree> = {};
  const flush = (): void => {
    if (current.path) {
      entries.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
        bare: current.bare ?? false,
      });
    }
    current = {};
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') {
      current.path = value;
    } else if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'detached') {
      current.branch = null;
    }
  }
  flush();
  return entries;
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isOwned(root: string, worktreePath: string): boolean {
  const base = normalize(root);
  const candidate = normalize(worktreePath);
  return (
    candidate.startsWith(`${base}/.worktrees/`) ||
    candidate.startsWith(`${base}/.ai-hub/worktrees/`) ||
    candidate.startsWith(`${base}/.git/worktrees/`)
  );
}

async function hasMarker(worktreePath: string): Promise<boolean> {
  return fs
    .access(path.join(worktreePath, '.ai-hub-worktree'))
    .then(
      () => true,
      () => false,
    );
}

export async function collectWorktreeFacts(root: string): Promise<WorktreeFacts[]> {
  const listed = runGit(['worktree', 'list', '--porcelain'], root);
  const raw = listed.ok ? parseWorktreeList(listed.stdout) : [];
  const facts: WorktreeFacts[] = [];
  for (const worktree of raw) {
    if (worktree.bare) {
      continue;
    }
    const status = runGit(['status', '--porcelain'], worktree.path);
    const lines = status.ok ? status.stdout.split(/\r?\n/).filter((line) => line.trim() !== '') : [];
    const dirty = lines.some((line) => !line.startsWith('??'));
    const untrackedNonRegenerable = lines.some((line) => {
      if (!line.startsWith('??')) {
        return false;
      }
      const rel = line.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/');
      return !GENERATED_PREFIXES.some((prefix) => rel.startsWith(prefix));
    });
    const ahead = runGit(['rev-list', '--count', 'HEAD', '--not', 'main', 'master', 'trunk'], worktree.path);
    const unmergedCommits = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
    const integrated = ahead.ok ? unmergedCommits === 0 : false;
    facts.push({
      path: worktree.path,
      branch: worktree.branch ?? 'detached',
      owned: isOwned(root, worktree.path) || (await hasMarker(worktree.path)),
      dirty,
      untrackedNonRegenerable,
      unmergedCommits,
      integrated,
    });
  }
  return facts;
}

function printReport(report: ReapReport, ctx: CliContext): void {
  for (const plan of [...report.keep, ...report.ask, ...report.remove]) {
    ctx.io.out(`${plan.decision.padEnd(6)} ${plan.path} [${plan.branch}] ${plan.rule}: ${plan.reason}`);
  }
  ctx.io.out(
    `resumen: ${report.remove.length} eliminar · ${report.ask.length} pedir confirmación · ${report.keep.length} conservar`,
  );
}

export async function cmdWorktrees(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const sub = args.positionals[0] ?? 'list';
  if (sub !== 'list' && sub !== 'reap') {
    ctx.io.err('uso: ai-hub worktrees [list|reap] [--confirm]');
    return 2;
  }
  const facts = await collectWorktreeFacts(ctx.root);
  const auto = Boolean(args.flags.auto);
  const report = planReap(facts, { confirm: Boolean(args.flags.confirm) || auto });
  if (sub === 'list') {
    printReport(report, ctx);
    return 0;
  }
  let removed = 0;
  for (const plan of report.remove) {
    const result = spawnSync('git', ['worktree', 'remove', plan.path], {
      cwd: ctx.root,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      removed += 1;
      ctx.io.out(`remove ${plan.path}`);
    } else {
      ctx.io.err(`no se pudo eliminar ${plan.path}: ${result.stderr ?? 'error de git'}`);
    }
  }
  ctx.io.out(`worktrees reap: ${removed} eliminados, ${report.ask.length} pendientes de --confirm`);
  return removed === report.remove.length ? 0 : 1;
}
