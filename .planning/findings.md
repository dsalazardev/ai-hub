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

---

## Sonda manual del cambio speckit-latest (6.2)

Ejecutada el 2026-10-29 sobre un consumidor temporal nuevo: `C:\Users\USUARIO\AppData\Local\Temp\opencode\scratch\speckit-latest-probe\consumer-final` (git init + package.json con typescript; `node core/dist/bin/ai-hub.js init --yes` con dist 0.4.0).

| Comprobación | Resultado |
|---|---|
| `init --yes` | exit 0; `Spec Kit 1.2.5 · script sh · integraciones claude, opencode, pi, cursor-agent`; plan `360a24c2…` |
| `.specify/scripts/bash` | 6 archivos |
| `.specify/scripts/powershell` | 6 archivos |
| `.specify/scripts/python` | 6 archivos |
| Manifiesto de integridad | 24 entradas (18 de scripts) |
| `init-options.json` | `speckit_version: 1.2.5` · `script: sh` |
| `doctor` | exit 0; `speckit:version: 1.2.5 dentro del rango >=1.2.3 <1.3.0` en [OK]; los 12 checks `speckit:*` en verde |

La versión resuelta por el sondeo real (uvx, red) fue **1.2.5**, dentro del rango soportado. El plan impreso informa la resuelta, no el rango (design D5).

## Hallazgo — skills no publicadas en core/skills/shared (2026-10-29, sesion refuter-panel propose)

`git status` muestra ~100 directorios nuevos NO rastreados en `core/skills/shared/` (ads, ai-media, analytics, ..., zapier) que no estan en `skills.publish` del `manifest.yaml` (que sigue sin cambios vs HEAD). El `doctor` del taller por eso falla `skills:` y `completeness:` ("skills.publish incompleto: faltan ads, ..."). No es causado por refuter-panel (solo escribio en `openspec/` y `.planning/`); a las 11:15, tras archivar speckit-latest, el doctor estaba sano. No se tocaron ni se publicaron: es trabajo en curso del usuario. `openspec validate refuter-panel --strict` esta en verde y no depende de ese estado. Pendiente: decision humana (publicarlas en un cambio propio, moverlas fuera del arbol o descartarlas); la fase apply de refuter-panel debera correr con ese estado resuelto porque brand.test escanea `core/skills` completo (incluye las no publicadas) y catalog/doctor exigen coherencia fuente/publicacion.

## Sondas rojas de partida — cambio catalogo-completo (2026-10-29, apply)

**Sonda 1a — doctor del taller (exit 1):** `[FAIL] skills:` nombra las 98 huérfanas
(ads -> core/skills/shared, ai-media, analytics, article-writing, automation-strategy,
bookkeeping, brand-identity, brand-voice, ..., youtube-thumbnails, zapier) y
`[FAIL] completeness: skills.publish incompleto: faltan ads, ... zapier` (las mismas 98).
Resto de checks en [OK]. Es el estado que catalogo-completo arregla.

**Sonda 1b — brand.test (2 fallidos / 2 pasados, exit 1):**
- FAIL `brand gate > keeps every published source free of third-party brand residue`
  (muestra: `core/skills/shared/brand-identity/SKILL.md:125` con `com.risco.contrast`;
  también `ads/SKILL.md:146` con `npx @ericrisco/rsc copy check`).
- FAIL `brand gate > marks every published skill with origin: ai-hub` (el catálogo ya no
  cumple el origin viejo: 107 SKILL.md dicen `dsalazardev`).
- Pasados: los 2 tests de NOTICE.md.

**Censo (tarea 1.2, script fm-check.js):** untracked: 98, con problemas de frontmatter: 0.
Orígenes en los 272 SKILL.md: `ai-hub` 165 / `dsalazardev` 107 / `risco` 0.

**Desviación observada:** el doctor muestra además `[FAIL] context: contexto desactualizado;
ejecuta ai-hub context` — no es causado por las 98 ni por este change (drift preexistente del
taller). Se aborda en la verificación final (6.1) para dejar el doctor sano.

**Sonda 2 — gate cerrado (tras publicar las 98 SIN tocar brand.test):** `npx vitest run
tests/brand.test.ts` sigue en rojo: 2 fallidos / 2 pasados (exit 1). Mismos dos tests:
`keeps every published source free of third-party brand residue` y `marks every published
skill with origin: ai-hub`. Prueba que el gate estaba cerrado antes del cambio de marca;
recién tras el cambio de origen (grupo 3) pasa a verde.

**Sonda 3 — invariante de vocabulario (tras 4.4, gate extendido):** con una línea
`02-DOCS/wiki/index.md` inyectada en `core/skills/shared/ab-testing/SKILL.md`, brand.test falla
nominando el archivo y la línea: `core/skills/shared/ab-testing/SKILL.md:161: Sonda: leer
02-DOCS/wiki/index.md antes de empezar.` (1 failed / 3 passed). Archivo restaurado byte a byte.
Las variantes rsc/risco quedan cubiertas por la autoprueba del patrón (test 4) y por las sondas
1-2, que cazaron residuo real. Tras la reescritura completa: brand.test 4/4 en verde.

**Residuo extra cazado por el gate extendido (10 líneas, corregidas en el mismo cambio):** el
patrón ampliado con `origin:\s*ai-hub\b` y `02-DOCS` (case-insensitive) encontró lo que el patrón
viejo no veía: author-skill enseñaba `origin: ai-hub` en 7 líneas (SKILL.md, evals, references),
knowledge-ops tenía el tag `02-docs` en minúsculas, y las reglas universales skill-quality
llevaban 2 referencias (`origin: ai-hub` en skill-rubric.md:26 y la spec
`02-DOCS/wiki/sdd/specs/generalization-gate.md` en skill-harden-rubric.md:61 — el gate también
barre `rules/`). Todo reescrito al vocabulario del motor.

## 2026-10-30 — script-choice: el init py de specify-cli 1.2.5 envía un compañero powershell

- **Conflicto de fuentes (sonda e2e 7.3b):** el escenario "A single-type set installs one
  directory" del delta decía que `--scripts py` deja `.specify/scripts/` con **sólo** `python`
  (6 archivos, manifiesto de 6). La sonda real (uvx, specify-cli 1.2.5) muestra que el
  `specify init --script py` crea `python` **y también** `powershell` (6+6 en el manifiesto de
  integridad). Sondeo directo: `--script ps` → sólo powershell; `--script sh` → sólo bash;
  `--script py` → python + powershell. El escenario estaba calibrado sobre el fake
  (modelo sin compañero), no sobre la realidad medida.
- **Resolución (AGENTS.md §1, nivel 3 sobre el artefacto del propio change):** el delta se
  corrigió en la misma sesión — el requisito exige un init por miembro del conjunto y jamás
  uno fuera del conjunto (el contrato de AI-Hub, verificado por el fake); un escenario nuevo
  "specify-cli's own companion is not a set member" documenta el compañero como carga propia
  de specify que el instalador no añade, invoca ni borra. El fake queda como modelo de un
  specify sin compañero (simplificación documentada). `openspec validate script-choice
  --strict` en verde. No se resuelve en silencio: constancia en `.planning/impl_script-choice.md`
  §7.3.
- **Dato para el futuro:** si specify-cli retira el compañero en una versión futura del rango,
  el escenario del compañero queda como hecho medido de 1.2.5, no como contrato.

## 2026-11-08 — factory-evolution: conflictos normativos registrados antes de aplicar

- **Conflicto PD-1 frente a spec vigente:** el paso opt-in del tracker (la TUI pregunta URL y
  token y escribe `.ai-hub/.env` solo si el usuario acepta) contradice el requisito vigente
  `interactive-onboarding` → "The assistant verifies tools without touching credentials"
  ("MUST NEVER ask for, store, or touch API keys"). **Resolución:** instrucción explícita del
  propietario (AGENTS.md §1, nivel 1) sobre la spec (nivel 5 descriptivo / contrato de
  capability). Se aplica como `## MODIFIED` en
  `openspec/changes/factory-evolution/specs/interactive-onboarding/spec.md`: la prohibición se
  mantiene salvo el paso opt-in, saltable, solo con TTY, enmascarado, que escribe únicamente
  `.ai-hub/.env` (ya ignorado). Ningún agente pide tokens.
- **Errata 1 del texto de partida:** D2 decía `GITLAB_TOKEN=CHANGE`; se usa `CHANGEME`,
  coherente con PD-1 ("valores CHANGEME").
- **Errata 2 del texto de partida:** C1 decía `.aiai-hub/lessons.md`; se trata como
  `.ai-hub/lessons.md`.

## 2026-11-08 — Spec Kit fuera del rango soportado (upstream-watch, Lote F)

- Evidencia: `node scripts/upstream-watch.mjs` → `Spec Kit: última v1.3.2 · rango soportado >=1.2.3 <1.3.0 · FUERA DEL RANGO` (exit 1).
- Impacto: las instalaciones siguen resolviendo la última 1.2.x; 1.3.x no está verificada.
- Decisión pendiente del propietario: abrir un change para ampliar `speckit.supported` tras probar 1.3.x. No se toca en factory-evolution.

## 2026-11-09 — Falso positivo del filtro de secretos de `runs` (hermes-control, fase 1)

- Evidencia: `ai-hub runs event --from-status "AI-HUB-STATUS: CONVERGED | artifact=specs/001-recurring-invoices/tasks.md | reason=-"` → `"artifact" parece contener un secreto; no se registra`.
- Impacto: una feature con nombre largo no puede registrar su estado. Pendiente de decisión del propietario (fuera de hermes-control).

## 2026-11-10 — Instalación real de 0.14.0 en Windows: paso de control del `init`

Recorrido verificado de punta a punta en `C:\Users\USUARIO\OneDrive\Escritorio\prueba`
(PowerShell 5.1, Windows 11, Hermes 0.23.0, npm 12.1.0). Sirve como base del capítulo de
instalación de la documentación.

Orden real de los pasos del asistente, con lo que pide cada uno:

1. clientes destino (los cinco por defecto);
2. preset detectado (`generic-ts`);
3. catálogo (`full`);
4. tipos de script de Spec Kit (`Python, Shell, PowerShell`) y el activo (`Shell`);
5. avisos por cliente detectado/ausente (Claude, OpenCode, Cursor, Pi, Copilot);
6. entorno de Spec Kit (`uvx`, caché, `bash`, `specify-cli 1.2.6`);
7. **idea del proyecto** (multilínea; `.` o Ctrl+D terminan; vacío salta);
8. confirmación del plan (imprime el JSON con `destinations 6872`, `files 8521`, `hash`);
9. tracker de GitLab (opcional; escribe `.ai-hub/.env`);
10. plano de control (opcional; solo si detecta Hermes ≥ 0.23);
11. resumen.

Hallazgos del paso de control, todos reproducidos en vivo:

- **H-1 — un solo mensaje para tres causas distintas.** `onboard-step.ts:135-139` imprime
  «El bot no ve ese canal: invítalo al servidor…» tanto para `not-visible` (403/404 de
  `GET /channels/{id}`) como para `no-match` (nombre sin coincidencia). En la prueba el bot
  **sí estaba invitado y veía el servidor**; el mensaje apuntó a la causa equivocada y
  provocó un bucle de reintentos.
- **H-2 — nombre de canal sensible a mayúsculas.** `onboard.ts:89` compara
  `data.name === value`. Discord normaliza los nombres de canal a minúsculas, así que
  `SALAZAR` nunca coincide con `salazar`. Debería comparar normalizado.
- **H-3 — ids de otra entidad entran por la rama numérica.** Un id de servidor y un id de
  bot cumplen `MIN_ID` (`^[0-9]{17,20}$`) y se consultan como canal, con 404 idéntico al de
  «sin permisos». Falta validar `type === 0` y distinguir el origen del id.
- **H-4 — no hay forma de listar canales.** Diagnosticar exige `GET /users/@me/guilds` y
  `GET /guilds/{id}/channels` a mano. Un `control channels` (o mostrar los canales
  visibles al fallar) habría resuelto el caso en un paso.
- **H-5 — la colisión de token se detecta al final.** `control: ese token es el bot del
  perfil "default"; hermes-control necesita su propio bot (no se escribió nada)` aparece
  después de teclear token, canal, aprobador, TTL y expiración. Debe comprobarse antes de
  pedir nada.
- **H-6 — `hermes` fuera del PATH de PowerShell.** El binario vive en
  `%LOCALAPPDATA%\hermes\hermes-agent\.hermes\bin`; en bash está en el PATH, en PowerShell
  no. Por eso el `init` anterior no ofreció el paso de control: `isHermesAvailable` no lo
  vio. Un aviso («Hermes instalado pero no en el PATH») evitaría la confusión.

- **H-7 — 403 no distingue «el bot no está en ningún servidor» de «sin permisos en ese canal».**
  Con el segundo bot (`Leos S. Kennedy`) `GET /channels/{id}` devolvió 403 mientras
  `GET /users/@me/guilds` devolvía `[]`. El mensaje del arnés era correcto pero genérico;
  leer los guilds primero permitiría decir la causa exacta («el bot no está en ningún
  servidor») y ahorrar el bucle.

- **H-8 — `enroll` crea el webhook antes de habilitar la plataforma, y oculta el motivo.** En una
  instalación nueva, `hermes -p hermes-control webhook subscribe …` sale 1 con
  «Webhook platform is not enabled»; `enroll.ts:174-185` descarta stdout/stderr y solo
  propaga «`hermes webhook subscribe falló (exit 1)`». El perfil, los scripts y el `.env`
  ya estaban escritos, así que la instalación queda a medias sin decirlo. Falta habilitar
  `platforms.webhook` (o `WEBHOOK_ENABLED`/`WEBHOOK_PORT`/`WEBHOOK_SECRET` en el `.env`
  del perfil) antes del `subscribe`, o al menos relanzar el mensaje de Hermes.

Datos del entorno que confirman la nomenclatura de Discord (el usuario confundió servidor,
bot y canal):

| Entidad | id | nombre |
|---|---|---|
| Servidor | `1569195743065940018` | `control` |
| Bot | `1569189115428343818` | `Bills-builder` |
| Canal de texto | `1569195743657467977` | `general` |
| Canal de voz | `1569195743657467978` | `General` |

Un servidor recién creado solo trae `#general`: no existe ningún canal `control` ni
`salazar`. La documentación debe decir explícitamente que el canal hay que crearlo o usar
`general`, y que el id se copia del **canal**, con *Modo desarrollador* activo.

Riesgo operativo detectado: el token del bot se pegó en el chat durante el diagnóstico
(expuesto). Debe rotarse con *Reset Token* y actualizarse solo en el `.env` del perfil.

## Revisión de la propuesta `init-fiabilidad` — 2026-11-11

- En `bae6ac7`, `openspec validate init-fiabilidad --strict` salió 0. `openspec list` mostró `init-fiabilidad` en 0/50 y `ci-verde` en 16/17. Se contaron 35 deltas y 106 escenarios. Los archivos de la propuesta existen localmente y están ignorados por Git.
- `design.md:78` prevé una línea fuera del JSON en `init --dry-run`. El consumidor actual del CLI analiza todo `stdout` como JSON (`core/tests/cli.test.ts:125`). El diseño debe fijar un canal de salida que conserve ese contrato.
- `design.md:84` promete recuperar con `control enroll --yes`, pero `design.md:329` deja `SOUL.md` sin marcas pendiente sin TTY y el perfil completo exige una identidad gestionada. Definir y probar una recuperación para el archivo que genera Hermes en perfiles nuevos y parciales.
- `design.md:76` y `:93-94` presentan `--dir` como prioridad, pero exigen salir con 2 si difiere de `AI_HUB_DIR`. `AGENTS.md` §6 pone `AI_HUB_DIR` primero en la resolución vigente. Explicitar si se conserva la regla de conflicto o si `init` tendrá una excepción para la ruta explícita, y alinear el diseño y los escenarios.
- `design.md:420-431` describe WIP 1 como política del consumidor y fija el cierre de `ci-verde` antes de aplicar como secuencia de la propuesta. Mantener explícita esa diferencia. La tarea 4.1 sigue abierta localmente y pide el log del job Linux; esta revisión no verificó ese job.

### Segunda revisión de `init-fiabilidad`

- La validación estricta pasó. El change tiene 42 deltas, 134 escenarios y 62 tareas pendientes. Los contratos de `--dry-run`, los destinos explícitos y la migración de `IDEA.md` quedaron precisados.
- `design.md:180-183` sitúa la identidad antes de guardar las credenciales y `manifest.control`. La recuperación de `design.md:388-389` propone solo `control enroll --yes` si se interrumpe esa etapa. Falta una ruta para retomar el paso con los datos aún sin guardar. La tarea 8.10 debe partir del estado exacto de cada interrupción, sin completar el estado del fixture a mano.
- `tasks.md:209-215` usa webhook deshabilitado para provocar un fallo, pero el escenario `Platform disabled` de `specs/hermes-control/spec.md` exige habilitarlo con consentimiento. Fijar un fallo controlado tras el preflight y retirarlo antes del reintento.
- `ci-verde` sigue en 16/17. No se obtuvo evidencia del job Linux para `bae6ac7`.

### Tercera revisión de `init-fiabilidad`

- La validación estricta pasó. Se verificaron 44 deltas, 142 escenarios y 65 tareas pendientes. La matriz de recuperación distingue cuándo retomar `init` y cuándo basta `control enroll --yes`. Las tareas 9.9 y 9.10 separan la habilitación automática del fallo inyectado en `webhook subscribe`.
- La tarea 9.10 necesita un perfil de prueba sin la ruta objetivo. Si reutiliza el perfil que dejó la tarea 9.9, el enrolamiento conserva la ruta existente y no ejecuta `subscribe`, por lo que el envoltorio no puede provocar el fallo.
- El punto de guardado en `design.md:400` y HC-12 comprueba presencia del token y del bloque de control. El check también exige coherencia de canal y aprobadores. Una configuración previa puede dejar ambos presentes y desalineados tras una reconfiguración interrumpida. Conviene cubrir ese estado en la acción de recuperación y alinear el diagrama de `design.md:337-339` con la matriz.
- `ci-verde` sigue en 16/17 según `openspec list`. La tercera revisión no verificó el job Linux.

## 2026-11-11 — Deuda heredada registrada por `init-fiabilidad` (tarea 1.1)

- `openspec/specs/hermes-control/spec.md:206` › «The harness works without Hermes»: «every existing command MUST
  keep its 0.11.0 output and exit code». El texto ya era inexacto antes de `init-fiabilidad`: idea-input
  (0.14.0) cambió la salida de `init`, y `init-fiabilidad` añade la ruta absoluta, `IDEA.md` y las líneas
  `ai-hub-integration:`. `init-fiabilidad` no lo modifica (`design.md` §14); su equivalente en
  `control-onboarding` sí se reescribe (CO-M3). Pendiente de un change que actualice o retire la promesa de
  «0.11.0 output».

## 2026-11-11 — Revisión de la implementación de `init-fiabilidad`

- `npm --prefix core run typecheck` y la validación estricta del change pasaron. Se ejecutaron 33 pruebas de recuperación, check, webhook e identidad en cuatro archivos y todas pasaron. `openspec list` confirmó 58/65 en `init-fiabilidad` y 16/17 en `ci-verde`.
- P1, recuperación desalineada: con un consumidor temporal y Hermes simulado, un canal distinto entre el perfil y el manifiesto produjo check 1 y acción `control enroll --yes`. Ese comando devolvió 0 y el segundo check volvió a salir 1 con el canal desalineado. `core/src/control/enroll.ts:205-229` propone enrolar para datos que ese comando no reescribe. `core/src/control/onboard.ts:465` también clasifica la conexión por presencia y no por coherencia.
- P2, redacción incompleta: una ejecución sintética con `RunResult.status=null` y un centinela conocido en `error` confirmó que `redactedCause` lo conserva en su salida. `core/src/control/redact.ts:39-42` redacta stdout y stderr, pero interpola `error` directamente. Revisar también la emisión de mensajes crudos en el aislador.
- P2, puerto publicado: el mismo consumidor temporal, con `WEBHOOK_PORT=9000`, recibió una URL para GitLab con el puerto 8644. `core/src/control/enroll.ts:507` usa un puerto fijo aunque el preflight conserva el existente.
