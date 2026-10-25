import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliContext, ParsedArgs } from './types.js';

export const TRUNK_RELATIVE = '.planning/trunk.json';

export interface TrunkState {
  branch: string;
  closed: boolean;
  updatedAt: string;
}

function currentBranch(root: string): string {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const branch = (result.stdout ?? '').trim();
  return branch === '' ? 'main' : branch;
}

async function readTrunk(root: string): Promise<TrunkState | null> {
  const raw = await fs.readFile(path.join(root, TRUNK_RELATIVE), 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as TrunkState;
  } catch {
    return null;
  }
}

async function writeTrunk(root: string, state: TrunkState): Promise<void> {
  const file = path.join(root, TRUNK_RELATIVE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function cmdTrunk(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const sub = args.positionals[0] ?? 'show';
  if (sub === 'show') {
    const state = await readTrunk(ctx.root);
    const branch = state?.branch ?? currentBranch(ctx.root);
    const closed = state?.closed ?? false;
    ctx.io.out(`trunk: ${branch} · ${closed ? 'cerrada' : 'abierta'}`);
    return 0;
  }
  if (sub === 'lock') {
    const branch = args.positionals[1] ?? currentBranch(ctx.root);
    await writeTrunk(ctx.root, { branch, closed: true, updatedAt: new Date().toISOString() });
    ctx.io.out(`trunk: ${branch} cerrada (los guardias bloquearán commits directos)`);
    return 0;
  }
  if (sub === 'unlock') {
    const state = await readTrunk(ctx.root);
    const branch = state?.branch ?? args.positionals[1] ?? currentBranch(ctx.root);
    await writeTrunk(ctx.root, { branch, closed: false, updatedAt: new Date().toISOString() });
    ctx.io.out(`trunk: ${branch} abierta`);
    return 0;
  }
  ctx.io.err('uso: ai-hub trunk [show|lock|unlock]');
  return 2;
}
