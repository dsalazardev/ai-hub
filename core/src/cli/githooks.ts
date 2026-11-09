import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliContext, ParsedArgs } from './types.js';

/**
 * Prefijo común de todo hook de git que escribe el arnés: sin `npx` en el PATH (cliente git
 * gráfico, máquina sin Node) el hook sale 0 sin hacer nada. Nunca bloquea un commit ni un merge
 * porque falte el arnés.
 */
export const FAIL_OPEN_PREFIX = 'command -v npx >/dev/null 2>&1 || exit 0';

export const GIT_HOOKS: Record<'post-merge' | 'pre-commit', { marker: string; body: string }> = {
  'post-merge': {
    marker: '# ai-hub managed worktree cleanup',
    body: 'npx --no-install ai-hub worktrees reap --auto >/dev/null 2>&1 || true',
  },
  'pre-commit': {
    marker: '# ai-hub managed lock check',
    body: 'npx --no-install ai-hub sync --check-lock',
  },
};

export type GitHookName = keyof typeof GIT_HOOKS;

export function gitHookScript(name: GitHookName): string {
  const hook = GIT_HOOKS[name];
  return `#!/bin/sh\n${hook.marker}\n${FAIL_OPEN_PREFIX}\n${hook.body}\n`;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function installGitHook(
  root: string,
  name: GitHookName,
): Promise<{ installed: boolean; reason: string }> {
  if (!(await exists(path.join(root, '.git')))) {
    return { installed: false, reason: 'not a git repository' };
  }
  const hook = path.join(root, '.git', 'hooks', name);
  if (await exists(hook)) {
    return { installed: false, reason: `a ${name} hook already exists; chain ai-hub manually` };
  }
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, gitHookScript(name), 'utf8');
  await fs.chmod(hook, 0o755);
  return { installed: true, reason: 'installed' };
}

const USAGE = 'Uso: ai-hub hooks install [--pre-commit] [--post-merge]';

export async function cmdHooks(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  const selected = (['pre-commit', 'post-merge'] as const).filter((name) => Boolean(args.flags[name]));
  if (sub !== 'install' || selected.length === 0) {
    ctx.io.err(USAGE);
    return 2;
  }
  let code = 0;
  for (const name of selected) {
    const result = await installGitHook(ctx.root, name);
    ctx.io.out(`hooks: ${result.installed ? `${name} instalado` : result.reason}`);
    if (!result.installed && result.reason === 'not a git repository') {
      code = 1;
    }
  }
  return code;
}
