import {
  appendLedger,
  queryLedger,
  readLedger,
  resumeLedger,
  type LedgerEvent,
} from '../harness/memory/ledger.js';
import { flagList, flagString } from './args.js';
import type { CliContext, ParsedArgs } from './types.js';

function numberFlag(args: ParsedArgs, name: string): number | null {
  const raw = flagString(args, name);
  if (raw === null) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

export async function cmdMemory(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const sub = args.positionals[0] ?? 'list';
  if (sub === 'add') {
    const sessionId = flagString(args, 'session') ?? process.env.AI_HUB_SESSION ?? 'local';
    const decisionId = flagString(args, 'decision');
    try {
      const event = await appendLedger(ctx.root, {
        sessionId,
        changeId: flagString(args, 'change'),
        event: flagString(args, 'event') ?? 'checkpoint',
        branch: flagString(args, 'branch'),
        worktree: flagString(args, 'worktree'),
        baselineHead: flagString(args, 'baseline'),
        head: flagString(args, 'head'),
        files: flagList(args, 'files'),
        commits: flagList(args, 'commits'),
        toolCalls: numberFlag(args, 'tool-calls') ?? 0,
        ...(decisionId
          ? {
              decision: {
                id: decisionId,
                choice: flagString(args, 'choice') ?? '',
                alternatives: flagList(args, 'alternatives'),
              },
            }
          : {}),
      });
      ctx.io.out(`memory: ${event.event} registrado (${event.sessionId})`);
      return 0;
    } catch (error) {
      ctx.io.err((error as Error).message);
      return 1;
    }
  }
  if (sub === 'list') {
    const limit = numberFlag(args, 'limit') ?? 20;
    const all = await readLedger(ctx.root);
    const events = queryLedger(all, {
      changeId: flagString(args, 'change') ?? undefined,
      sessionId: flagString(args, 'session') ?? undefined,
    }).slice(-limit);
    if (args.flags.json) {
      ctx.io.out(JSON.stringify(events, null, 2));
      return 0;
    }
    if (events.length === 0) {
      ctx.io.out('ledger vacío');
      return 0;
    }
    for (const event of events) {
      const decision = event.decision ? ` decision=${event.decision.id}:${event.decision.choice}` : '';
      ctx.io.out(
        `${event.timestamps.at} ${event.event} ${event.sessionId} ${event.branch ?? '-'} ${event.head ?? '-'}${decision}`,
      );
    }
    return 0;
  }
  if (sub === 'resume') {
    const summary = await resumeLedger(ctx.root);
    const last: LedgerEvent | null = summary.last;
    if (args.flags.json) {
      ctx.io.out(JSON.stringify(summary, null, 2));
      return 0;
    }
    ctx.io.out(`cambio activo: ${summary.activeChange ?? 'ninguno'}`);
    ctx.io.out(`fase: ${summary.phase}`);
    ctx.io.out(`tareas: ${summary.tasks.done}/${summary.tasks.total}`);
    ctx.io.out(
      last === null
        ? 'ledger: sin eventos'
        : `último evento: ${last.event} ${last.timestamps.at} ${last.sessionId} (${last.branch ?? '-'})`,
    );
    return 0;
  }
  ctx.io.err('uso: ai-hub memory [add|list|resume]');
  return 2;
}
