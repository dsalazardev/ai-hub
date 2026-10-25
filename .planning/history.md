
## 2026-10-24 — replica-rsc-engine archivado

- Se completaron las 40 tareas del cambio (P0 rutas y sync, P1 manifiesto/CLI/skills, P2 guardias/reaper/ledger, integración y release).
- `openspec validate replica-rsc-engine` pasó y el cambio se archivó como `2026-10-24-replica-rsc-engine`; se crearon las specs `dev-cli`, `spec-kit-pipeline` y `agent-guardrails`.
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
