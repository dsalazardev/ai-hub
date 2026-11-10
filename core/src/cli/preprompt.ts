/**
 * Pre-prompt del backlog semilla (design D10): plantilla del motor, bilingüe, que init
 * escribe en `backlog/pre-prompt.md`. El CLI no la ejecuta ni llama a ningún modelo:
 * quien la ejecuta es el agente del cliente con su propia key (R4).
 */
export const PRE_PROMPT = `# Pre-prompt: de la semilla al backlog priorizado

> Instrucciones para el agente del cliente (Claude Code, OpenCode, Pi, Cursor o Copilot).
> El arnés no ejecuta este prompt ni llama a ningún modelo: lo ejecuta tu agente, con tu key.

## Español

Convierte la idea registrada en \`backlog/seed.md\` en un backlog priorizado.

**Antes de proponer nada, entrevista a la persona** (una pregunta cada vez; propón tu mejor
respuesta y deja que la corrija; cierra cada bloque con un resumen de dos líneas):

- ¿Qué entra y qué debe salir? ¿Cada cuánto se repite el trabajo?
- ¿Cómo sabrá que salió bien? Pide uno o dos ejemplos reales de "bien" y de "mal"; sin ejemplos,
  no construyas: vuelve a preguntar.
- ¿Qué partes son deterministas (las hace código), cuáles necesitan criterio (un agente) y cuáles
  solo una persona (aprobar, decidir, todo lo que sale del repositorio)?
- **Filtro de idoneidad:** si el trabajo no se repite, no tiene una salida comparable o depende
  sobre todo de juicio humano, dilo con claridad: no es una buena tarea para un agente y propón
  la alternativa (un script, una lista de comprobación o hacerlo a mano).

1. Lee \`backlog/seed.md\`: la idea es textual; no inventes requisitos que no estén ahí.
2. Descompón la idea en items de backlog: una necesidad por item, cada uno con un criterio
   de aceptación verificable (un comando, una comprobación o un artefacto observable).
3. Prioriza: marca qué item va primero y por qué; no prometas fechas.
4. Propón la constitución del proyecto con /speckit.constitution (en Claude y Cursor se
   invoca /speckit-constitution; en OpenCode y Pi, /speckit.constitution).
5. Arranca el carril de assessment con el primer /speckit-assess-intake
   (en OpenCode y Pi, /speckit.assess.intake) sobre el item priorizado.

## English

Turn the idea recorded in \`backlog/seed.md\` into a prioritized backlog.

**Interview the person before proposing anything** (one question at a time; offer your best
answer and let them correct it; close each block with a two-line summary):

- What comes in and what must come out? How often does the work repeat?
- How will they know it went well? Ask for one or two real examples of "good" and "bad"; without
  examples, do not build: ask again.
- Which parts are deterministic (code does them), which need judgement (an agent) and which only a
  person can do (approve, decide, anything that leaves the repository)?
- **Suitability filter:** if the work does not repeat, has no comparable output or depends mostly
  on human judgement, say so plainly: it is not a good task for an agent, and propose the
  alternative (a script, a checklist, or doing it by hand).

1. Read \`backlog/seed.md\`: the idea is verbatim; do not invent requirements that are not there.
2. Break the idea into backlog items: one need per item, each with a verifiable acceptance
   criterion (a command, a check, or an observable artifact).
3. Prioritize: mark which item comes first and why; do not promise dates.
4. Propose the project constitution with /speckit.constitution (Claude and Cursor invoke
   /speckit-constitution; OpenCode and Pi, /speckit.constitution).
5. Start the assessment lane with the first /speckit-assess-intake
   (OpenCode and Pi: /speckit.assess.intake) on the prioritized item.
`;

/**
 * idea-input D13: SHA-256 de cada plantilla del pre-prompt publicada. Un `backlog/pre-prompt.md` sin registrar en
 * `.ai-hub/.scaffold.json` (instalaciones ≤ 0.13.0) cuyo hash está aquí cuenta como intacto y se actualiza; un test
 * exige que la plantilla actual esté siempre en la lista. Añade el hash nuevo cuando cambies `PRE_PROMPT`.
 */
export const PRE_PROMPT_HISTORY: readonly string[] = [
  // 0.7.0–0.10.0 (commit e094141; texto en core/tests/fixtures/idea-0.7.0/pre-prompt.md)
  '43924063aceaf9eeab7bb4a07e8e43f20d9cc87ca4d532e5727588da3b72dd95',
  // 0.11.0–0.13.0 (commit e063383; capturado en core/tests/fixtures/idea-0.13.0/pre-prompt.sha256)
  '5c266356c52ff161a9431020ff87fdb7344cf52ab42caf9c2e08328fd3e784cb',
];
