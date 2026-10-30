/**
 * Pre-prompt del backlog semilla (design D10): plantilla del motor, bilingüe, que init
 * escribe en `backlog/pre-prompt.md`. El CLI no la ejecuta ni llama a ningún modelo:
 * quien la ejecuta es el agente del cliente con su propia key (R4).
 */
export const PRE_PROMPT = `# Pre-prompt: de la semilla al backlog priorizado

> Instrucciones para el agente del cliente (Claude Code, OpenCode, Pi, Cursor o Copilot).
> El arnés no ejecuta este prompt ni llama a ningún modelo: lo ejecuta tu agente, con tu key.

## Español

Convierte la idea registrada en \`backlog/seed.md\` en un backlog priorizado:

1. Lee \`backlog/seed.md\`: la idea es textual; no inventes requisitos que no estén ahí.
2. Descompón la idea en items de backlog: una necesidad por item, cada uno con un criterio
   de aceptación verificable (un comando, una comprobación o un artefacto observable).
3. Prioriza: marca qué item va primero y por qué; no prometas fechas.
4. Propón la constitución del proyecto con /speckit.constitution (en Claude y Cursor se
   invoca /speckit-constitution; en OpenCode y Pi, /speckit.constitution).
5. Arranca el carril de assessment con el primer /speckit-assess-intake
   (en OpenCode y Pi, /speckit.assess.intake) sobre el item priorizado.

## English

Turn the idea recorded in \`backlog/seed.md\` into a prioritized backlog:

1. Read \`backlog/seed.md\`: the idea is verbatim; do not invent requirements that are not there.
2. Break the idea into backlog items: one need per item, each with a verifiable acceptance
   criterion (a command, a check, or an observable artifact).
3. Prioritize: mark which item comes first and why; do not promise dates.
4. Propose the project constitution with /speckit.constitution (Claude and Cursor invoke
   /speckit-constitution; OpenCode and Pi, /speckit.constitution).
5. Start the assessment lane with the first /speckit-assess-intake
   (OpenCode and Pi: /speckit.assess.intake) on the prioritized item.
`;
