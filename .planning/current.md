# Estado de la sesión — fabrica-verificable archivado con deudas — 2026-11-13

**Changes activos:** ninguno. Archivado hoy: `2026-11-13-fabrica-verificable` (33/43 tareas; 10 con deuda aceptada).
**Versión:** 0.16.0 sin cambios. El release es del propietario.
**Estado de implementación:** hitos 1–5 aplicados; hitos 6 y 7 no ejecutados (ver deudas).

## Cerrado

- Resolvedor único del listener (`core/src/control/listener.ts`) consumido por el enrolamiento, `control enroll --check` y `doctor`.
- Espera tras reinicio con backoff, tope de 300 s (`AI_HUB_WEBHOOK_WAIT_SECONDS`), estado `pendiente` y `--check --wait`.
- Escritor único atómico de `manifest.yaml` (`core/src/manifest/write.ts`) con gate de escritores.
- Sellado del lock sin escribir destinos (`sealLock`); si un destino cambia, cae a `runSync` avisando cuántos pisa.
- Idempotencia del paso de control sin re-enrolar ni reiniciar; migración de 0.16.0 con `--declare-tracker`.
- Captura de solo lectura del Hermes real (tarea 1.1): registrada en `.planning/findings.md`.
- Sincronización inline de los cuatro deltas sobre `openspec/specs/`: 12 requisitos añadidos y 4 modificados
  (hermes-control 4+2, dev-cli 4+1, interactive-onboarding 1+2, control-onboarding 2+1). Verificado: recuentos
  49, 76, 14 y 25; cada bloque añadido aparece una vez; cada bloque modificado coincide con su delta.
- Archivo: `openspec/changes/archive/2026-11-13-fabrica-verificable/`.
- Detalle de pruebas, desviaciones y mediciones en `impl_fabrica-verificable.md`.

## Deudas aceptadas al archivar (`impl_fabrica-verificable.md`)

- Hitos 6 y 7 completos (10 tareas): suite opt-in contra gateway real, fixture del store, medición del arranque en
  frío, README, verificación integral y reproducción con el CLI.
- Tarea 1.1 no medible: el perfil `hermes-control` ya no existía en el host al ejecutarla; el disparador real del
  fallo 1 queda sin observación y se cubre por fixture.
- El presupuesto restante de la espera no se implementó: el check tras un reinicio usa el tope completo.
- La prueba 4.2 no se vio fallar antes del arreglo; su rojo equivalente es la medición con el CLI.
- Timeouts de 10 s con cinco archivos en paralelo; repetidos en aislado pasan. Sin fijar workers.
- El gate de escritores es por línea y no detecta una ruta construida en una variable.

## Correcciones del archivado

- `dev-cli`, escenario «Plan contract»: `init --plan --declare-tracker` pasa a `init --dry-run --declare-tracker`
  (`--plan` no existe en el CLI).
- Los specs principales no están en git (`openspec/` es ignorado): no hay línea base versionada. La verificación
  fue por recuentos y bloques, no por `git diff`.
- Los nombres de función (`resolveListener`, `sealLock`) no aparecen en los requisitos: describen comportamiento.
  Los nombres viven en `design.md`, archivado con el change.

## Abierto (decide el propietario)

- Hitos 6 y 7 (ver deudas), con autorización y tiempo aparte.
- `hermesHome()` no respeta `HERMES_HOME`; solo el check `control:webhook` de `doctor` lo hace.
- Validación global: `openspec validate --all --strict` sale 1 por avisos de longitud preexistentes en
  `agent-guardrails`, `control-onboarding`, `dev-cli`, `preset-system` y `spec-kit-pipeline`. Ninguno es de este change.
- Release (versión, CHANGELOG) y prueba real con Hermes y GitLab.
