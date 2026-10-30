# Estado de la sesión — tui-onboarding aplicado (2026-10-30)

**Change activo:** `tui-onboarding` — **24/24 tareas aplicadas y verificadas** (0.7.0).
Anterior: `refuter-panel` (0.6.0) aplicado; `catalogo-completo` (0.5.0) archivado.

## Líneas de cierre

1. **Tareas marcadas:** 24/24 en `openspec/changes/tui-onboarding/tasks.md`, cada una con
   su sonda ejecutada y pegada en `.planning/impl_tui-onboarding.md`.
2. **Sonda de mismo hash:** el mismo input por asistente (prompts inyectados) y por flags
   (`parseArgs` sobre el argv equivalente) produce el mismo plan body y el mismo sha256 —
   full `118ac9b6…dd25d` y custom `e6736e29…3d742` por ambos caminos; el apply real
   repite `db5f7d5f…629a` entre corridas. Test permanente en `core/tests/assistant.test.ts`.
3. **Diff pipeado:** vacío byte a byte en las 5 comparaciones contra la línea base 1.1
   (`init` bare, `--dry-run`, `--preset python --dry-run`, `--yes --no-speckit`, árbol de
   8.504 archivos) — con el gate instalado, el flujo no interactivo queda intacto.
4. **`backlog/seed.md` contiene:** la idea del usuario **textual** (verbatim, el arnés no
   añade requisitos), la fecha del registro (YYYY-MM-DD) y el apuntador a
   `backlog/pre-prompt.md` (plantilla bilingüe es/en que instruye al agente del cliente:
   items con criterio verificable, priorización, `/speckit.constitution` y
   `/speckit-assess-intake` con invocación canónica por destino).
5. **Tarball:** 1.882 → **1.888 entradas** (+6: `assistant`, `assistant-clack`,
   `preprompt` × `.js`/`.d.ts`); unpacked 12.490.323 → **12.520.573 bytes** (+30.250,
   sólo `dist`). La dependencia `@clack/prompts` ^1.8.1 no viaja en el tarball: su árbol
   en `node_modules` mide 170.333 bytes (166,3 KB), JS puro sin binarios nativos.
6. **Prueba manual pendiente (TUI real, del usuario):** en una terminal real,
   `node core\dist\bin\ai-hub.js init` sin flags en un repo consumidor vacío — checklist
   completo en la sección "Prueba manual pendiente" del impl.

## Verificación final (salidas reales en impl_tui-onboarding.md)

- Suite completa: 28 archivos, **321 pasados / 1 skipped (preexistente)**, exit 0 —
  verificados por proyecto en secuencia (`unit`: 204+1 skipped; `integration`: 117)
  porque `npm test` en paralelo sólo fallaba por timeouts de saturación de I/O (cero
  AssertionErrors; desviación documentada). Typecheck, build (0.7.0) y `manifest:check`
  en verde.
- Doctor del taller: sano, exit 0, todos `[OK]`, sin cambios en los checks existentes
  (el aviso `backlog` es exclusivo de la rama de instalación).
- Consumidor temporal (runner real): asistente scriptado aplica el plan, escribe
  `backlog/seed.md` con la idea verbatim y `backlog/pre-prompt.md` bilingüe; doctor sano
  con y sin `backlog/` (`[OK] backlog: semilla presente` / aviso informativo, 0 FAILs);
  `sync.lock.json` y el `.gitignore` generado no conocen `backlog/`; cancelación en el
  primer paso → 0 archivos.

## Pendientes

- Publicar 0.7.0 en npm (fuera de sesión; condicionado a la revisión del diff).
- Archivar `tui-onboarding` (`/opsx-archive`): delta specs de `interactive-onboarding`,
  `backlog-seed` y `dev-cli` a las specs principales.
- Prueba manual de la TUI real (TTY) — comando y checklist en el impl.
- Drift preexistente de `preset-system` (cita 174 skills y 4.642/4.657 destinos en
  escenarios antiguos) — candidato a change de limpieza, fuera de alcance.
