import type { EngineManifest } from '../engine/engine.js';
import { TARGETS, type ToolId } from '../sync/targets.js';
import { invocationFor } from './commands.js';
import { closingContractSection } from './status.js';
import type { ProjectPolicyKnobs } from '../sync/config.js';

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
  '- Issue de la feature: su descripción lleva `ai-hub:feature=<NNN-slug>` (lo pone el Spec-Author); sin',
  '  ese marcador el plano de control no liga la issue con su feature y no propone nada para ella.',
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
export function bindingRule(engine: EngineManifest, tool: ToolId, policy: ProjectPolicyKnobs = {}): string {
  return [baseBindingRule(engine, tool), ...projectPolicySection(engine, policy)].join('\n');
}

/** Política del proyecto (E4): solo aparece si el proyecto declara algún knob (el hash no cambia si no). */
export function projectPolicySection(engine: EngineManifest, policy: ProjectPolicyKnobs): string[] {
  const lines: string[] = [];
  if (policy.wip !== undefined) {
    lines.push(`- Como máximo ${policy.wip} feature(s) en curso a la vez (\`ai-hub gate\` lo comprueba).`);
  }
  if (policy.maxRounds !== undefined) {
    lines.push(
      `- \`converge\` admite como máximo ${Math.min(policy.maxRounds, engine.loop.converge.max_rounds)} rondas \`NEEDS_WORK\` en este proyecto.`,
    );
  }
  if (policy.requireEars) {
    lines.push('- Los requisitos se redactan en notación EARS; reviewer-tests rechaza los que no la siguen.');
  }
  if (policy.requireTraceability) {
    lines.push('- Cada requisito se traza a al menos un test y cada task cita los requisitos que cubre.');
  }
  return lines.length === 0 ? [] : ['## Política del proyecto', '', ...lines, ''];
}

function baseBindingRule(engine: EngineManifest, tool: ToolId): string {
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
      ...closingContractSection(engine),
      '',
      ...ARTIFACTS,
      '',
      ...SEAL,
      '',
    );
    return lines.join('\n');
  }
  lines.push(
    `Spec Kit (\`${engine.speckit.package}\` ${engine.speckit.supported}) ejecuta los ${engine.commands.length} comandos.`,
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
    ...closingContractSection(engine),
    '',
    ...ARTIFACTS,
    '',
    ...SEAL,
    '',
  );
  return lines.join('\n');
}
