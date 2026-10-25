# Sesión actual — `sanitize-ai-hub-residuals` en puerta humana

**Estado:** implementado y verificado el 2026-10-25; pendiente únicamente la publicación del
`iid + hash` de la puerta humana (`T7.8`). No se ha archivado.

## Alcance cerrado

- `origin: ai-hub` presente en **las 174 skills publicadas** (`manifest.yaml` → `skills.publish`).
  Las 17 `speckit-*` no publicadas siguen sin el campo, por diseño.
- `origin: ai-hub` = 0 en `core/skills`.
- `rules/skill-quality/` con las 4 rúbricas; `rules/skill-quality/` inexistente; los 4 ids del manifiesto
  apuntan al namespace nuevo.
- `agents/ai-hub` y `prompts/ai-hub` viven en `archive/upstream/ai-hub/` (14 archivos + README).
- Gate nuevo `core/tests/brand.test.ts`: marca, paridad de verbos, aridad de `add` y `origin`.
- Créditos intactos: `core/skills/shared/design/THIRD_PARTY.md` y
  `core/skills/shared/design/engine/LICENSE` (Leonxlnx, MIT) sin cambios; `NOTICE.md` conserva a
  Daner Alejandro Salazar Colorado como titular upstream y a Daner Alejandro Salazar Colorado como autor de ai-hub.

## Verificación final (2026-10-25)

```text
npm run manifest:build        exit 0
npm run build                 exit 0
npm run manifest:check        exit 0
npm run ai:test               exit 0 — 150 passed | 1 skipped (11 archivos)
ai-hub doctor                 exit 0 — "Resultado: sano" (22 checks)
npm run ai:typecheck          exit 0
git grep marca (6 rutas)      0 coincidencias
git grep ai-hub Spec-Kit/@dsalazardev   0 coincidencias
```

Gate demostrado en rojo con dos sondas temporales (token de marca y `ai-hub sello`) y en verde
tras retirarlas. Las sondas no dejaron archivos.

## Decisiones y desviaciones

1. **`.planning/history.md` no se modifica.** REQ-06 y el encargo lo declaran inmutable y su
   SHA-256 está en el conjunto de T0.1 que T7.6 verifica; escribir en él rompería esa comprobación.
   El cierre se registra aquí y en `.planning/findings.md`.
2. **El invariante de `origin` es "todas las publicadas" (174), no el 171 del plan.** El árbol
   ganó 3 skills publicadas (`gitlab-auth`, `gitlab-workflow`, `planning-with-files`); se les añadió
   el campo en vez de fijar un número obsoleto.
3. **Barrido de paridad más estricto que el plan.** Además de los verbos, se corrigieron 30 usos
   de "ai-hub" como adjetivo (`ai-hub voice`, `ai-hub ships`, `ai-hub preflight`…) para que ninguna
   mención `ai-hub <palabra>` pueda leerse como un comando inexistente.
4. **T7.8 abierto.** El remoto es GitHub (`dsalazardev/ai-hub`) y no hay issue asociada; no se
   inventa un `iid`.

## SHA-256 del conjunto aprobable

`939A6559422804CCDE9A1D42AC0E7417222D1598366E166EF77DCAD2BDF0C81F`

Canonicalización de `AGENTS.md §5`: rutas relativas ordenadas (`spec.md`, `design.md`, `tasks.md`),
separador `/`, contenido normalizado a LF, sin BOM; por archivo `ruta + "\n" + bytes`.

## Siguiente paso

Publicar `iid + hash` y pedir aprobación humana; después mover a `ai::in-dev`.
