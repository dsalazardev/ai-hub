import fs from 'node:fs/promises';
import path from 'node:path';
import { shellReads, unverifiableArgument, type ReadTarget, type RecognizedRead } from '../read-policy.js';

/**
 * Adaptador de la política de lectura (R-051, R-052): extrae del payload del host las lecturas reconocidas y resuelve
 * cada destino. Rutas relativas contra el directorio de trabajo, `~` expandido, separadores normalizados a `/` y el
 * destino real de los enlaces simbólicos. Un destino que no existe se compara por su nombre pedido (no se da por
 * seguro); uno que no se puede determinar queda como no verificable.
 */

export interface ReadEnvironment {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
}

/** Sistemas de archivos que por defecto no distinguen mayúsculas (NTFS, APFS). */
export function caseInsensitiveFs(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function slashes(file: string): string {
  return file.replace(/\\/g, '/');
}

export async function resolveReadTarget(raw: string, env: ReadEnvironment): Promise<ReadTarget> {
  const trimmed = raw.trim();
  if (trimmed === '' || unverifiableArgument(trimmed)) {
    return { requested: null, real: null };
  }
  const pathApi = env.platform === 'win32' ? path.win32 : path.posix;
  const expanded = trimmed === '~' || /^~[\\/]/.test(trimmed) ? pathApi.join(env.home, trimmed.slice(1)) : trimmed;
  const absolute = pathApi.resolve(env.cwd, expanded);
  const requested = slashes(absolute);
  const real = await fs.realpath(absolute).then(slashes, () => null);
  return { requested, real };
}

type Payload = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Herramientas de lectura, edición y búsqueda por host, con el campo que lleva la ruta y su valor por defecto. */
const TOOLS: Readonly<Record<string, { action: RecognizedRead['action']; fields: string[]; defaultCwd: boolean }>> = {
  // Claude Code
  Read: { action: 'read', fields: ['file_path'], defaultCwd: false },
  Edit: { action: 'edit', fields: ['file_path'], defaultCwd: false },
  MultiEdit: { action: 'edit', fields: ['file_path'], defaultCwd: false },
  NotebookEdit: { action: 'edit', fields: ['notebook_path'], defaultCwd: false },
  NotebookRead: { action: 'read', fields: ['notebook_path'], defaultCwd: false },
  Grep: { action: 'search', fields: ['path'], defaultCwd: true },
  Glob: { action: 'search', fields: ['path'], defaultCwd: true },
  LS: { action: 'search', fields: ['path'], defaultCwd: true },
  // OpenCode
  read: { action: 'read', fields: ['filePath', 'file_path', 'path'], defaultCwd: false },
  edit: { action: 'edit', fields: ['filePath', 'file_path', 'path'], defaultCwd: false },
  grep: { action: 'search', fields: ['path'], defaultCwd: true },
  glob: { action: 'search', fields: ['path'], defaultCwd: true },
  list: { action: 'search', fields: ['path'], defaultCwd: true },
};

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'run_command']);

/** Lecturas reconocidas del payload (Claude: `tool_name`/`tool_input`; OpenCode: `tool`/`args`). */
export async function recognizedReads(input: Payload, env: ReadEnvironment): Promise<RecognizedRead[]> {
  const tool = text(input.tool_name) ?? text(input.tool);
  const args = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : input.args) as Payload | undefined;
  if (tool === null || typeof args !== 'object' || args === null) {
    return [];
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = text(args.command);
    if (command === null) {
      return [];
    }
    const reads: RecognizedRead[] = [];
    for (const read of shellReads(command)) {
      reads.push({
        tool: `${tool}:${read.program}`,
        action: read.action,
        targets: read.paths === null ? null : await Promise.all((read.paths.length > 0 ? read.paths : ['.']).map((file) => resolveReadTarget(file, env))),
      });
    }
    return reads;
  }
  const spec = TOOLS[tool];
  if (!spec) {
    return [];
  }
  const value = spec.fields.map((field) => text(args[field])).find((item) => item !== null && item.trim() !== '') ?? null;
  if (value === null && !spec.defaultCwd) {
    return [{ tool, action: spec.action, targets: null }];
  }
  return [{ tool, action: spec.action, targets: [await resolveReadTarget(value ?? '.', env)] }];
}
