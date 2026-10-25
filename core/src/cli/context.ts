import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifestContext } from '../manifest/manifest.js';
import { readLedger, resumeLedger } from '../harness/memory/ledger.js';
import type { CliContext, ParsedArgs } from './types.js';

export const CONTEXT_RELATIVE = '.planning/context-next.md';

export async function buildContext(root: string): Promise<string> {
  const { manifest, engine, preset } = await loadManifestContext(root);
  const summary = await resumeLedger(root);
  const events = await readLedger(root, 5);
  const lines: string[] = [
    '# Contexto de sesión',
    '',
    `- Proyecto: ${manifest.project.id} (${manifest.project.name})`,
    `- Preset: ${preset.id}@${preset.version} [${preset.chain.join(' -> ')}]`,
    `- Targets: ${manifest.targets.join(', ')}`,
    `- Cambio activo: ${summary.activeChange ?? 'ninguno'}`,
    `- Fase: ${summary.phase}`,
    `- Tareas: ${summary.tasks.done}/${summary.tasks.total}`,
    '',
    '## Comandos Spec Kit',
    '',
    ...engine.commands.map((command) => `- ${command.name} — lane ${command.lane}, rol ${command.role}`),
    '',
    '## Etiquetas',
    '',
    engine.labels.join(' · '),
    '',
    '## Últimos eventos del ledger',
    '',
    ...(events.length === 0
      ? ['- sin eventos']
      : events.map(
          (event) =>
            `- ${event.timestamps.at} ${event.event} ${event.sessionId}${event.branch ? ` (${event.branch})` : ''}`,
        )),
    '',
    '## Reglas de la sesión',
    '',
    '- Escribe el estado en `.planning/`, nunca en el chat.',
    '- No implementes sin spec aprobada por un humano.',
    '- Trabaja en rama o worktree; no en una trunk cerrada.',
    '',
  ];
  const body = lines.join('\n');
  const file = path.join(root, CONTEXT_RELATIVE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  return body;
}

export async function cmdContext(_args: ParsedArgs, ctx: CliContext): Promise<number> {
  try {
    await buildContext(ctx.root);
    ctx.io.out(`[OK]    Contexto generado: ${CONTEXT_RELATIVE}`);
    return 0;
  } catch (error) {
    ctx.io.err((error as Error).message);
    return 1;
  }
}
