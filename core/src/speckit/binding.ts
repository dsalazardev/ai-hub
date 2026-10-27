import type { EngineManifest } from '../engine/engine.js';
import { TARGETS, type ToolId } from '../sync/targets.js';
import { invocationFor } from './commands.js';

/**
 * Regla generada que enlaza Spec Kit con AI-Hub: roles por comando, invocación en la notación
 * de cada destino, efecto de cada estado de salida sobre las etiquetas, rutas canónicas y sello.
 * Se llama `ai-hub-speckit` y no `speckit-binding` porque en Pi el directorio de reglas
 * (`.pi/prompts`) es también el de comandos de Spec Kit, donde `speckit-*` está reservado.
 */
export const BINDING_RULE_ID = 'ai-hub-speckit';
export const BINDING_SOURCE = '@engine/engine/engine.yaml';
export const BINDING_MARKER_SOURCE = 'engine/engine.yaml';

/** Estados de salida en el orden en que aparecen en los comandos. */
export function exitStates(engine: EngineManifest): string[] {
  const states: string[] = [];
  for (const command of engine.commands) {
    for (const state of command.exit) {
      if (!states.includes(state)) {
        states.push(state);
      }
    }
  }
  return states;
}

function stateTable(engine: EngineManifest): string[] {
  return [
    '## Estados de salida y etiquetas',
    '',
    '| Estado | Efecto sobre la etiqueta |',
    '|---|---|',
    ...exitStates(engine).map((state) => `| \`${state}\` | ${engine.exit_effects[state]} |`),
    '',
    'Ningún agente mueve una etiqueta. `hermes-control` aplica el efecto; ante `KILL` (assess-decide) o',
    '`INVALID` (bug-assess) solo **propone** `ai::done` y un humano autorizado lo confirma.',
    `Se mantienen las ${engine.labels.length} etiquetas: ${engine.labels.map((label) => `\`${label}\``).join(', ')}.`,
  ];
}

const ARTIFACTS = [
  '## Artefactos canónicos (rutas relativas a la raíz del repositorio)',
  '',
  '- Constitución: `.specify/memory/constitution.md`',
  '- Assessment: `.specify/assessments/<slug>/{intake,research,problem,concept,decision}.md`',
  '- Feature: `specs/<feature>/{spec,plan,tasks}.md` (Spec Kit crea `<feature>` como `NNN-slug`)',
  '- Bug: `.specify/bugs/<slug>/{assessment,fix,test}.md`',
];

const SEAL = [
  '## Sello de `ai::spec-ready`',
  '',
  'SHA-256 sobre `specs/<feature>/plan.md`, `specs/<feature>/spec.md` y `specs/<feature>/tasks.md`:',
  'rutas relativas a la raíz, ordenadas, separador `/`, contenido con LF y sin BOM; por archivo',
  '`ruta + "\\n" + bytes`. Cualquier cambio posterior invalida la aprobación y una feature con',
  'alguno de los tres archivos ausente no se puede sellar.',
];

/** Cuerpo de la regla para un destino. Copilot no tiene Spec Kit y su copia no invoca comandos. */
export function bindingRule(engine: EngineManifest, tool: ToolId): string {
  const speckit = TARGETS[tool].speckit;
  const lines: string[] = ['# Spec Kit en AI-Hub: roles, estados y etiquetas', ''];
  if (speckit === null) {
    lines.push(
      `Este destino (${tool}) no tiene Spec Kit instalado: sus comandos no están disponibles aquí.`,
      'La ejecución ocurre en un destino con Spec Kit (Claude, OpenCode, Pi o Cursor) o por la CLI de Spec Kit.',
      'Esta regla solo informa de cómo se interpretan sus resultados.',
      '',
      ...stateTable(engine),
      '',
      ...ARTIFACTS,
      '',
      ...SEAL,
      '',
    );
    return lines.join('\n');
  }
  lines.push(
    `Spec Kit (\`${engine.speckit.package}\` ${engine.speckit.pin}) ejecuta los ${engine.commands.length} comandos.`,
    'AI-Hub define qué rol invoca cada uno, cómo se interpreta su salida y qué etiqueta se aplica.',
    '',
    '## Comandos',
    '',
    '| Comando | Invocación | Carril | Rol | Artefactos | Estados de salida |',
    '|---|---|---|---|---|---|',
    ...engine.commands.map((command) => {
      const roles = [command.role, ...(command.co_roles ?? [])].join(', ');
      return `| \`${command.speckit}\` | \`${invocationFor(command.speckit, speckit.separator)}\` | ${command.lane} | ${roles} | ${command.artifacts.join(', ')} | ${command.exit.join(', ')} |`;
    }),
    '',
    'Un agente solo invoca los comandos asignados a su rol; un comando de otro rol se rechaza.',
    '',
    ...stateTable(engine),
    '',
    ...ARTIFACTS,
    '',
    ...SEAL,
    '',
  );
  return lines.join('\n');
}
