# Findings — add-agents-md

Registro de divergencias detectadas al contrastar `AGENTS.md` con `manifest.yaml` y `rules/core.md` (tarea 7.1). Ninguna se resuelve en silencio: se documenta la fuente superior aplicada.

| # | Tema | `manifest.yaml` | `AGENTS.md` | Resolución |
|---|---|---|---|---|
| 1 | Metodología activa | Registra `openspec/changes/**` para `spec-author` | Declara Spec Kit activo y OpenSpec legacy | Gana `AGENTS.md` (nivel 2); el manifiesto debe actualizarse en un cambio posterior |
| 2 | Scope de `spec-author` | `openspec/changes/**`, `.planning/**` | `.specify/**`, `specs/**`, `.planning/**` | Gana `AGENTS.md`; el manifiesto queda desactualizado respecto a Spec Kit |
| 3 | Scope de `explorer-domain` | Solo `.planning/findings.md` | Añade `.specify/assessments/**` | Gana `AGENTS.md` por los artefactos de assessment; pendiente reflejarlo en el manifiesto |
| 4 | Scope de implementers | `frontend/src/**`, `backend/src/**` | `frontend/**`, `backend/**` | Se documenta el layout de monorepo; ante duda gana la restricción más estricta del manifiesto |
| 5 | Roles derivados | No existen `Prompt-Explorer` ni `Reviewer-Exploration` | Se declaran como roles del orquestador | Se etiquetan explícitamente como derivados; no se crean archivos nuevos |
| 6 | Ruta del arnés | Todas las definiciones usan `.ai-hub/…` | `resolveAiHubDir()` con fallback a la raíz con `manifest.yaml` | Gana `AGENTS.md`; el helper aún no existe y se aplica el paso 5 |
| 7 | Hash aprobable | No definido | SHA-256 sobre `spec.md + plan.md + tasks.md` con canonicalización | Decisión nueva de §5.1; se aplica desde este cambio |

No se modificó `manifest.yaml` ni `rules/core.md`: la actualización del manifiesto es trabajo de un cambio posterior.
