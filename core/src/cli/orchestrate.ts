import fs from 'node:fs/promises';
import path from 'node:path';
import { readRequests } from '../control/requests.js';
import { loadManifestContext } from '../manifest/manifest.js';
import { DEFAULT_HARNESS_ORDER, HARNESS_DECLARATIONS, selectHarness, type DiscoveryDeps } from '../runner/discovery.js';
import { hostDiscoveryDeps } from '../runner/host.js';
import { executeGrantedRun, processLauncher, type ExecutionDeps } from '../runner/orchestrate.js';
import { featureSeal } from '../speckit/seal.js';
import { flagString } from './args.js';
import type { CliContext, ParsedArgs } from './types.js';

const USAGE = [
  'uso: ai-hub orchestrate discover [--json]',
  '     ai-hub orchestrate run --grant <id> --task-file <archivo> [--target <destino>] [--feature specs/<NNN-slug>] [--json]',
].join('\n');

/** Dependencias inyectables (pruebas): descubrimiento y lanzador; por defecto, los reales. */
export interface OrchestrateDeps {
  discovery?: DiscoveryDeps;
  launch?: ExecutionDeps['launch'];
  lockFresh?: (worktree: string) => Promise<boolean>;
  now?: () => Date;
}

let deps: OrchestrateDeps = {};
export function setOrchestrateDeps(next: OrchestrateDeps): void {
  deps = next;
}

/**
 * `ai-hub orchestrate` (#11-C1, R-091–R-103): punto de entrada del runner. `discover` informa presencia, compatibilidad y
 * operabilidad de cada harness sin leer credenciales; `run` ejecuta una concesión aprobada del registro de control con
 * el harness elegido por el orden configurado (`manifest.runner.order`), con lock, contexto canónico, fallback solo
 * antes del arranque y cierre vinculado al run. Nunca aprueba: sin concesión aprobada no se ejecuta nada.
 */
export async function cmdOrchestrate(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [sub] = args.positionals;
  const { manifest } = await loadManifestContext(ctx.root);
  const order = manifest.runner?.order ?? [...DEFAULT_HARNESS_ORDER];
  const discovery = deps.discovery ?? hostDiscoveryDeps();
  if (sub === 'discover') {
    const selection = await selectHarness(HARNESS_DECLARATIONS, discovery, order);
    if (args.flags.json) {
      ctx.io.out(JSON.stringify({ order, eligible: selection.eligible, skipped: selection.skipped }, null, 2));
    } else {
      for (const item of selection.eligible) {
        ctx.io.out(`[OK]   ${item.id} ${item.version ?? '?'}: operativo y compatible`);
      }
      for (const item of selection.skipped) {
        ctx.io.out(`[--]   ${item.id}: ${item.reason}`);
      }
      ctx.io.out(selection.selected ? `seleccionado: ${selection.selected.id}` : 'ningún harness elegible');
    }
    return selection.selected ? 0 : 1;
  }
  if (sub !== 'run') {
    ctx.io.err(USAGE);
    return 2;
  }
  const grantId = flagString(args, 'grant');
  const taskFile = flagString(args, 'task-file');
  if (!grantId || !taskFile) {
    ctx.io.err(USAGE);
    return 2;
  }
  const grant = (await readRequests(ctx.root))[grantId];
  if (grant === undefined) {
    ctx.io.err(`orchestrate: la concesión ${grantId.slice(0, 8)} no está en el registro de control; no se ejecuta nada`);
    return 1;
  }
  const feature = flagString(args, 'feature');
  if (grant.seal !== null && feature === null) {
    ctx.io.err('orchestrate: la concesión está ligada a un sello; indica --feature specs/<NNN-slug> para recalcularlo');
    return 2;
  }
  const task = await fs.readFile(path.resolve(ctx.cwd, taskFile), 'utf8');
  const now = deps.now?.() ?? new Date();
  const approvers = manifest.control?.approvers ?? [];
  const timeoutMs = (manifest.runner?.timeoutMinutes ?? grant.limits.maxMinutes) * 60_000;
  const outcome = await executeGrantedRun(
    {
      root: ctx.root,
      claim: {
        iid: grant.iid,
        grantId,
        project: grant.project,
        worktree: grant.worktree,
        effects: grant.effects,
        seal: feature === null ? null : await featureSeal(ctx.root, feature),
        approvers,
        now,
      },
      contextProject: manifest.project.id,
      worktreePath: path.resolve(ctx.root, grant.worktree),
      target: flagString(args, 'target') ?? manifest.targets[0] ?? 'claude',
      task,
      order,
      now,
    },
    {
      declarations: HARNESS_DECLARATIONS,
      discovery,
      launch: deps.launch ?? processLauncher(HARNESS_DECLARATIONS, discovery.resolveBinary, timeoutMs),
      ...(deps.lockFresh ? { context: { lockFresh: deps.lockFresh } } : {}),
    },
  );
  if (args.flags.json) {
    ctx.io.out(JSON.stringify(outcome, null, 2));
  } else if (outcome.state === 'completed') {
    ctx.io.out(`run ${outcome.run}: ${outcome.harness} terminó; cierre ${outcome.accepted ? `aceptado (${outcome.closing})` : `no aceptado (${outcome.closing})`}`);
  } else if (outcome.state === 'held') {
    ctx.io.out(`run ${outcome.run}: ${outcome.harness} falló tras arrancar; retenido para reconciliar (reconcile_required)`);
  } else if (outcome.state === 'exhausted') {
    ctx.io.out(`run ${outcome.run}: ningún harness arrancó (${outcome.detail})`);
  } else {
    ctx.io.err(`orchestrate: ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome.state === 'completed' && outcome.accepted ? 0 : 1;
}
