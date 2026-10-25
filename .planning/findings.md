# Findings â€” add-agents-md

Registro de divergencias detectadas al contrastar `AGENTS.md` con `manifest.yaml` y `rules/core.md` (tarea 7.1). Ninguna se resuelve en silencio: se documenta la fuente superior aplicada.

| # | Tema | `manifest.yaml` | `AGENTS.md` | ResoluciÃ³n |
|---|---|---|---|---|
| 1 | MetodologÃ­a activa | Registra `openspec/changes/**` para `spec-author` | Declara Spec Kit activo y OpenSpec legacy | Gana `AGENTS.md` (nivel 2); el manifiesto debe actualizarse en un cambio posterior |
| 2 | Scope de `spec-author` | `openspec/changes/**`, `.planning/**` | `.specify/**`, `specs/**`, `.planning/**` | Gana `AGENTS.md`; el manifiesto queda desactualizado respecto a Spec Kit |
| 3 | Scope de `explorer-domain` | Solo `.planning/findings.md` | AÃ±ade `.specify/assessments/**` | Gana `AGENTS.md` por los artefactos de assessment; pendiente reflejarlo en el manifiesto |
| 4 | Scope de implementers | `frontend/src/**`, `backend/src/**` | `frontend/**`, `backend/**` | Se documenta el layout de monorepo; ante duda gana la restricciÃ³n mÃ¡s estricta del manifiesto |
| 5 | Roles derivados | No existen `Prompt-Explorer` ni `Reviewer-Exploration` | Se declaran como roles del orquestador | Se etiquetan explÃ­citamente como derivados; no se crean archivos nuevos |
| 6 | Ruta del arnÃ©s | Todas las definiciones usan `.ai-hub/â€¦` | `resolveAiHubDir()` con fallback a la raÃ­z con `manifest.yaml` | Gana `AGENTS.md`; el helper aÃºn no existe y se aplica el paso 5 |
| 7 | Hash aprobable | No definido | SHA-256 sobre `spec.md + plan.md + tasks.md` con canonicalizaciÃ³n | DecisiÃ³n nueva de Â§5.1; se aplica desde este cambio |

No se modificÃ³ `manifest.yaml` ni `rules/core.md`: la actualizaciÃ³n del manifiesto es trabajo de un cambio posterior.

---

## Baseline de `ai-hub doctor` — cambio replica-rsc-engine

Ejecutado el 2026-10-24 sobre `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\DESARROLLO\ai-hub`.

| Comprobación | Resultado |
|---|---|
| Directorio resuelto | `...\DESARROLLO\ai-hub` (fuente `manifest-root`; el nombre de carpeta es `ai-hub`) |
| Manifiesto | v2 válido, 8 roles / 17 comandos / 7 etiquetas / 4 destinos |
| Carriles | assessment 5/5, feature 9/9, bug 3/3 |
| Roles ? agentes | 8 resueltos (6 archivos + 2 derivados del orquestador) |
| Skills por comando | 17/17; assessment 5/5; bug 3/3 |
| Inventario | `core/manifest.json` actualizado |
| Lock | v2 con 347 destinos |
| Deriva | faltan 0 · desactualizados 0 · editados 0 · obsoletos 0 · enlaces 0 |
| `.ai-hubrc.json` | ausente (opcional) |
| Salida | `Resultado: sano` (código 0) |

Notas de la migración:

- Antes de ampliar destinos había 239 copias; al añadir Cursor y las reglas de OpenCode/Pi el lock pasó a 347. La segunda ejecución escribió 109 archivos nuevos y `sync --check` quedó en 0.
- `sync.lock.json` registra 347/347 hashes coincidentes (verificado con SHA-256 archivo por archivo).
- El plan de diseño hablaba de 95 destinos y la tarea 2.6 de 95/95; el número real creció al declarar los cuatro destinos.
- No quedan piezas ausentes para este cambio. `init --hooks` sigue siendo trabajo posterior, como declara el diseño.

---

## Inventario de acoplamiento — generalize-ai-hub-engine (tarea 1.1)

Barrido `rg -n "openspec|OpenSpec" core/src bootstrap harness agents rules orchestrator manifest.yaml`:

| Categoría | Ubicaciones | Decisión |
|---|---|---|
| Código de runtime | `core/src/state.ts`, `core/src/context.ts:54`, `core/src/harness/ledger.ts:132,146`, `core/src/cli/legacy.ts:43`, `core/src/sync/sync.ts:69-70` | Eliminar o mover a `.planning/` |
| Manifiesto y skills | `manifest.yaml` (9 mapeos `skill: openspec-*`, `shared_skills`, publish), `skills/shared/openspec-*` (6) | Reemplazar por 9 skills `speckit-*` y borrar las 6 |
| Bootstrap | `bootstrap/verify.sh` (secciones 8 y 9), `bootstrap/openspec-upgrade.mjs` | Purgar OpenSpec; validar `.specify/`, skills y `manifest:check` |
| Documentación de runtime | `rules/core.md`, `orchestrator/PROMPT.md`, `orchestrator/workflow.md`, `orchestrator/delegation-rules.md`, `agents/*.md` | Reescribir a Spec Kit |
| Contenido de dominio | `manifest.yaml` (agentes, referencias, reglas Doligestión), `harness/rules/05-no-dolibarrdal-inheritance.sh` | Mover a `presets/angular-express/` |

No se encontraron referencias a OpenSpec en `core/engine` porque ese módulo aún no existe. El `openspec/` del repositorio de autoría se conserva como histórico y no se lee en runtime.

---

## Verificación de generalize-ai-hub-engine

| Comprobación | Resultado |
|---|---|
| `npm --prefix core test` | 143 passed, 1 skipped (symlinks en Windows) |
| `npm run manifest:check` | OK |
| `ai-hub sync` / `ai-hub drift` | 0 escrituras / sin deriva |
| `ai-hub doctor` | 22 checks OK, `Resultado: sano` |
| `bootstrap/verify.sh` (Git Bash) | exit 0; 17 skills, manifiesto, drift y doctor |
| `npm pack --dry-run` | incluye `dist/`, `schema/`, `manifest.json`, `engine/`, `presets/`, `agents/`, `skills/`; sin tests |
| `rg openspec core/src core/skills core/presets` | 0 coincidencias |
| `rg /opsx core/presets core/skills skills` | 0 coincidencias (solo literales del test) |
| Términos de dominio en `core/src`, `core/engine`, `core/agents`, `core/skills` | 0 coincidencias |
| Migración del repo actual | `manifest.yaml` v2, `.ai-hub/` scaffolded, `.planning/state.json` activo |

Las copias generadas antiguas de `openspec-*` y `opsx-*` en `.claude/`, `.opencode/`, `.pi/` y `.cursor/` se eliminaron manualmente; `sync` ya no las produce.

Limitación de entorno: `bash` de WSL no está disponible; `bootstrap/verify.sh` se ejecutó con Git Bash (`C:\Program Files\Git\bin\bash.exe`) y pasó.
