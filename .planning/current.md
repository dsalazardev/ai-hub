# Estado de la sesión — idea-input 35/36: falta solo 5.8 (checklist manual del propietario) — 2026-11-10

**Change:** `openspec/changes/idea-input/` — **15/36 tareas** marcadas (fases 1 y 2 cerradas con gate verde).
Detalle completo en `.planning/impl_idea-input.md`. Sin git, sin publicar.

## Instrucción vigente del propietario

Ejecutar las fases 3, 4 y 5 **seguidas, sin parar entre fases**, y cerrar con **una sola suite completa**. Parar y
reportar solo si: una sonda contradice D1, D7 o D10; el gate queda rojo por algo que no sea la cifra de `pack.test`;
o aparece una desviación de contrato que necesite decisión. Al final entregar: tareas, suite, `pack.test` con la
cifra real, `validate --strict`, desviaciones acumuladas y la checklist manual pendiente (**condición de cierre**:
el change no se archiva hasta que el propietario ejecute la checklist en Windows Terminal y conhost con PowerShell
5.1 y pegue la salida en `impl_idea-input.md`; la tarea 5.8 no se marca hasta entonces).

## Hecho en esta sesión, aún SIN marcar (código escrito, typecheck limpio)

- 2.6 ampliada por el propietario: `discord-token-stdin` booleano en `args.ts` + test de parser (ya en
  `tests/idea-input.test.ts`). La tarea 2.6 ya estaba marcada; su texto se amplió en `tasks.md`.
- **Fase 3 (código):** `core/src/cli/idea.ts` — `IdeaCancelled`, `EditorHost`, `splitCommandLine`, `editorName`,
  `isGuiEditor` (notepad, notepad++, sublime_text, code/code-insiders sin `--wait`), `resolveEditor`
  ($VISUAL > $EDITOR > `code --wait` en PATH > notepad|vi), `ideaFromEditor` (temporal fuera del root, confirmación
  solo si GUI **y** archivo sin cambios, borrado en `finally`), `realEditorHost` (`.cmd` vía `cmd.exe /d /c`,
  SIGINT → cancelación, `waitForEnter`).
- **Fase 4 (código):** `createIdeaReader` (máquina pura), `readIdeaFromTerminal` (raw mode + `\x1b[?2004h`,
  restauración robusta, ventana de silencio 30 ms, Esc 50 ms, render acotado contador + 3 líneas con throttle 50 ms,
  drenado con tope 5 s, desbordamiento → informa y vuelve a preguntar, Ctrl+E → editor), `IDEA_HELP`.
  `AssistantPrompts.longText?` + adaptador clack; paso 6 (`askIdea`) usa `longText` o, si falta, `text`.
- **Fase 5 (código):** `writeBacklogSeed(ctx, idea, note, now)` → líneas; `renderSeed`, `classifySeed` (0.13.0 por
  plantilla exacta → migra si coincide; con fence → sin cambios/colisión). `PRE_PROMPT_HISTORY` en `preprompt.ts`
  (hash 0.13.0). `materialize.ts`: núcleo `threeWay` extraído de `copyOnce` + `refreshTemplateFile` (registro en
  `.scaffold.json`, hashes conocidos = intacto). `seedIdea` con `fenceIdea`. `connectFromFlags(flags, ctx, idea)`.
  `cmdInit`: resuelve la idea por flags antes de `prepareInit` (errores → 2, cancelación → mensaje y 0), línea
  `idea:` en **stderr** en dry-run, semilla tras el apply y antes de `--connect-hermes`. `CliContext.ideaStdin` y
  `editorHost`.
- Verificado: `tsc --noEmit` limpio; `assistant.test.ts`, `control-onboarding*.test.ts` e `idea-input.test.ts`
  → 4 archivos, 95 pasados, sin cambiar aserciones existentes.

## Pendiente para mañana (en este orden)

1. **Tests fase 3** (unit, `tests/idea-input.test.ts`): 3.1 seis casos de `resolveEditor` + comillas; 3.2 editores
   falsos (500 ms, notepad que sale al instante y escribe tras confirmar, nano 1 s sin guardar, code --wait, code sin
   --wait); 3.3 temporal borrado en éxito/fallo/cancelación y temporal dentro del root → 2; 3.4 sin TTY → 2 sin spawn.
2. **Tests fase 4** (unit): 4.1 máquina con trozos arbitrarios; 4.2 restauración (terminador, Ctrl+C, Esc,
   excepción inyectada en `output.write`) y línea de ayuda; 4.3 1 MiB → salida < 64 KiB y contador real; 4.4 `.` en
   mitad de un pegado sin marcadores y 0 bytes sin leer; 4.5 desbordamiento; 4.6 pegado 2000 líneas + `p.confirm`
   sin respuesta.
3. **Sondas PTY** (integration, `tests/idea-input-pty.test.ts`): 4.7 nivel 2 (python `pty`, skip en win32), 4.8
   nivel 3 (node-pty, ConPTY; driver sobre `dist/cli/idea.js` + powershell para detectar fuga; skip si `dist` está
   desactualizado o falta node-pty), 4.9 Ctrl+C a mitad de pegado. Desviación a registrar: las sondas PTY usan un
   driver del lector en lugar de `init` completo con apply (el apply ejecuta Spec Kit vía uvx).
4. **Tests fase 5**: 5.1 seis casos de semilla con los fixtures de 0.13.0; 5.2 tres vías del pre-prompt + hash en
   historial + **no destrucción** (`uninstall skill <id>`, `sync` que retira destinos, `purge --yes`); 5.3 `IDEA.md`
   con `##` y 4 backticks y `init --yes --idea-file … --connect-hermes --discord-token-stdin` (añadir a
   `control-onboarding-flow.test.ts`); 5.4/5.5 e2e en un archivo nuevo `tests/idea-input-e2e.test.ts` en el proyecto
   **integration** (añadirlo a `vitest.config.ts` y a la tabla de D9): hash igual sin idea/con 1 MiB, centinela de
   las 4 fuentes solo en `seed.md`/`IDEA.md`, `--idea-file` 1 MiB byte a byte, binario → 2 sin escribir; 5.6
   regresión.
5. **5.7 docs:** `core/README.md` sección «Idea del proyecto»; fila de superficie en `core/SECURITY.md`; aviso en
   `README.md` del taller; ampliar la sección «Sin publicar» del `CHANGELOG.md`; test de documentos.
6. `npm run build` → ajustar `pack.test` si cambia la cifra (hoy 1987) → **una sola suite completa** → validate,
   doctor, manifest:check → marcar 3.x, 4.x, 5.1–5.7 → informe final.

## Entorno

- `node-pty` 1.1.0 instalado con `npm install --no-save` en `core/` (un `npm install`/`npm ci` lo quita; entonces las
  sondas de Windows se saltan con su motivo).
- Memoria libre al empezar: ~3 GB; el gate completo tarda 15–22 min. No lanzar dos suites a la vez.
- Lecciones: no usar heredoc/sed de Bash para editar código con escapes o comillas raras; usar Edit.
