
## 2026-10-24 — replica-ai-hub-engine archivado

- Se completaron las 40 tareas del cambio (P0 rutas y sync, P1 manifiesto/CLI/skills, P2 guardias/reaper/ledger, integración y release).
- `openspec validate replica-ai-hub-engine` pasó y el cambio se archivó como `2026-10-24-replica-ai-hub-engine`; se crearon las specs `dev-cli`, `spec-kit-pipeline` y `agent-guardrails`.
- Decisión aplicada: los roles derivados (`prompt-explorer`, `reviewer-exploration`) apuntan a `canonical: orchestrator` y no generan archivos de agente.
- Decisión aplicada: el inventario generado vive en `core/manifest.json` para que `npm pack` lo incluya junto a `dist/` y `schema/`.
- Diferencia con el diseño: los destinos reales pasaron de 95 a 347 al declarar los cuatro targets; la verificación se hizo 347/347 y quedó registrada en `findings.md`.

## 2026-10-24 — generalize-ai-hub-engine archivado

- Se completaron las 58 tareas y el cambio se archivó como `openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/`.
- Specs actualizadas: `dev-cli`, `spec-kit-pipeline` y `agent-guardrails`; creadas `preset-system` y `harness-memory`.
- El motor quedó separado en `core/src`, `core/engine`, `core/agents` y `core/skills`; el dominio vive en `core/presets`.
- Se eliminaron OpenSpec y `/opsx` del runtime y de los presets; las 17 skills `speckit-*` son nativas.
- Revisiones finales: arquitectura PASS y tests PASS (22/22 requisitos con test directo).
- Verificación: 143 tests, manifest:check, drift, doctor, verify.sh y `openspec validate --all` en verde.

## 2026-10-26 - install-completo archivado

- 26/26 tareas y 4/4 artefactos completos.
- Main specs actualizados: agent-guardrails, dev-cli, harness-memory, preset-system.
- Archivo: `openspec/changes/archive/2026-10-26-install-completo/`.

## 2026-11-23 - harden-harness-orchestration: aprobaciÃ³n de aplicaciÃ³n (sesiÃ³n)

- AprobaciÃ³n del propietario en esta sesiÃ³n para aplicar la propuesta: desarrollo local, pruebas y verificaciones sobre entornos sintÃ©ticos. No es aprobaciÃ³n de spec (Â§5), concesiÃ³n de ejecuciÃ³n ni autorizaciÃ³n sobre consumidores, cuentas o servicios reales.
- Decisiones: D-65 aceptada (sin ediciÃ³n de configuraciÃ³n ajena existente; instalaciÃ³n degradada mientras haya pendientes); SC-03 deshabilitado (4.88 no se implementa); SC-01 autorizado para implementar como modo opcional desactivado por defecto, sin activarlo en ningÃºn consumidor (no cumple #1-C6/#3-C9); SC-02 rechazado para ejecuciÃ³n.
- Autorizado ademÃ¡s: descarga de paquetes pÃºblicos para 3.22 (verificando identidad, solo sobre fixtures aisladas) y paquete local candidato. No autorizado: GitLab/GitHub reales, Hermes/Discord reales, harnesses reales con cuota, frontera alternativa, publicaciÃ³n.
- Rama de desarrollo: `codex/harden-harness-orchestration` desde `c11feda`.

- 2026-11-24 - Continuación de `/opsx:apply`: 131 -> 139/176. Cerradas 3.11 (migración de escritores; el escritor de `manifest.yaml` conserva su mecanismo bajo lock X1 para no romper sus pruebas de contrato), 3.19 y 4.68-4.70 (adaptador GitHub con contract tests comunes sobre un doble HTTP; ninguna escritura en GitHub real), 5.14, 5.15 y 5.17 (runner con dobles; ejecución real deshabilitada). Supuesto A: umbrales de delegación con la procedencia de la issue #7, sin porcentaje de contexto medido; `delegation.verifier.agents` y `author_tier: balanced` quedan como propuestas al owner. Supuesto B: 5.8 sin dependencia de 5.6, justificado; la integración con el descubrimiento sigue pendiente. 4.25 sin fuente primaria: capacidad no verificada.

- 2026-11-24 (b) - Sin tareas nuevas marcadas. Corregida la ramificación por nombre de tracker (R-019) introducida antes; runner integrado con dobles; X2 completado en el escritor de manifest.yaml; suite completa detenida por memoria del host (65/84 archivos, 0 fallos), no relanzada.
