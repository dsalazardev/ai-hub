# Estado de la sesión — aplicación de `harden-harness-orchestration` — 2026-11-24

- **Rama:** `codex/harden-harness-orchestration` (base `c11feda`). Sin commits, push, merge ni publicaciones.
- **Progreso:** 139/176 tareas con evidencia (detalle en `.planning/impl_harden-harness-orchestration.md`). Esta continuación: 3.11, 3.19, 4.68, 4.69, 4.70, 5.14, 5.15, 5.17.
- **Aprobación:** la de `/opsx:apply` (desarrollo local y entornos sintéticos). Ninguna operación sobre consumidores, cuentas o servicios reales.

## Continuación (b), 2026-11-24 — sin tareas nuevas marcadas (139/176)

- Hecho: contrato R-019 sin ramificar por nombre (descriptores); evidencia remota de PR en GitHub; ingest con `ingest_unsupported_tracker`; runner integrado con dobles (`executeGrantedRun`, descubrimiento, sondas, reanudación, lanzador real que no lanza sin declaración verificada); E2E de Codex opt-in (omitido); omisión de `sync` resuelta con junction; `manifest.yaml` con las cuatro garantías de X2 que faltaban; CI `platform-evidence` con JUnit y comprobación de pruebas POSIX (preparado, sin ejecutar).
- Verificación: pruebas dirigidas en verde (tracker-contract 31, control 69, runner 41+, manifest 75, pack y ratchets); typecheck, build, `manifest:check`; OpenSpec válido. Suite completa detenida por el host por memoria baja tras 65/84 archivos (1001 aprobadas, 0 fallidas); no se relanzó. Archivos no alcanzados: adoption, agent-contract, brand, catalog-integrity, cli, consumer-state, env-contract, gate-hooks, gates, idea-input-e2e, idea-input-pty, install-angular, install-generic, measured-counts, pack, speckit-doctor, speckit-install, speckit-preflight (cli, env-contract y pack sí se ejecutaron aparte tras sus cambios).
- Decisión pedida al propietario: 5.7, 5.11, 5.12, 5.16 y 5.18 tienen implementación, integración y pruebas locales; solo las retiene el «Antes: 5.6» (condicionada a 2.6).

## Verificación

- **Suite:** `npm test` en serie, ejecución única tras el último cambio: 81/81 archivos, 1285 aprobadas, 0 fallidas, 11 omitidas (POSIX, pty y node-pty no instalado).
- **Comprobaciones:** typecheck, build y `manifest:check` en verde; ratchets en verde tras aceptar 5 rechazos nuevos justificados (257 rechazos, 23 sin uso; Knip no crece).
- **OpenSpec:** `openspec validate --strict` válido; trazabilidad regenerada (125/125 requisitos con escenario y tarea, sin ciclos).

## Pendiente (37)

- **Local implementado, abierto por dependencia o evidencia:** 5.10 (falta POSIX; job `platform-evidence` preparado en `.github/workflows/ai-hub.yml`, sin ejecutar), 5.11, 5.12, 5.16 (verificadas aisladamente con dobles; integración tras 5.6 ← 2.6).
- **Otro entorno:** 3.23 (todo lo determinista en verde en Windows, incluido `ai-hub captures list|release`; falta reproducir 1.16 en CI Linux y Windows). 3.21 (documentación hecha y fijada por `docs-writes.test.ts`; su «Antes» incluye 3.23).
- **Investigación sin fuente fiable:** 4.25 (versión mínima de Hermes para `cron pause|resume`: «no verificada»; necesita el experimento 2.5).
- **Evidencia real:** 5.13 (2.6), 5.18 (Codex real con `AI_HUB_CODEX_E2E=1`).
- **Tras publicar:** 3.24.
- **Experimentos sin autorización:** 1.13 y hito 2; condicionadas 5.1–5.6, 5.19–5.21, 6.1; hito 7 (medición real).
- **Excluido:** 4.88 (SC-03 deshabilitado).
