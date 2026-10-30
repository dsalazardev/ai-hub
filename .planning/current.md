# Estado de la sesión — script-choice aplicado (2026-10-30)

**Change activo:** `script-choice` — **27/27 tareas aplicadas y verificadas** (0.8.0).
Anterior: `tui-onboarding` (0.7.0) archivado; `refuter-panel` (0.6.0) aplicado.

## Líneas de cierre

1. **Tareas marcadas:** 27/27 en `openspec/changes/script-choice/tasks.md`, cada una con
   su sonda ejecutada y pegada en `.planning/impl_script-choice.md` (§1.1–§7.3 + §8 de
   cierre con las desviaciones consolidadas).
2. **Diff pipeado:** vacío byte a byte en las 6 comparaciones contra la línea base 1.1
   (`init` bare, `--dry-run`, `--preset python --dry-run`, `--script ps --dry-run`,
   `--yes --no-speckit`, árbol de 8.504 archivos) — verificado en TRES corridas con el
   dist del change (3.4 tras el contrato, 6.4 tras el banner, 7.3a con el 0.8.0 final):
   el flujo no interactivo queda intacto y cero bytes de banner existen fuera del gate
   de TTY.
3. **Sonda de mismo hash:** bare ≡ `--scripts sh,ps,py` explícito →
   `5e069b92516c50049f289a61e8d2872398125844837d97d6b37b7817dee9c09b` por ambos caminos
   (campo `scripts` ausente en ambos planes: sólo entra al hash cuando el conjunto difiere
   de los tres). Sonda 5.3 con conjunto ≠ default: `d01b933d…0556c` por asistente y por
   flags. Test permanente en `core/tests/assistant.test.ts`.
4. **`{py}` instala:** un solo init py → `.specify/scripts/python` (6 archivos) más el
   compañero `powershell` que specify-cli 1.2.5 envía incondicionalmente con el init py
   (manifiesto de integridad: 12 entradas de script) — carga propia de specify, no un
   miembro del conjunto: el instalador no lo añade, invoca ni borra. Spec delta corregido
   en sesión; hallazgo en `.planning/findings.md`.
5. **`speckit:shell` con activo py:** `[OK] speckit:shell: python ejecuta los scripts py`
   (doctor sano, exit 0); con activo sh resuelve Git Bash fuera del PATH
   (`C:\Program Files\Git\bin\bash.exe`).
6. **Tarball:** 1.888 → **1.890 entradas** (+2: `dist/cli/banner.js` + `dist/cli/banner.d.ts`);
   unpacked 12.520.573 → **12.535.153 bytes** (+14.580, sólo `dist`). Pin en
   `core/tests/pack.test.ts`.

## Verificación final (salidas reales en impl_script-choice.md)

- Suite completa: 29 archivos, **357 pasados / 1 skipped (preexistente)**, exit 0 — por
  proyecto en secuencia (`unit`: 223 + 1 skipped; `integration`: 134, 442 s) porque
  `npm test` en paralelo satura I/O. Typecheck, build (0.8.0), `manifest:check`,
  `release.test` (0.8.0) y `pack.test` (pin 1890) en verde.
- Doctor del taller: sano, exit 0, todos `[OK]`, sin cambios en los checks existentes.
- E2e real (uvx, specify-cli 1.2.5) en tres consumidores temporales: `--scripts py`,
  `--scripts py,sh --script sh` y bare — los tres con doctor sano; diff pipeado vacío
  contra la línea base 0.7.0; mismo hash bare ≡ `--scripts sh,ps,py`; sin
  `speckit.scripts` el manifest queda idéntico a 0.4–0.7 (los tres tipos).
- `openspec validate script-choice --strict` en verde; `--all`: 8 passed, 0 failed
  (WARNING preexistente de longitud en un spec principal).

## Pendientes

- Publicar 0.8.0 en npm (fuera de sesión; el usuario hace commit/push/publicación).
- Prueba manual de la TUI con TTY real (del usuario): banner renderizado (apagado con
  `NO_COLOR`), multiselect del conjunto con mínimo 1 (cero no continúa), select del
  activo cuando elige más de un tipo — `node core\dist\bin\ai-hub.js init` sin flags en
  un repo consumidor vacío.
- Archivar con `/opsx-archive script-choice` cuando el usuario lo pida.
- Drift preexistente de `preset-system` (cita 174 skills y 4.642/4.657 destinos en
  escenarios antiguos) — candidato a change de limpieza, fuera de alcance.
- `backlog-craft` como change siguiente, con sus referencias evaluadas.
