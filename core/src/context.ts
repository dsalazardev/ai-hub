import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, StateNotFoundError } from './state.js';

const CURRENT_MD_PATH = '.planning/current.md';
const CONTEXT_OUT_PATH = '.planning/context-next.md';

function extractActiveChangeFromCurrentMd(content: string): string | null {
  const match = content.match(/^##\s+Cambio activo\s*\n([^\n]+)/m);
  if (!match) return null;
  const val = match[1].trim();
  return val === '_ninguno_' ? null : val;
}

function extractPendingTasks(tasksContent: string): string[] {
  return tasksContent
    .split('\n')
    .filter((line) => line.trimStart().startsWith('- [ ]'));
}

export async function buildContextFile(root: string): Promise<void> {
  const timestamp = new Date().toISOString();

  // Leer state.json
  const state = await readState(root);

  // Leer current.md
  const currentMdPath = path.join(root, CURRENT_MD_PATH);
  let currentMdContent: string | null = null;
  let currentMdWarning = '';
  try {
    currentMdContent = await fs.readFile(currentMdPath, 'utf8');
  } catch {
    currentMdWarning = '> [WARN] current.md no encontrado\n\n';
  }

  // Detectar desincronización
  let syncWarning = '';
  if (currentMdContent) {
    const currentMdActiveChange = extractActiveChangeFromCurrentMd(currentMdContent);
    if (
      currentMdActiveChange !== null &&
      state.active_change !== null &&
      currentMdActiveChange !== state.active_change
    ) {
      syncWarning = `> [WARN] Desincronización detectada: state.json indica '${state.active_change}' pero current.md indica '${currentMdActiveChange}'\n\n`;
    }
  }

  // Leer tasks.md del cambio activo
  let pendingTasksSection = '';
  if (state.active_change) {
    const tasksPaths = [
      path.join(root, 'openspec', 'changes', state.active_change, 'tasks.md'),
    ];
    for (const tasksPath of tasksPaths) {
      try {
        const tasksContent = await fs.readFile(tasksPath, 'utf8');
        const pending = extractPendingTasks(tasksContent);
        if (pending.length > 0) {
          pendingTasksSection = `## Tareas pendientes (${pending.length})\n\n${pending.join('\n')}\n\n`;
        } else {
          pendingTasksSection = `## Tareas pendientes\n\n_Todas las tareas completadas._\n\n`;
        }
        break;
      } catch {
        // tasks.md no encontrado para este cambio
      }
    }
  }

  // Resumen del state.json (sin el array completo de changes)
  const stateSummary = {
    version: state.version,
    project: state.project,
    active_change: state.active_change,
    updated_at: state.updated_at,
    total_changes: state.changes.length,
  };

  // Extraer secciones relevantes de current.md
  const currentMdSection = currentMdContent
    ? `## current.md\n\n${currentMdContent.trim()}\n\n`
    : currentMdWarning;

  // Generar el markdown de contexto
  const contextContent = [
    `<!-- context-next.md — generado por: node .ai-hub/core/src/bin/ai-hub.ts context -->`,
    `<!-- NO editar manualmente — se sobreescribe en cada sesión -->`,
    ``,
    `# Contexto de Sesión — ${timestamp}`,
    ``,
    syncWarning,
    `## Estado activo`,
    ``,
    `- **Cambio activo**: ${state.active_change ?? '_ninguno_'}`,
    `- **Proyecto**: ${state.project ?? 'doligestion'}`,
    `- **Total cambios registrados**: ${state.changes.length}`,
    ``,
    currentMdSection,
    pendingTasksSection,
    `## state.json (resumen)`,
    ``,
    '```json',
    JSON.stringify(stateSummary, null, 2),
    '```',
    ``,
    `---`,
    ``,
    `_Pega este contenido como primer mensaje en Claude Code para restaurar el contexto de sesión._`,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n'); // colapsar blancos múltiples

  const outPath = path.join(root, CONTEXT_OUT_PATH);
  await fs.writeFile(outPath, contextContent, 'utf8');
}
