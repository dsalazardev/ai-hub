# Estado de la sesión — refuter-panel aplicado (2026-10-29)

**Change activo:** `refuter-panel` — **31/31 tareas aplicadas y verificadas** (0.6.0).
Anterior: `catalogo-completo` (0.5.0) aplicado y archivado como
`2026-10-29-catalogo-completo`.

## Líneas de cierre

1. **Tareas marcadas:** 31/31 en `openspec/changes/refuter-panel/tasks.md`, cada una con
   su sonda ejecutada y pegada en `.planning/impl_refuter-panel.md`.
2. **Invariante de roles:** 8 → **9** (rol `refuter`, read-only, sin comandos; schema
   minItems/maxItems 9 + campo `read_only`; `ENGINE_COUNTS.roles` 9; regla en
   `crossValidate` que rechaza write-permissions en un rol read-only).
3. **Agentes:** 35 → **39** (`refuter-correctness`, `refuter-security`, `refuter-tests`,
   `finding-verifier` en `core/agents/` y `manifest.yaml` `agents.publish`; validación de
   `role` contra `engine.roles`; 29 declaraciones legacy retiradas).
4. **Cifras full re-medidas:** full **6853** (+16), presetOnly 40, customNoRubrics 6833,
   angularExpress 6868 — medidas en consumidor temporal con CLI 0.6.0 y uvx real;
   `install-counts.json` actualizado (agents 39, package 0.6.0).
5. **Veredicto del panel:** REFUTED / NOT-REFUTED — sólo un blocker o should-fix
   `CONFIRMED` produce `REFUTED`; `NOT-REFUTED` no es aprobación. Por hallazgo, el
   verifier emite CONFIRMED / REFUTED / UNPROVEN y sólo CONFIRMED bloquea. Despacho
   documentado (D3), no cableado: sin exit_effects, sin Spec Kit.
6. **Tokens upstream en los cuerpos:** **0** (brand.test 4/4 con `core/agents` en
   SCAN_TREES; un token upstream reintroducido falla el gate por aserción).

## Verificación final (salidas reales en impl_refuter-panel.md)

- Suite completa: 27 archivos, **292 pasados / 1 skipped**, exit 0; typecheck y build
  en verde (0.6.0).
- Doctor del taller: sano — 9/9 roles, 39 agentes, exit 0.
- Consumidor temporal full: plan = instalado (6853 = 6853), doctor sano, drift 0, los 4
  refuters en los 4 destinos de agente (cursor sin superficie de agentes, 0 archivos).
- brand.test 4/4.

## Pendientes

- Publicar 0.6.0 en npm (fuera de sesión).
- Archivar `refuter-panel` (`/opsx-archive`): los delta specs ya están rebasados
  (261 skills, 39 agentes, cifras medidas); el sync llevará 9 roles y los 4 requisitos
  ADDED a las specs principales.
- Drift preexistente observado (no causado por este change, fuera de alcance):
  `preset-system` cita 174 skills y 4.642/4.657 destinos en escenarios antiguos.
