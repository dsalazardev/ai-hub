import path from 'node:path';
import { inspectLock, LockHeldError, releaseLockExplicit } from '../harness/lock.js';
import type { CliContext, ParsedArgs } from './types.js';

const USAGE = 'uso: ai-hub locks show <archivo.lock> | ai-hub locks release <archivo.lock> --yes';

/**
 * Inspección y liberación explícita de locks X1 (R-038). La liberación solo la pide una persona:
 * un lock de otro host, ilegible o de un recuperador interrumpido nunca se libera solo. Un dueño
 * vivo en este host no se libera ni con `--yes`.
 */
export async function cmdLocks(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub, target] = args.positionals;
  if ((sub !== 'show' && sub !== 'release') || !target) {
    ctx.io.err(USAGE);
    return 2;
  }
  const file = path.resolve(ctx.cwd, target);
  if (sub === 'show') {
    const state = await inspectLock(file);
    ctx.io.out(state.kind === 'free' || state.kind === 'unreadable' ? `lock: ${state.kind}` : `lock: ${state.kind} · pid ${state.owner.pid} · ${state.owner.host} · ${state.owner.startedAt} · ${state.owner.purpose}`);
    return 0;
  }
  if (!args.flags.yes) {
    ctx.io.err(`release libera ${file} sin comprobar a su dueño remoto; repite con --yes`);
    return 2;
  }
  try {
    const state = await releaseLockExplicit(file);
    ctx.io.out(state.kind === 'free' ? `lock: no existía (${file})` : `lock liberado (${state.kind}): ${file}`);
    return 0;
  } catch (error) {
    if (error instanceof LockHeldError) {
      ctx.io.err(error.message);
      return 1;
    }
    throw error;
  }
}
