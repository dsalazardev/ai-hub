import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { evaluatePreflight, type PreflightOutcome } from '../preflight.js';
import type { GuardContext, GuardMode, PresetDangerPattern } from '../types.js';

export interface GuardBuildInput {
  root: string;
  preset: string;
  languages: string[];
  policy: GuardContext['policy'];
  session?: GuardContext['session'];
  presetPatterns?: PresetDangerPattern[];
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function present(root: string, relative: string): boolean {
  const full = path.join(root, ...relative.split('/'));
  if (!existsSync(full)) {
    return false;
  }
  try {
    return readdirSync(full).length > 0;
  } catch {
    return true;
  }
}

const CI_FILES = [
  '.github/workflows',
  '.gitlab-ci.yml',
  '.circleci',
  'azure-pipelines.yml',
  'Jenkinsfile',
  'bitbucket-pipelines.yml',
  '.buildkite',
  '.travis.yml',
];

const DEPLOY_FILES = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'vercel.json',
  'netlify.toml',
  'fly.toml',
  'render.yaml',
  'railway.json',
  'Procfile',
  'serverless.yml',
  'wrangler.toml',
  'k8s',
  'helm',
];

function signals(root: string): { hasCI: boolean; hasDeploy: boolean; team: boolean } {
  const hasCI = CI_FILES.some((file) => present(root, file));
  const hasDeploy = DEPLOY_FILES.some((file) => present(root, file));
  const authors = new Set(
    (git(root, ['log', '-50', '--format=%ae']) ?? '').split('\n').filter(Boolean),
  );
  return { hasCI, hasDeploy, team: authors.size >= 2 };
}

function parseWorktrees(raw: string): GuardContext['git']['worktrees'] {
  const worktrees: GuardContext['git']['worktrees'] = [];
  let current: { path?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? 'detached',
        dirty: false,
        owned: false,
      });
    }
    current = {};
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    }
  }
  flush();
  return worktrees;
}

function trunkPolicy(root: string, policy: GuardContext['policy']): GuardContext['policy'] {
  const file = path.join(root, '.planning', 'trunk.json');
  if (!existsSync(file)) {
    return policy;
  }
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { closed?: unknown };
    if (state.closed === true) {
      return { ...policy, trunk: 'closed' };
    }
    if (state.closed === false) {
      return { ...policy, trunk: 'open' };
    }
  } catch {
    return policy;
  }
  return policy;
}

/**
 * IO boundary for the pure guard. If Git or the configuration cannot be read,
 * the caller decides; `preflightFailOpen` treats that as allow.
 */
export async function buildGuardContext(input: GuardBuildInput): Promise<GuardContext> {
  const branch = git(input.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(input.root, ['rev-parse', 'HEAD']);
  if (branch === null || head === null) {
    throw new Error('not a git repository or HEAD is unavailable');
  }
  const status = git(input.root, ['status', '--porcelain']) ?? '';
  const aheadRaw = git(input.root, ['rev-list', '--count', '@{u}..HEAD']);
  const worktrees = parseWorktrees(git(input.root, ['worktree', 'list', '--porcelain']) ?? '');
  const defaultBranch =
    git(input.root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(
      /^origin\//,
      '',
    ) ?? 'main';
  return {
    root: input.root,
    git: {
      branch,
      defaultBranch,
      head,
      dirty: status.trim() !== '',
      ahead: aheadRaw === null ? 0 : Number.parseInt(aheadRaw, 10) || 0,
      worktrees,
    },
    project: {
      preset: input.preset,
      languages: input.languages,
      ...signals(input.root),
    },
    session: input.session,
    policy: trunkPolicy(input.root, input.policy),
    preset: { dangerPatterns: input.presetPatterns ?? [] },
  };
}

export interface FailOpenResult extends PreflightOutcome {
  failedOpen: boolean;
}

export async function preflightFailOpen(
  command: string,
  builder: () => Promise<GuardContext>,
  mode: GuardMode = 'shadow',
): Promise<FailOpenResult> {
  try {
    const context = await builder();
    return { ...evaluatePreflight(command, context, mode), failedOpen: false };
  } catch (error) {
    return {
      result: {
        decision: 'allow',
        rule: 'preflight:fail-open',
        reason: `guard context unavailable: ${(error as Error).message}`,
      },
      mode,
      blocked: false,
      failedOpen: true,
    };
  }
}
