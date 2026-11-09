// ai-hub:managed — generado por `ai-hub sync`; no editar (se regenera).
// Hook ejecutable de AI-Hub para OpenCode: antes de cada comando de shell consulta el preflight
// (`ai-hub hook pre`). Falla abierto: sin `npx`, sin arnés o ante cualquier error, no bloquea.
// Un solo archivo para las dos APIs de plugins de OpenCode (patrón adaptado de rsc-harness, MIT):
// la 1.x llama al export con nombre; la 2.x lee `id` + `setup(ctx)` del export por defecto.
import { spawnSync } from 'node:child_process';

function preflight(cwd, tool, args) {
  try {
    const result = spawnSync('npx', ['--no-install', 'ai-hub', 'hook', 'pre'], {
      cwd,
      input: JSON.stringify({ tool, args }),
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
      timeout: 30000,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    const output = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
    return output && output.blocked === true ? String(output.message || 'ai-hub: comando denegado') : null;
  } catch {
    return null;
  }
}

function before(cwd) {
  return async (input, output) => {
    const tool = input && input.tool;
    const args = (output && output.args) || (input && input.args) || {};
    const denied = preflight(cwd, tool, args);
    if (denied !== null) {
      throw new Error(denied);
    }
  };
}

export const AiHubPlugin = async ({ directory } = {}) => ({
  'tool.execute.before': before(directory || process.cwd()),
});

export default {
  id: 'ai-hub',
  server: AiHubPlugin,
  async setup(ctx) {
    const cwd = (ctx && (ctx.directory || ctx.worktree)) || process.cwd();
    if (ctx && ctx.tool && typeof ctx.tool.hook === 'function') {
      await ctx.tool.hook('execute.before', async (event) => before(cwd)(event, event));
    }
  },
};
