import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliContext, ParsedArgs } from '../cli/types.js';
import { readTemplate } from '../harness/local.js';

/** Plantillas que el consumidor pide explícitamente; `init` e `install` nunca las escriben. */
export const CI_TEMPLATES: Record<string, { template: string; destination: string }> = {
  gitlab: { template: 'gitlab-ci.yml', destination: '.gitlab-ci.ai-hub.yml' },
  // M-36: Node + uv + bash para operar la fábrica en remoto; solo a petición, init nunca lo escribe.
  devcontainer: { template: 'devcontainer.json', destination: '.devcontainer/devcontainer.json' },
};

const USAGE = `Uso: ai-hub ci <${Object.keys(CI_TEMPLATES).join('|')}> [--force]`;

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

export async function cmdCi(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const [kind] = args.positionals;
  const spec = kind ? CI_TEMPLATES[kind] : undefined;
  if (!spec) {
    ctx.io.err(USAGE);
    return 2;
  }
  const destination = path.join(ctx.root, spec.destination);
  if ((await exists(destination)) && !args.flags.force) {
    ctx.io.err(`${spec.destination} ya existe; repite con --force para sobrescribirlo`);
    return 1;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, await readTemplate(spec.template), 'utf8');
  ctx.io.out(`[OK]    ${spec.destination} escrito`);
  return 0;
}
