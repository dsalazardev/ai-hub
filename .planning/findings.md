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

---

## Baseline de `ai-hub doctor` � cambio replica-ai-hub-engine

Ejecutado el 2026-10-24 sobre `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\DESARROLLO\ai-hub`.

| Comprobaci�n | Resultado |
|---|---|
| Directorio resuelto | `...\DESARROLLO\ai-hub` (fuente `manifest-root`; el nombre de carpeta es `ai-hub`) |
| Manifiesto | v2 v�lido, 8 roles / 17 comandos / 7 etiquetas / 4 destinos |
| Carriles | assessment 5/5, feature 9/9, bug 3/3 |
| Roles ? agentes | 8 resueltos (6 archivos + 2 derivados del orquestador) |
| Skills por comando | 17/17; assessment 5/5; bug 3/3 |
| Inventario | `core/manifest.json` actualizado |
| Lock | v2 con 347 destinos |
| Deriva | faltan 0 � desactualizados 0 � editados 0 � obsoletos 0 � enlaces 0 |
| `.ai-hubrc.json` | ausente (opcional) |
| Salida | `Resultado: sano` (c�digo 0) |

Notas de la migraci�n:

- Antes de ampliar destinos hab�a 239 copias; al a�adir Cursor y las reglas de OpenCode/Pi el lock pas� a 347. La segunda ejecuci�n escribi� 109 archivos nuevos y `sync --check` qued� en 0.
- `sync.lock.json` registra 347/347 hashes coincidentes (verificado con SHA-256 archivo por archivo).
- El plan de dise�o hablaba de 95 destinos y la tarea 2.6 de 95/95; el n�mero real creci� al declarar los cuatro destinos.
- No quedan piezas ausentes para este cambio. `init --hooks` sigue siendo trabajo posterior, como declara el dise�o.

---

## Inventario de acoplamiento � generalize-ai-hub-engine (tarea 1.1)

Barrido `rg -n "openspec|OpenSpec" core/src bootstrap harness agents rules orchestrator manifest.yaml`:

| Categor�a | Ubicaciones | Decisi�n |
|---|---|---|
| C�digo de runtime | `core/src/state.ts`, `core/src/context.ts:54`, `core/src/harness/ledger.ts:132,146`, `core/src/cli/legacy.ts:43`, `core/src/sync/sync.ts:69-70` | Eliminar o mover a `.planning/` |
| Manifiesto y skills | `manifest.yaml` (9 mapeos `skill: openspec-*`, `shared_skills`, publish), `skills/shared/openspec-*` (6) | Reemplazar por 9 skills `speckit-*` y borrar las 6 |
| Bootstrap | `bootstrap/verify.sh` (secciones 8 y 9), `bootstrap/openspec-upgrade.mjs` | Purgar OpenSpec; validar `.specify/`, skills y `manifest:check` |
| Documentaci�n de runtime | `rules/core.md`, `orchestrator/PROMPT.md`, `orchestrator/workflow.md`, `orchestrator/delegation-rules.md`, `agents/*.md` | Reescribir a Spec Kit |
| Contenido de dominio | `manifest.yaml` (agentes, referencias, reglas Doligesti�n), `harness/rules/05-no-dolibarrdal-inheritance.sh` | Mover a `presets/angular-express/` |

No se encontraron referencias a OpenSpec en `core/engine` porque ese m�dulo a�n no existe. El `openspec/` del repositorio de autor�a se conserva como hist�rico y no se lee en runtime.

---

## Verificaci�n de generalize-ai-hub-engine

| Comprobaci�n | Resultado |
|---|---|
| `npm --prefix core test` | 143 passed, 1 skipped (symlinks en Windows) |
| `npm run manifest:check` | OK |
| `ai-hub sync` / `ai-hub drift` | 0 escrituras / sin deriva |
| `ai-hub doctor` | 22 checks OK, `Resultado: sano` |
| `bootstrap/verify.sh` (Git Bash) | exit 0; 17 skills, manifiesto, drift y doctor |
| `npm pack --dry-run` | incluye `dist/`, `schema/`, `manifest.json`, `engine/`, `presets/`, `agents/`, `skills/`; sin tests |
| `rg openspec core/src core/skills core/presets` | 0 coincidencias |
| `rg /opsx core/presets core/skills skills` | 0 coincidencias (solo literales del test) |
| T�rminos de dominio en `core/src`, `core/engine`, `core/agents`, `core/skills` | 0 coincidencias |
| Migraci�n del repo actual | `manifest.yaml` v2, `.ai-hub/` scaffolded, `.planning/state.json` activo |

Las copias generadas antiguas de `openspec-*` y `opsx-*` en `.claude/`, `.opencode/`, `.pi/` y `.cursor/` se eliminaron manualmente; `sync` ya no las produce.

Limitaci�n de entorno: `bash` de WSL no est� disponible; `bootstrap/verify.sh` se ejecut� con Git Bash (`C:\Program Files\Git\bin\bash.exe`) y pas�.

---

## Inventario sanitize-ai-hub-residuals (T0, 2026-10-25)

Linea base:

| Dato | Valor |
|---|---|
| `git rev-parse HEAD` | `899efa2ace0ce1db49070243f952b51265bb6535` |
| `git status --short` | vacio (arbol limpio al iniciar T0) |
| Comando de inventario | `git grep -n -i -E "\brsc\b|dsalazardev|ai-hub" -- core/skills rules manifest.yaml README.md AGENTS.md` |
| Coincidencias totales | **481** |
| Archivos con coincidencias | **235** |
| Inventario literal completo | `.planning/ai-hub-inventory-2026-10-25.txt` |

### Recuento por archivo

```text
count  path
    1  core/skills/shared/ab-testing/SKILL.md
    1  core/skills/shared/accessibility/SKILL.md
    1  core/skills/shared/agent-eval/SKILL.md
    1  core/skills/shared/agent-safety/SKILL.md
    4  core/skills/shared/analyze/SKILL.md
    2  core/skills/shared/analyze/evals/README.md
    1  core/skills/shared/analyze/evals/cases.yaml
    1  core/skills/shared/angular/SKILL.md
    1  core/skills/shared/angular/evals/cases.yaml
    1  core/skills/shared/api-connector-builder/SKILL.md
    1  core/skills/shared/api-design/SKILL.md
    1  core/skills/shared/astro/SKILL.md
    1  core/skills/shared/astro/evals/cases.yaml
   11  core/skills/shared/author-skill/SKILL.md
    5  core/skills/shared/author-skill/evals/README.md
   11  core/skills/shared/author-skill/evals/cases.yaml
    1  core/skills/shared/author-skill/references/description-recipe.md
    9  core/skills/shared/author-skill/references/skill-conventions.md
    1  core/skills/shared/automation-flows/SKILL.md
    1  core/skills/shared/aws-essentials/SKILL.md
    1  core/skills/shared/backups/SKILL.md
    1  core/skills/shared/bash-scripting/SKILL.md
    1  core/skills/shared/building-agents/SKILL.md
    1  core/skills/shared/chatbot/SKILL.md
    1  core/skills/shared/chrome-extension/SKILL.md
    3  core/skills/shared/clarify/SKILL.md
    1  core/skills/shared/clarify/evals/cases.yaml
    1  core/skills/shared/clickhouse-analytics/SKILL.md
    1  core/skills/shared/cloudflare/SKILL.md
    4  core/skills/shared/code-review/SKILL.md
    1  core/skills/shared/code-review/evals/cases.yaml
    1  core/skills/shared/codebase-onboarding/SKILL.md
    1  core/skills/shared/compose-multiplatform/SKILL.md
    2  core/skills/shared/connect-tool/SKILL.md
    6  core/skills/shared/constitution/SKILL.md
    2  core/skills/shared/constitution/evals/README.md
    1  core/skills/shared/constitution/evals/cases.yaml
    2  core/skills/shared/constitution/references/constitution-template.md
    1  core/skills/shared/context-budget/SKILL.md
    1  core/skills/shared/continuous-learning/SKILL.md
    1  core/skills/shared/continuous-learning/evals/cases.yaml
    1  core/skills/shared/coolify/SKILL.md
    1  core/skills/shared/cost-tracking/SKILL.md
    1  core/skills/shared/cpp/SKILL.md
    1  core/skills/shared/cpp/evals/README.md
    1  core/skills/shared/csharp-dotnet/SKILL.md
    1  core/skills/shared/data-cleaning/SKILL.md
    1  core/skills/shared/data-scraper/SKILL.md
    1  core/skills/shared/db-migrations/SKILL.md
    3  core/skills/shared/debug/SKILL.md
    2  core/skills/shared/debug/evals/README.md
    1  core/skills/shared/debug/evals/cases.yaml
    1  core/skills/shared/decision-challenge/SKILL.md
    1  core/skills/shared/decision-records/SKILL.md
    1  core/skills/shared/deep-learning/SKILL.md
    1  core/skills/shared/deployment/SKILL.md
    1  core/skills/shared/deprecation/SKILL.md
    1  core/skills/shared/design/SKILL.md
    1  core/skills/shared/digitalocean/SKILL.md
    1  core/skills/shared/django/SKILL.md
    1  core/skills/shared/docker/SKILL.md
    1  core/skills/shared/domains-dns/SKILL.md
    1  core/skills/shared/drizzle-orm/SKILL.md
    1  core/skills/shared/duckdb/SKILL.md
    1  core/skills/shared/dynamodb/SKILL.md
    1  core/skills/shared/e2e-testing/SKILL.md
    1  core/skills/shared/electron/SKILL.md
    1  core/skills/shared/elixir/SKILL.md
    1  core/skills/shared/email-deliverability/SKILL.md
    1  core/skills/shared/embeddings-search/SKILL.md
    1  core/skills/shared/error-handling/SKILL.md
    1  core/skills/shared/expo/SKILL.md
    1  core/skills/shared/fal/SKILL.md
    1  core/skills/shared/fastapi/SKILL.md
    1  core/skills/shared/finetuning/SKILL.md
    1  core/skills/shared/firebase/SKILL.md
    1  core/skills/shared/flutter/SKILL.md
    1  core/skills/shared/fly-io/SKILL.md
    6  core/skills/shared/ftd/SKILL.md
    1  core/skills/shared/game-design/SKILL.md
    1  core/skills/shared/game-storytelling/SKILL.md
    1  core/skills/shared/gamedev-multiplayer/SKILL.md
    1  core/skills/shared/gamedev-pathing/SKILL.md
    1  core/skills/shared/gamedev-physics/SKILL.md
    1  core/skills/shared/gamedev-physics/evals/README.md
    1  core/skills/shared/gamedev-shaders/SKILL.md
    1  core/skills/shared/gamedev-shaders/evals/README.md
    1  core/skills/shared/gamedev-shipping/SKILL.md
    1  core/skills/shared/gcp-essentials/SKILL.md
    1  core/skills/shared/git-workflow/SKILL.md
    2  core/skills/shared/git-workflow/references/gitmoji.md
    1  core/skills/shared/github-actions/SKILL.md
    1  core/skills/shared/go/SKILL.md
    1  core/skills/shared/godot/SKILL.md
    1  core/skills/shared/godot/evals/README.md
    7  core/skills/shared/harness/SKILL.md
    2  core/skills/shared/harness/examples/audit-example.md
    1  core/skills/shared/harness/references/providers.yaml
    2  core/skills/shared/harness/references/wiki-article-template.md
    3  core/skills/shared/harness/references/wiki-protocol.md
    1  core/skills/shared/harness/references/wiki-worklog-template.md
    1  core/skills/shared/hetzner/SKILL.md
    1  core/skills/shared/htmx/SKILL.md
    1  core/skills/shared/huggingface/SKILL.md
    1  core/skills/shared/idea-refinement/SKILL.md
    6  core/skills/shared/implement/SKILL.md
    2  core/skills/shared/implement/scripts/sdd-workspace
   16  core/skills/shared/init/SKILL.md
    3  core/skills/shared/init/evals/README.md
    5  core/skills/shared/init/evals/cases.yaml
    1  core/skills/shared/init/references/accompaniment-and-profile.md
   16  core/skills/shared/init/references/recommend-skills.md
    1  core/skills/shared/java/SKILL.md
    1  core/skills/shared/knowledge-ops/SKILL.md
    1  core/skills/shared/kotlin-android/SKILL.md
    1  core/skills/shared/laravel/SKILL.md
    1  core/skills/shared/level-design/SKILL.md
    1  core/skills/shared/llm-pipeline/SKILL.md
    1  core/skills/shared/machine-learning/SKILL.md
    1  core/skills/shared/modal/SKILL.md
    1  core/skills/shared/mongodb/SKILL.md
    1  core/skills/shared/monitoring/SKILL.md
    1  core/skills/shared/mysql/SKILL.md
    2  core/skills/shared/neon/SKILL.md
    1  core/skills/shared/nestjs/SKILL.md
    1  core/skills/shared/netlify/SKILL.md
    6  core/skills/shared/nextjs/SKILL.md
    2  core/skills/shared/nextjs/evals/cases.yaml
    3  core/skills/shared/nextjs/references/data-and-caching.md
    4  core/skills/shared/nextjs/references/react.md
    3  core/skills/shared/nextjs/references/testing.md
    1  core/skills/shared/nlp/SKILL.md
    1  core/skills/shared/no-code-app/SKILL.md
    1  core/skills/shared/nodejs/SKILL.md
    1  core/skills/shared/observability/SKILL.md
    1  core/skills/shared/ollama/SKILL.md
    1  core/skills/shared/open-weights/SKILL.md
    1  core/skills/shared/orient/SKILL.md
    1  core/skills/shared/orient/evals/cases.yaml
    1  core/skills/shared/orient/references/orientation-contract.md
    3  core/skills/shared/parallel/SKILL.md
    2  core/skills/shared/performance/SKILL.md
    1  core/skills/shared/performance/evals/cases.yaml
    1  core/skills/shared/phoenix/SKILL.md
    1  core/skills/shared/php/SKILL.md
    1  core/skills/shared/plan/SKILL.md
    2  core/skills/shared/plan/evals/README.md
    1  core/skills/shared/planetscale/SKILL.md
    1  core/skills/shared/postgresdb/SKILL.md
    1  core/skills/shared/prisma-orm/SKILL.md
    1  core/skills/shared/prompt-engineering/SKILL.md
    1  core/skills/shared/python/SKILL.md
    1  core/skills/shared/rag/SKILL.md
    1  core/skills/shared/rails/SKILL.md
    1  core/skills/shared/railway/SKILL.md
    1  core/skills/shared/react-native/SKILL.md
    2  core/skills/shared/react-native/scripts/verify.sh
    4  core/skills/shared/react/SKILL.md
    1  core/skills/shared/react/evals/cases.yaml
    1  core/skills/shared/redis/SKILL.md
    1  core/skills/shared/render/SKILL.md
    1  core/skills/shared/replicate/SKILL.md
    1  core/skills/shared/research-ops/SKILL.md
    1  core/skills/shared/research-ops/evals/README.md
   12  core/skills/shared/review/SKILL.md
    1  core/skills/shared/ruby/SKILL.md
    1  core/skills/shared/runpod/SKILL.md
    1  core/skills/shared/rust/SKILL.md
    1  core/skills/shared/scaling/SKILL.md
   13  core/skills/shared/sdd-init/SKILL.md
    1  core/skills/shared/sdd-init/evals/cases.yaml
    9  core/skills/shared/sdd/SKILL.md
    2  core/skills/shared/sdd/evals/README.md
    2  core/skills/shared/sdd/evals/cases.yaml
    2  core/skills/shared/sdd/references/model-routing.md
    1  core/skills/shared/secure-coding/SKILL.md
    1  core/skills/shared/security-scan/SKILL.md
   12  core/skills/shared/ship/SKILL.md
    1  core/skills/shared/shopify/SKILL.md
    1  core/skills/shared/shopify/evals/cases.yaml
    1  core/skills/shared/simplify-code/SKILL.md
    5  core/skills/shared/skill-scout/SKILL.md
    2  core/skills/shared/solid-js/SKILL.md
    1  core/skills/shared/solid-js/evals/cases.yaml
    1  core/skills/shared/source-grounded-development/SKILL.md
    3  core/skills/shared/specify/SKILL.md
    2  core/skills/shared/specify/evals/README.md
    1  core/skills/shared/specify/evals/cases.yaml
    1  core/skills/shared/spreadsheet-ops/SKILL.md
    1  core/skills/shared/spring-boot/SKILL.md
    1  core/skills/shared/sql/SKILL.md
    1  core/skills/shared/sqlite-turso/SKILL.md
    1  core/skills/shared/structured-extraction/SKILL.md
   21  core/skills/shared/suggest/SKILL.md
    3  core/skills/shared/suggest/evals/README.md
   12  core/skills/shared/suggest/evals/cases.yaml
    2  core/skills/shared/supabase/SKILL.md
    3  core/skills/shared/svelte/SKILL.md
    1  core/skills/shared/svelte/evals/cases.yaml
    1  core/skills/shared/swift-ios/SKILL.md
    1  core/skills/shared/tasks/SKILL.md
    1  core/skills/shared/tasks/evals/README.md
    1  core/skills/shared/tauri/SKILL.md
    1  core/skills/shared/technical-writing/SKILL.md
    1  core/skills/shared/testing-go/SKILL.md
    1  core/skills/shared/testing-py/SKILL.md
    1  core/skills/shared/testing-web/SKILL.md
    1  core/skills/shared/together-fireworks/SKILL.md
    1  core/skills/shared/training-data/SKILL.md
    3  core/skills/shared/translation-l10n/SKILL.md
    1  core/skills/shared/translation-l10n/evals/README.md
    1  core/skills/shared/typescript/SKILL.md
    1  core/skills/shared/ui-engineering/SKILL.md
    1  core/skills/shared/unity/SKILL.md
    1  core/skills/shared/unreal/SKILL.md
    1  core/skills/shared/unreal/evals/README.md
    1  core/skills/shared/unslop/SKILL.md
    1  core/skills/shared/unsloth/SKILL.md
    1  core/skills/shared/variant-explorer/SKILL.md
    1  core/skills/shared/vector-db/SKILL.md
    2  core/skills/shared/vercel/SKILL.md
    3  core/skills/shared/verify/SKILL.md
    2  core/skills/shared/verify/evals/README.md
    1  core/skills/shared/verify/evals/cases.yaml
    1  core/skills/shared/vllm/SKILL.md
    4  core/skills/shared/vue-nuxt/SKILL.md
    1  core/skills/shared/vue-nuxt/evals/README.md
    2  core/skills/shared/vue-nuxt/evals/cases.yaml
    1  core/skills/shared/webhooks/SKILL.md
    1  core/skills/shared/wordpress/SKILL.md
    9  core/skills/shared/worktrees/SKILL.md
    2  core/skills/shared/worktrees/evals/README.md
    4  manifest.yaml
    1  rules/skill-quality/skill-migration-brief.md
    4  rules/skill-quality/skill-rubric.md
```

### Clasificacion por cubo (T0.3)

Heuristica por linea, en orden de prioridad; una linea cuenta en un solo cubo:

| Cubo | Lineas | Criterio aplicado |
|---|---|---|
| `paridad-directa` | 8 | `ai-hub sync/doctor/repair/list/worktrees reap` |
| `adaptacion-firma` | 35 | `ai-hub add/worktrees/main status/onboard` |
| `purga` | 29 | verbos inexistentes: sello, ingest, audit, consult, reassess, catalog, registry, capabilities, isolation, review consolidate |
| `vocabulario/ruta` | 409 | origen, marca, `ai-hub Spec-Kit`, `.ai-hub*`, rutas `01-TOOLS`/`02-DOCS`, prosa |

Subtotales verificados dentro del inventario:

| Patron | Coincidencias |
|---|---|
| `origin: ai-hub` | 179 |
| `ai-hub` | 69 |
| `.ai-hub` / `.ai-hubrc.json` / `.ai-hub/` | 45 |
| `ai-hub Spec-Kit` / `ai-hub Spec-Kit` | 36 |
| `ai-hub voice` | 9 |
| `ai-hub skill` | 22 |

### Licencia upstream (T0.4)

Verificada el 2026-10-25 con `curl.exe -L --max-time 20 https://raw.githubusercontent.com/dsalazardev/ai-hub/main/LICENSE`.
Resultado: **MIT License**, `Copyright (c) 2026 Daner Alejandro Salazar Colorado`. Texto MIT completo recibido (1067 bytes).

### `origin` en el motor (T0.5)

`git grep -n "origin" -- core/src` devuelve solo dos lineas, ambas en
`core/src/harness/guards/adapters/context.ts:133-134` y ambas sobre `refs/remotes/origin`:
ningun codigo lee el campo `origin` del frontmatter.

### Hallazgo de recuento (desviacion del contrato)

El plan afirma 178 `SKILL.md` con `origin: ai-hub`. El arbol real tiene **191** `SKILL.md`:
**171** con `origin: ai-hub`, **20** sin campo `origin` (17 `speckit-*` + `gitlab-auth`,
`gitlab-workflow`, `planning-with-files`). Las **178** del plan son ocurrencias del string
`origin: ai-hub` bajo `core/skills` (171 frontmatter + 7 referencias en `author-skill`), no
archivos. T3.1 reemplaza las 171 que existen; T3.2 alinea las 7 referencias, dando 178
ocurrencias de `origin: ai-hub`. No se inventa `origin` en las 20 skills que no lo declaran.

### Hashes de zonas inmutables (T0.1 de `tasks.md`)

```text
sha256  path
E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  openspec/changes/archive/.gitkeep
D216FD9D98BADCAF762E25D6014F5DEA5DD12B24FDBC36C7BB3230AA7016F19A  openspec/changes/archive/2026-10-24-add-agents-md/.openspec.yaml
CA209AE35EE5D8491544400CD722AA6812B3CE28F295E3E42D497F8682E65BBE  openspec/changes/archive/2026-10-24-add-agents-md/design.md
85055EEA343E6D1D59F8032B2304BAD6D67307CA0A9164FAF3D05EA2B0751D53  openspec/changes/archive/2026-10-24-add-agents-md/proposal.md
F41509F6261D4C54EBEE085EBB8D2E0E61078BC565137638D6463745EDCA8A00  openspec/changes/archive/2026-10-24-add-agents-md/tasks.md
E2EBAEBEE255CCC1E09B64BA38D9B09C360A7392FC110A48CA2525E1EA49FA46  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/.openspec.yaml
F1503247CEF8E73F780EB3EE085F62598794291048495642EC9336725AB5D388  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/design.md
A06D41AEA83CF8A48B91159A082CE6EF7A3C41F3500EADC8792F771E360D53A1  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/proposal.md
562D56D4E08C8C34C0B40853523F1550D070D6117575FC9F40FEC6E9E1820856  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/README.md
0CDA750F03D7D758C1092DA198D5E68134D28928BB3FB88952EF432F0A5C97A6  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/specs/agent-guardrails/spec.md
CA7F69001EC7636C3E67CC344F399C936ACFE77018F871729CBB065A57CCFB6C  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/specs/dev-cli/spec.md
EE0797FB55B7262CD3717AEA2E6326815BCB7C49B4EAB8A3EE1E28A68AB22CFB  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/specs/harness-memory/spec.md
03C2A216628BE162357CD1CA4617B71BEF20FA47D36CAF6DF22084990352BE8C  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/specs/preset-system/spec.md
28DAD64980B1F6642BE14383C78C67DE9B9BBD5B08A7ABEC1B7FE5E201064FA3  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/specs/spec-kit-pipeline/spec.md
5989C7936A802C697268BFD7DB0E1A8B749CD20D990E840D69527F5AAF8E3B18  openspec/changes/archive/2026-10-24-generalize-ai-hub-engine/tasks.md
E2EBAEBEE255CCC1E09B64BA38D9B09C360A7392FC110A48CA2525E1EA49FA46  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/.openspec.yaml
04546C0A97C7D9F2F93424835B013AD1214BC7B16E7AF08FD2D69B5AC996E351  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/design.md
889CBC099CEDD9F0C08DB0D1AA81BCE2C0DE22DE9F5AB2A074AD7234ED6792B0  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/proposal.md
E6A9B2F571245C4FD42AC8D9B1BEA0AA39376AF3EAD6FD6DD3DB2F4B096C4C56  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/specs/agent-guardrails/spec.md
BF3DFC142D656B0494072EF873465259963D9533597C7E67A9417D22779A2312  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/specs/dev-cli/spec.md
C032016889D933B2960C829344A39C179E3A0063D6A66E6ED6E15115BA78416B  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/specs/spec-kit-pipeline/spec.md
F75A783B867F5047E3334DB0A8DA1BAADC108B22C8473D2190DBD81DE2C587AF  openspec/changes/archive/2026-10-24-replica-ai-hub-engine/tasks.md
E5F348AA4CF999483958DA0096CECA5765927F5F20DEAD4AF42931461BCF79A1  .planning/memory.jsonl
F91552E40ED673EDDACBF8D5BA2855EE35425182009FF83AD55E0A5EEAB2B0FD  .planning/history.md
```

Total de archivos inmutables hasheados: 24.

## Cierre sanitize-ai-hub-residuals (T6 y T7, 2026-10-25)

### Metadatos de origen (T6.4, invariante revisado)

| Metrica | Valor |
|---|---|
| Skills publicadas en `manifest.yaml` | 174 |
| Publicadas con `origin: ai-hub` | 174 |
| Publicadas sin `origin` | 0 |
| `origin: ai-hub` en `core/skills` | 0 |
| `speckit-*` no publicadas (sin `origin`, por diseno) | 17 |

Desviacion del plan: el contrato decia 171 frontmatters / 178 ocurrencias. El arbol real publica
174 skills (se sumaron `gitlab-auth`, `gitlab-workflow` y `planning-with-files`), asi que el gate
verifica "todas las publicadas" contra `manifest.yaml` en vez de un numero fijo. Es mas estricto y
no queda obsoleto al crecer el catalogo.

### Gate `core/tests/brand.test.ts` (T6)

Seis pruebas: marca en contenido, marca en nombres de archivo, verbos contra `COMMAND_NAMES`
(importado de `../src/cli/run.js`, con `help`/`version` permitidos), aridad de `ai-hub add`,
`origin: ai-hub` por skill publicada y autoprueba (incluye `npx ai-hub add x` y confirma
que `NOTICE.md` no se escanea).

Demostracion en rojo, con sondas temporales retiradas despues:

- `npx ai-hub add x` -> falla "keeps every published source free of third-party brand residue".
- `ai-hub sello freeze` -> falla "documents only commands the CLI implements" nombrando la ruta.
- Arbol limpio -> 6/6 en verde.

### Barrido de prosa (hallazgo no previsto)

La validacion literal de todo `ai-hub <palabra>` encontro 30 usos del nombre como adjetivo
(`ai-hub voice`, `ai-hub catalog`, `ai-hub ships`, `ai-hub preflight`, `ai-hub front door`...). No
eran comandos, pero se reformularon igualmente ("the voice of ai-hub", "the ai-hub CLI ships",
"the preflight danger guard of ai-hub") para que el gate no necesite listas blancas. Tambien se
corrigio el tag `02-docs` de `knowledge-ops/SKILL.md`, ultimo residuo del namespace anterior.

### Linea base de fin de linea

`author-skill/references/skill-conventions.md` y `skill-scout/references/install-commands.md`
quedaron en LF puro tras la reescritura; se normalizaron a CRLF (720 archivos del arbol ya lo
eran). Sin BOM en ambos.

### Verificacion (T7)

| Comando | Resultado |
|---|---|
| `npm run manifest:build` | exit 0 |
| `npm run build` | exit 0 |
| `npm run manifest:check` | exit 0, "manifest.json actualizado" |
| `npm run ai:test` | exit 0, 150 passed / 1 skipped |
| `ai-hub doctor` | exit 0, "Resultado: sano" |
| `npm run ai:typecheck` | exit 0 |

Barridos:

- `git grep -n -i -E "\brsc\b|dsalazardev|ai-hub" -- core/skills rules README.md AGENTS.md manifest.yaml package.json core/package.json` -> 0 (exit 1).
- `git grep -n "ai-hub Spec-Kit\|ai-hub Spec-Kit\|@dsalazardev" -- . ...exclusiones...` -> 0 (exit 1).
- Hashes de T0.1: los 24 archivos inmutables conservan su SHA-256 (7 verificados en el archivo de
  `replica-ai-hub-engine`; `openspec/` y `.planning/memory.jsonl` sin cambios en `git status`).

### Decisiones de cierre

1. `.planning/history.md` NO se modifica: REQ-06 lo declara inmutable, el encargo lo prohibe y su
   hash (F91552E4...) forma parte del conjunto de T0.1 que T7.6 verifica.
2. T7.8 queda abierto: hash calculado, publicacion con `iid` imposible (remoto GitHub, sin issue).
3. Aviso para el revisor: cuando `core/tests/brand.test.ts` entre al indice, el `git grep` de
   `ai-hub Spec-Kit|ai-hub Spec-Kit|@dsalazardev` lo encontrara, porque el fixture de autoprueba contiene el literal
   por diseno. La solucion correcta es excluir `core/tests/**` en ese barrido, no ofuscar el
   fixture ni debilitar el gate.

### SHA-256 del conjunto aprobable (T7.8)

```text
939A6559422804CCDE9A1D42AC0E7417222D1598366E166EF77DCAD2BDF0C81F
```

Rutas ordenadas: `.specify/assessments/sanitize-ai-hub-residuals/design.md`, `spec.md`, `tasks.md`;
LF, sin BOM, `ruta + \n + bytes` por archivo.

## 2026-10-26 - install-completo implementado

- 26/26 tareas completadas; `openspec instructions apply` reporta `all_done`.
- Suite final: 3 corridas verdes (77,8 / 73,0 / 72,1 s; 187 tests + 1 skip).
- Modos verificados: full 4.662, preset-only 120, custom con `rule:skill-quality` 4.642, angular full 4.677, motor 4.665.
- Tarball: 1.296 entradas y las 4 r?bricas `rules/skill-quality/*.md`.
- Medici?n full: 5.767 archivos, 46.402.682 B, 21,5 s cold / 6,2 s warm; el presupuesto de 60 s pasa.
- CI local: build 5,4 s + manifest 1,3 s + suite 73,0 s + smoke 35,6 s = 115,3 s; timeout 30 min.
- `doctor` verde en motor y en instalaciones full/preset/custom; `drift` y `sync --check-lock` verdes en los tres consumidores.

## 2026-10-26 - install-completo archivado

- Sincronizados 13 requisitos nuevos y 2 modificados en `openspec/specs/`.
- Cambio movido a `openspec/changes/archive/2026-10-26-install-completo/`.
- `openspec validate --specs` y `--all`: 5 specs, 0 fallos (2 warnings preexistentes de longitud).
- `openspec list --json`: sin cambios activos.

## 2026-10-26 — speckit-integration: ruta de la constitución en el diagrama de Lucid

- Fuente en conflicto: diagrama Lucid "AI-HUB" (id 939ef9b0-8a9c-425e-8a1a-7529e9232550, v15872) nombra `.specify/constitution.md`.
- Verificado: Spec Kit 1.2.3 escribe la constitución en `.specify/memory/constitution.md` (instantánea `core/tests/fixtures/speckit-1.2.3/dot.specify/memory/`).
- Resolución por precedencia (AGENTS.md §1): `AGENTS.md` §3 y la regla `ai-hub-speckit` usan `.specify/memory/constitution.md`. El diagrama queda pendiente de corrección por su autor; no se resuelve en silencio.

## 2026-10-28 — shell-resolution: sonda manual 4.1 (resolución de shell en Windows)

Máquina: Windows con `bash` del PATH apuntando al lanzador de WSL sin distribución (`C:\Users\USUARIO\AppData\Local\Microsoft\WindowsApps\bash.exe`, falla con `execvpe`) y Git for Windows en `C:\Program Files\Git\bin\bash.exe`.

Consumidor temporal: `C:\Users\USUARIO\AppData\Local\Temp\opencode\ai-shell-probe` (sólo `package.json`), comando `node core/dist/bin/ai-hub.js init --dry-run`.

| Momento | `environment.shell` | `environment.shellCommand` |
|---|---|---|
| ANTES (dist 0.3.0 sin candidatos) | `missing` | `bash` |
| DESPUÉS (dist reconstruido con `shellCandidates` + `gitBashCandidates`) | `found` | `C:\Program Files\Git\bin\bash.exe` |

El probe probó `bash` del PATH (falla) y resolvió la primera ruta estándar de Git for Windows; `exit=0` en ambas corridas. Evidencia de las sondas rojas de los lotes 1-3 en `.planning/impl_shell.md`.

## 2026-10-28 — shell-resolution archivado

- Sincronizados 2 requisitos modificados (preflight con comandos probados y bandera exacta; doctor con doce checks y `speckit:script`) y 2 añadidos (`Spec Kit shell resolution is autonomous`, `Script type is selectable at init and install`) en `openspec/specs/dev-cli/spec.md`.
- Cambio movido a `openspec/changes/archive/2026-10-28-shell-resolution/`.
- `openspec validate --specs` y `--all`: 5 specs + 1 cambio, 0 fallos (warnings preexistentes de longitud de descripción).
- `openspec list --json`: sin cambios activos.
- Release 0.3.1 sigue sin publicar y sin commit; pendiente de revisión humana del diff.
