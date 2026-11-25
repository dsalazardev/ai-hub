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

## 2026-11-13 — `fabrica-verificable` 1.1: captura de solo lectura del Hermes real

- Autorizada por el propietario; tres comandos de lectura, sin escribir nada. Salidas con secretos redactados (no apareció ninguno).
- `hermes -p hermes-control gateway status` → exit 1 · `Error: Profile 'hermes-control' does not exist. Create it with: hermes profile create hermes-control`.
- `hermes webhook list` → exit 1 · `Webhook platform is not enabled. To set it up:` seguido de la ayuda de tres opciones (`gateway setup`, bloque `platforms.webhook` en `config.yaml`, claves `WEBHOOK_*` en `.env`).
- `hermes -p hermes-control webhook list` → exit 1 · el mismo error de perfil inexistente.
- Lectura: el host ya no está en el estado de la prueba de 0.16.0 (el perfil `hermes-control` no existe y el perfil por defecto no tiene la plataforma habilitada), así que el disparador del falso `[FAIL]` del punto 1 sigue **sin medir**. La captura no lo confirma ni lo descarta.
- Dos hechos nuevos, sí medidos: (a) con el perfil inexistente, `gateway status` sale 1 con un texto que no contiene `not installed`; `gatewayTopology` lo clasificaría como `stopped`, y solo la guarda `profilePresent` de `--check` evita esa lectura; (b) la puerta del CLI de rutas responde exit 1 con la ayuda en stdout, igual que el doble (`WEBHOOK_SETUP_HINT`).
- Consecuencia para el diseño (D1): ninguna; `resolveListener` decide por la evidencia del dueño (bloque, store, `/health`) y trata `webhook list` como contraste.

## 2026-11-23 — `harden-harness-orchestration`: verificaciones de propuesta (sin ejecución)

- Base: `c11feda`, 0.17.0. Las once issues (#1–#11) coinciden byte a byte con las instantáneas `openspec/changes/harden-harness-orchestration/research/issues/*.json`; 0 comentarios; 92 criterios.
- Correcciones a la exploración: existen pruebas escritas del `decide` silencioso (`core/tests/control.test.ts:248`), de snapshots sin credenciales (`core/tests/env-contract.test.ts:101`) y de la guardia `ship:review-seal` (`core/tests/factory-f.test.ts:201`); la unicidad del escritor de telemetría aplica solo a `<run>/events.jsonl`.
- BT-1: no se encontró documentación de precondición atómica (`If-Match`) para `PUT /projects/:id/issues/:iid` en GitLab ni para etiquetas en GitHub. Pendiente de la tarea 1.1/1.2.
- BT-2: no se encontró evidencia de que Hermes pueda quitar terminal y lectura de archivos al modelo de un perfil. Pendiente de la tarea 1.3.
- BT-3: no se encontró un estado documentado de «gateway arrancando». Pendiente de la tarea 1.4.
- Hechos externos usados por el diseño (fuentes en `design.md`): reemplazo de etiquetas con ámbito en GitLab, `resource_label_events`, paginación `x-next-page`/`Link`, `draft` de PR en GitHub, reglas `permissions.deny` de Claude Code (no cubren `grep -r`), formatos de Codex (`.agents/skills`, `.codex/agents/*.toml`), `hermes cron pause|resume`.
- Instalación de scripts de Hermes con `writeIfMissing` (`core/src/control/enroll.ts:152`): las instalaciones existentes no reciben scripts nuevos (afecta a #10).

## 2026-11-23 — `harden-harness-orchestration`: revisión 4.1–4.12 (sin ejecución)

- Contradicciones corregidas: `ask` frente a `deny` en lecturas no verificables; concesión «verificada por el runner» sin autoridad; copias adyacentes de destinos ajenos con secretos (`config.yaml` de Hermes, `settings.json`, MCP); limpieza sin evidencia por método de merge; revisor de respaldo distinto del owner (#2-C4); `runs` v2 dependiente del runner; comportamiento por defecto sin CAS no definido; efectos de hooks de arranque; enlaces simbólicos del candidato; escritura sin transacción; reversión sin tipos; excepción «assumed operable».
- Verificado: cuerpos de #1–#11 iguales a las instantáneas; `git status` sin cambios en código; `openspec/specs/` no tocado.
- Sin verificar (tareas 1.1–1.11): precondiciones de GitLab y GitHub, identificación del owner, campos de evidencia de merge, aislamiento de Hermes, estado del gateway, comandos de estado de los harnesses y ACL en Windows.

## 2026-11-23 — `harden-harness-orchestration`: revisión técnica A–D (sin ejecución)

- Verificado por lectura de código en `c11feda`: `pruneRuns` poda por recuento y nombre sin leer versiones (`core/src/harness/runs.ts:149-177`); `scope` y `control` excluidos desde 0.12.0 (`64b24ab`); `readRunEvents` no comprueba `v` (`:132-146`); ledger en archivo fijo (`core/src/control/ledger.ts:11-12,84`); `purge` borra `.ai-hub/` (`core/src/cli/maintenance.ts:317-318`); `renameWithRetry` reintenta 5×100 ms sin recomprobar (`core/src/manifest/write.ts:13-31`); la frase del motivo llega al final de la línea (`core/src/speckit/status.ts:43`); el tick toma la última nota con línea válida y descarta las inválidas (`core/src/control/tick.ts:293-310`, `status.ts:73-85`).
- Documentación oficial consultada: `gitprotocol-pack` (old-id validado por el servidor), `git-push` (`--force-with-lease`, sin mención explícita a borrados), GitLab `DELETE /projects/:id/repository/branches/:branch` y GitHub `DELETE /repos/{owner}/{repo}/git/refs/{ref}` sin revisión esperada; auto-eliminación sin regla sobre commits nuevos.
- Contradicción corregida: la propuesta atribuía a binarios publicados la preservación de registros nuevos; D-52 queda corregida por D-57.
- Sin verificar: comportamiento real de los binarios publicados (3.22), borrado con lease en GitLab y GitHub (2.9, 2.10), enlaces duros por sistema de archivos (1.16).

## 2026-11-23 — `harden-harness-orchestration`: respuestas del propietario (sin ejecución)

- Escritores reales de etiquetas en 0.17.0: `core/src/control/apply.ts:150` (`applyReply`, `applyPreapproved`) y `:258` (`expireDecisions` con `block`); `tick`, `decide`, `ingest` y `doctor` solo leen.
- `.ai-hub/` es distinto en cada worktree: un lock en `.ai-hub/runs/` no coordina worktrees; los locks compartidos van al directorio de locks del usuario.
- No se identificó un mecanismo que evite pérdidas frente a editores externos con Node en ninguna plataforma (rename sin condición de contenido, locks POSIX cooperativos, sin modo de compartición exclusivo en Windows); de ahí la aplicación controlada (D-65), pendiente.
- `"v": { "const": 1 }` en `core/schema/runs.schema.json:10` describe la escritura de 0.17.0, no su lector ni su retención.

## 2026-11-23 — `harden-harness-orchestration`: revisión final (D-65, SC-01; sin ejecución)

- Escrituras actuales en configuración ajena:
  - `.gitignore` raíz con `writeFile` directo (`core/src/cli/onboarding.ts:736-747`);
  - región de `AGENTS.md` (`core/src/sync/render.ts:97`) y retirada de regiones (`core/src/sync/sync.ts:110-117`);
  - hooks en `.claude/settings.json`;
  - `platforms.webhook` del dueño (`core/src/control/enroll-webhook.ts:240`);
  - `mcp-manifest.yaml` en `adopt`, con comprobación previa seguida de `writeFile` (`core/src/adopt/convert.ts:139-141`).
- Documentación de git consultada:
  - el `.gitignore` más profundo prevalece y sus patrones son relativos a su carpeta (git-scm.com/docs/gitignore);
  - `git check-ignore -q` sale 0 si la ruta se ignora (git-scm.com/docs/git-check-ignore).
- La documentación de Claude Code no fue accesible (fallo de DNS): la alternativa del host queda en la tarea 1.17.

## 2026-11-23 — harden-harness-orchestration, hito 1 (aplicación)

### 1.10 ACL en Windows (local, directorio temporal del scratchpad)

- Comando: `icacls <dir> /inheritance:r /grant:r "<usuario>:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"`, y después `(Get-Acl <dir>).Access`, traduciendo `IdentityReference` a SID.
- Salida (SID redactados al formato):
  - `S-1-5-18 FullControl Allow inherited=False`
  - `S-1-5-21-…-1001 FullControl Allow inherited=False`
  - `protected=True`
- `%LOCALAPPDATA%` por defecto concede acceso solo a `S-1-5-18` (SYSTEM), `S-1-5-32-544` (Administradores) y al SID del usuario, todos heredados.
- Conclusión: la lista de acceso se puede leer por SID (independiente del idioma) con `Get-Acl`. «Solo el usuario y cuentas del sistema» = conjunto ⊆ {SID del usuario, S-1-5-18, S-1-5-32-544}. `icacls` es legible pero su salida depende del idioma; se usa `Get-Acl`.

### 1.14 Binarios publicados 0.12.0–0.17.0 (lectura de código por commit de release)

| Release (commit) | Poda `fs.rm` | Exclusión `scope`/`control` | Lector `JSON.parse` sin `v` | Ledger con archivo fijo | Poda desde el hook |
|---|---|---|---|---|---|
| 0.12.0 (`d78de6d`) | `runs.ts:175` | `:153` | `:140` | `ledger.ts:12` | `hook.ts:216` |
| 0.13.0 (`24434e5`) | igual | igual | igual | igual | igual |
| 0.14.0 (`d4e54b0`) | igual | igual | igual | igual | igual |
| 0.15.0 (`9bb8e96`) | igual | igual | igual | igual | igual |
| 0.16.0 (`6a961d2`) | igual | igual | igual | igual | igual |
| 0.17.0 (`c11feda`) | igual | igual | igual | igual | igual |

- **Leído:** las seis versiones podan por recuento y nombre, solo directorios. Las líneas con campos desconocidos se aceptan como objetos (no hay validación al leer). El ledger lee `decisions.jsonl` y no lista `control/`.
- **Pendiente de 3.22:** ejecutar los binarios reales.

### 1.11 Inventario de escritores directos (`core/src`, sin tests)

| Módulo:línea | Destino | Propiedad | Sensibilidad | Regenerable | Mecanismo actual |
|---|---|---|---|---|---|
| `cli/onboarding.ts:746` | `.gitignore` raíz | ajeno | interna | no | `writeFile` directo (D-65: dejar de editarlo si existe) |
| `sync/hooks.ts:116` | `.claude/settings.json` | ajeno | sensible | no | `writeFile` directo (D-65) |
| `sync/sync.ts:114`, `:134` | región de `AGENTS.md` y otros archivos con región | ajeno | interna | no | `writeFile` directo (D-65) |
| `sync/sync.ts:141`, `:119`, `:106` | destinos generados del lock; obsoletos; enlaces | generado | interna (MCP: sensible) | sí | `writeFile`, `rm`, `unlink` directos |
| `sync/lock.ts:67` | `sync.lock.json` | generado | interna | sí | directo |
| `control/webhook-config.ts:105-106` | `config.yaml` del dueño del listener | ajeno salvo perfil propio | sensible | no | temporal + rename |
| `control/webhook-config.ts:150` | copia `config.yaml.pre-ai-hub` **adyacente** | — | sensible | — | `copyFile` (viola la custodia por sensibilidad) |
| `control/identity.ts:108`, `:134-135` | copia numerada adyacente; `SOUL.md` del perfil | ajeno salvo perfil propio | interna | no | `wx`; temporal + rename |
| `control/profile-env.ts:26-27` | `.env` del perfil | propio (perfil creado) | sensible | no | temporal + rename, modo 600 |
| `control/enroll.ts:154` | scripts y archivos del perfil | propio | interna | sí | `wx` (no sobrescribe) |
| `control/ledger.ts:95` | `.ai-hub/runs/control/decisions.jsonl` | estado | interna | no | `appendFile` sin lock |
| `harness/runs.ts:129`, `:175` | telemetría | estado | interna | no | `appendFile`; poda `rm` |
| `cli/hook.ts:159` | `.ai-hub/runs/scope/*.json` | estado | interna | sí | directo |
| `cli/seal.ts:49` | `.ai-hub/runs/review-seal.json` | estado | interna | no | directo |
| `cli/trunk.ts:38` | estado de trunk | estado | interna | no | directo |
| `manifest/write.ts:21-41` | `manifest.yaml` | arnés (capa proyecto) | interna | no | temporal + rename con reintento |
| `paths.ts:85` | `.ai-hubrc.json` | arnés | interna | no | `writeFileSync` directo |
| `presets/materialize.ts:75,119,129,395,401` | `.ai-hub/` (preset y scaffold) | arnés | interna | sí | directo |
| `cli/assistant.ts:721` | `.ai-hub/.env` | ajeno (lo teclea la persona) | sensible | no | directo (R-117: tras `check-ignore`) |
| `cli/assistant.ts:460`, `:501`; `cli/idea.ts:413,439` | semilla e idea | proyecto | interna | no | directo; `wx` |
| `cli/githooks.ts:49` | `.git/hooks/post-merge` | ajeno | interna | no | `writeFile` directo |
| `ci/templates.ts:35` | `.github/workflows/*` | generado | interna | sí | directo |
| `adopt/convert.ts:99,140,195,212` | archivado; `mcp-manifest.yaml`; carpeta heredada; `.planning`→`.ai-hub/work` | proyecto | interna (MCP: sensible) | no | `rename`, comprobación previa + `writeFile`, `rm` |
| `backup/snapshots.ts:102,111,160,186` | `.backups/` | estado | depende del origen | — | `copyFile` y `writeFile` directos |
| `cli/context.ts:71`, `harness/memory/*`, `manifest/manifest.ts:392` | contexto, `.planning/`, `manifest.json` | taller | interna | — | directo |

**Hallazgos del inventario:**
- `webhook-config.ts:150` crea una copia adyacente de un archivo sensible. Contradice R-032 y queda para 3.7 y 3.11.
- `cli/githooks.ts:49` sobrescribe un archivo de `.git/hooks`. Es configuración ajena y no estaba en la tabla de D-65; se trata como tal en 3.25.

### Hito 1 documental (1.1–1.9, 1.15–1.17): informe con citas y URL

Fuente: investigación de solo lectura del 2026-11-23. Versiones instaladas: hermes v0.23.3, claude 2.1.330, opencode v2.3.2, git 2.56.1.windows.1, node v24.18.0. Codex no está instalado.

#### Hito 1: investigación documental (solo lectura)

Fecha de consulta: 2026-11-23. No se modificó el repositorio. Cada fila indica la fuente consultada. Si un dato no aparece en la documentación, se marca como "no documentado" y no se completa de memoria.

Leyenda de veredictos: **documentado** / **no documentado** / **no accesible**. "Solo en código fuente" significa que la conducta está en el código oficial, pero no en la documentación.

---

#### 1.1 GitLab: ¿escritura condicional en `PUT /projects/:id/issues/:iid`?

| Pregunta | Respuesta | Cita | URL | Veredicto |
|---|---|---|---|---|
| ¿Hay alguna precondición (If-Match, If-Unmodified-Since, ETag, version/lock_version) que rechace una escritura obsoleta? | **No.** La sección "Update an issue" no documenta ninguna precondición. `updated_at` es un valor que se asigna, no una comprobación. | `updated_at`: "When the issue was updated." / "Empty string or null values are not accepted." | https://docs.gitlab.com/api/issues/ (sin versión; la nota más reciente cita GitLab 19.6) | no documentado (no existe precondición) |
| Etiquetas | `add_labels`/`remove_labels` son deltas sin comprobación previa. | "Comma-separated label names to add to an issue." / "...to remove from an issue." / `labels`: "Set to an empty string to unassign all labels." | ídem | documentado |
| ¿ETag o peticiones condicionales en la REST general? | La página REST no menciona ETag, If-Match ni "conditional". ETag/If-None-Match aparece solo en la guía interna de polling (lecturas, 304) y en la Orbit API. | (página REST: sin coincidencias) | https://docs.gitlab.com/api/rest/ ; https://docs.gitlab.com/development/polling/ | no documentado para escrituras |

Consecuencia: en GitLab, la protección contra escrituras obsoletas tiene que hacerla el cliente (releer antes de escribir). No existe una operación CAS en el servidor.

#### 1.2 GitHub: ¿escritura condicional en etiquetas?

| Pregunta | Respuesta | Cita | URL | Veredicto |
|---|---|---|---|---|
| ¿If-Match o ETag en POST/PUT/PATCH/DELETE? | **No admitido.** | "Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported" (salvo que el endpoint indique otra cosa) | https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api | documentado (no admitido) |
| Endpoints de etiquetas | POST añade ("The labels to add to the issue's existing labels"), PUT reemplaza ("The labels you set replace any existing labels"), DELETE `/labels/{name}` quita una. Solo documentan la cabecera `accept`; no hay If-Match. | ídem | https://docs.github.com/en/rest/issues/labels (X-GitHub-Api-Version 2026-03-10) | documentado (sin precondición) |
| ¿Qué cabeceras condicionales existen? | Solo para lecturas: `etag`/`last-modified` en la respuesta, y `if-none-match`/`if-modified-since` en la petición. | "Most endpoints return an `etag` header, and many endpoints return a `last-modified` header." | best-practices (arriba) | documentado |

#### 1.3 Identificación de owners y bots

**GitLab**

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| Nivel Owner | "`40` (Maintainer), or `50` (Owner)" | https://docs.gitlab.com/api/project_members/ | documentado |
| Miembros heredados | `GET /projects/:id/members/all`: "Lists all project members viewable by the authenticated user, including inherited members, invited users, and permissions through ancestor groups." `GET /groups/:id/members/all`: "Lists all members of a specified group, including inherited members, invited users, and permissions through ancestor groups." Si un usuario aparece varias veces: "only their membership with the highest `access_level` is returned." | https://docs.gitlab.com/api/project_members/ ; https://docs.gitlab.com/api/group_members/ | documentado |
| ¿Filtro por access_level? | **No.** Parámetros: `query`, `user_ids`, `skip_users`, `show_seat_info` y `state` (`awaiting`/`active`, solo en `/all`). Hay que filtrar `access_level == 50` en el cliente. | project_members | documentado (no existe filtro) |
| ¿Campo bot en la respuesta de miembros? | **No.** Campos: `id`, `username`, `name`, `state`, `access_level`, `created_by`, `expires_at`, `email`, `group_saml_identity`, `is_using_seat`. | project_members / group_members | no documentado |
| Atributo `bot` en usuarios | `GET /users/:id` incluye `"bot": false` (no hay ejemplo con `true`). Filtros de `GET /users`: `humans` ("Filters only regular users that are not bot or internal users"), `exclude_humans`, `without_project_bots` ("Filters user without project bots"). `exclude_internal` **no** excluye bots de proyecto o grupo. | https://docs.gitlab.com/api/users/ | documentado (parcial) |
| Bots de tokens de acceso | Proyecto: username "`project_{project_id}_bot_{random_string}`", email `...@noreply.{host}`. Grupo: "`group_{group_id}_bot_{random_string}`". La página de tokens de proyecto no menciona un campo `bot`. | https://docs.gitlab.com/user/project/settings/project_access_tokens/ ; https://docs.gitlab.com/user/group/settings/group_access_tokens/ | documentado (por patrón de nombre) |
| Service accounts | "user accounts that represent non-human entities"; "always marked as external users"; el username se genera desde el nombre y se puede editar; los prefijos `service_account_`, `service_account_group_` y `service_account_project_` se aplican al **email** no-reply. No dice que sean bot users. | https://docs.gitlab.com/user/profile/service_accounts/ | documentado (sin flag bot) |

**GitHub**

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| `owner.type` (User/Organization) | La referencia solo dice "`type`: required, string", sin enum. | https://docs.github.com/en/rest/repos/repos#get-a-repository | no documentado (sin valores enumerados) |
| `type: "Bot"` | No aparece en las referencias de users, repos ni collaborators. "Bot" solo figura como tipo de actor en la API de Actions policies. | https://docs.github.com/en/rest/users/users ; /rest/collaborators/collaborators | no documentado en REST de users |
| Colaboradores admin | `GET /repos/{o}/{r}/collaborators?permission=admin&affiliation=direct|outside|all`. Objeto `permissions` {pull, triage, push, maintain, admin}. `role_name`: "the highest role assigned to the collaborator". `GET .../collaborators/{username}/permission`: "Checks the repository permission and role of a collaborator." | https://docs.github.com/en/rest/collaborators/collaborators | documentado |

#### 1.4 Evidencia de merge

**GitLab MR** (https://docs.gitlab.com/api/merge_requests/, sin versión)

| Campo | Cita | Veredicto |
|---|---|---|
| `sha` | "SHA of the head commit in the source branch." | documentado |
| `diff_refs.head_sha` | "SHA of the head commit in the source branch. The latest commit in the merge request." (`base_sha`: merge base; `start_sha`: "SHA of the target branch commit") | documentado |
| `merge_commit_sha` | "If set, the SHA of the merge request commit. Returns `null` until merged." | documentado |
| `squash_commit_sha` | "If set, the SHA of the squash commit. Empty until merged." | documentado |
| `squash` / `squash_on_merge` | `squash`: "If `true`, squash all commits into a single commit on merge." (si el proyecto obliga o prohíbe squash, "that setting takes precedence at merge time"). `squash_on_merge`: "Indicates whether to squash the merge request when merging." | documentado |
| `state` | "`opened`, `closed`, `merged`, or `locked`"; `merged_at`: "Timestamp of when the merge request merged." | documentado |
| Proyecto `merge_method` | "Merge method used for the project. Possible values: `merge`, `rebase_merge`, or `ff`." (https://docs.gitlab.com/api/projects/). `squash_option` se describe solo como "Squash option for merge requests."; los ejemplos muestran `default_on`/`default_off`. | documentado (los valores de squash_option no están enumerados) |

**GitHub PR** (https://docs.github.com/en/rest/pulls/pulls, API 2026-03-10)

| Campo | Cita | Veredicto |
|---|---|---|
| `merge_commit_sha` | merge: "represents the SHA of the merge commit"; squash: "represents the SHA of the squashed commit on the base branch"; rebase: "represents the commit that the base branch was updated to." | documentado |
| `merged`, `merged_by`, `head.sha` | Solo tipos: "`merged`: required, boolean"; `head.sha` "required, string". | documentado (sin descripción) |
| ¿Método de merge usado? | **No hay campo.** `auto_merge.merge_method` describe una configuración de auto-merge, no el método aplicado a un merge ya hecho. | no documentado |
| `PUT .../pulls/{n}/merge` | `sha`: "SHA that pull request head must match to allow merge." `merge_method`: `merge`/`squash`/`rebase`. 409: "Conflict if sha was provided and pull request head did not match". | documentado (CAS sobre el head al hacer merge) |

#### 1.5 GitLab: crear un MR en draft por API

| Pregunta | Respuesta | Cita | URL | Veredicto |
|---|---|---|---|---|
| ¿Existe un parámetro `draft` en Create/Update MR? | **No.** Create y Update no tienen parámetro `draft`; `draft` solo aparece en las respuestas (`"draft": false`) y como filtro de listado. | `work_in_progress`: "Deprecated. Use `draft` instead." | https://docs.gitlab.com/api/merge_requests/ | documentado (no existe) |
| ¿Cómo se marca? | Con un prefijo en el título. La página de la API no lo dice; lo dice la guía de usuario. | "Add `[Draft]`, `Draft:` or `(Draft)` to the beginning of the merge request's title." También existe la acción rápida `/draft` (y `/ready`), y commits que empiezan por `draft:`/`fixup!` ("This method is not a toggle"). | https://docs.gitlab.com/user/project/merge_requests/drafts/ | documentado (UI); por API se deduce `title: "Draft: ..."` |

#### 1.6 Hermes: aislamiento de herramientas por perfil

Fuente: la documentación oficial del proyecto, incluida en la instalación local (`C:\Users\USUARIO\AppData\Local\hermes\hermes-agent\website\docs`, Docusaurus con `url: https://hermes-agent.nousresearch.com`, `baseUrl: /docs/`). Corresponde a la versión instalada v0.23.3 (commit caafe538, 2026-11-19). Se verificó una página publicada (webhooks), que coincide.

| Pregunta | Respuesta / cita | Doc | Veredicto |
|---|---|---|---|
| ¿Configuración propia por perfil? | "A profile is a separate Hermes home directory. Each profile gets its own directory containing its own `config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron jobs, and state database." | /docs/user-guide/profiles | documentado |
| Herramientas por plataforma | "organized into logical **toolsets** that can be enabled or disabled per platform." `hermes tools` = "Configure enabled tools per platform" (UI interactiva; `--summary`). Desactivar desde CLI: "`hermes tools disable browser [--platform NAME]`". Se persiste en `platform_toolsets`. | /docs/user-guide/features/tools ; /docs/reference/cli-commands#hermes-tools ; /docs/user-guide/configuration | documentado |
| ¿Se puede desactivar terminal y lectura de archivos? | Sí. Los toolsets `terminal` (`process_manage`, `terminal`) y `file` (`patch`, `read_file`, `search_files`, `write_file`). Desactivación global con `agent.disabled_toolsets`: "a toolset listed here is always removed — even if a platform's saved config still lists it." Preset `safe`: "Read-only research + media generation. No file writes, no terminal, no code execution." | /docs/reference/toolsets-reference ; /docs/user-guide/configuration#global-toolset-disable | documentado |
| Por ruta de webhook | `toolsets` en la ruta "**replaces** the platform-level webhook toolset for runs triggered by this route only. Manual config edit only — not settable via `hermes webhook subscribe`". | /docs/user-guide/messaging/webhooks | documentado |
| MCP por perfil | `mcp_servers` vive en el `config.yaml` del perfil. Filtros `include`/`exclude` por servidor ("If `include` is set, only those server-native MCP tools are registered."). En `platform_toolsets.<platform>`: "a list that names servers gets only those, and `no_mcp` drops them all." En el multiplexor: "a served profile never calls a server as another profile". Tokens: "a named profile uses `~/.hermes/profiles/<name>/mcp-tokens/`". | /docs/reference/mcp-config-reference ; /docs/reference/toolsets-reference ; /docs/user-guide/multi-profile-gateways#what-is-isolated-per-profile | documentado |
| Aviso | "The agent has the same filesystem access as your user account. Use `hermes tools` to disable tools you don't want, or switch to Docker for sandboxing." | /docs/user-guide/configuration | documentado |

#### 1.7 Hermes: estado del gateway y `cron pause|resume`

| Pregunta | Respuesta / cita | Doc | Veredicto |
|---|---|---|---|
| Estado observable por CLI | `hermes gateway ensure [--json] [--timeout 60]` imprime un JSON con `state`, `reason_code` y `endpoint` (solo cuando está listo). Estados: "`ready`, `draining`, `starting`, `absent`, `inaccessible`, `incompatible` or `conflict`". Códigos de salida: 0 "Compatible session runtime ready", 2 invocación inválida, 3 incompatible, 4 autorización o perfil, 5 "Deadline reached; startup may still be pending", 6 draining/update, 7 inaccesible o fallo. **Ojo:** `ensure` "discovers or starts" el runtime (puede arrancarlo). `hermes gateway attach --json` sin `--start` "only discovers". `hermes gateway status` muestra el estado del servicio, sin JSON documentado. | /docs/reference/cli-commands#local-runtime-discovery-and-startup ; /docs/developer-guide/gateway-internals#hermes-gateway-ensure | documentado |
| Estado en archivo | `gateway_state.json` en el home del perfil (bajo el multiplexor, uno solo en el home default: "no per-profile gateway status file is written"). Valores citados: `gateway_state: degraded`, `gateway_state=stopped`, `startup_failed`, `running`. `updated_at` se reescribe cada 60 s como heartbeat; a partir de 120 s, `status` avisa "Gateway heartbeat stale". Las transiciones de telemetría son "`starting -> running -> draining -> stopped`, `startup_failed`". No hay un esquema formal del archivo. | /docs/user-guide/messaging (index) ; /docs/user-guide/multi-profile-gateways ; /docs/developer-guide/gateway-monitoring | documentado (parcial: sin esquema) |
| `hermes cron pause|resume` | `hermes cron <list|create|edit|pause|resume|run|remove|status|runs|incidents|doctor|tick>`. pause: "Pause a job without deleting it." resume: "Resume a paused job..." Aceptan nombre: "The mutating verbs (`pause`, `resume`, `run`, `cancel`, `remove`, `edit`) ... accept a job **name** (case-insensitive)"; si el nombre es ambiguo, se rechaza. Existe también `--paused` al crear y `hermes pause` global. | /docs/reference/cli-commands#hermes-cron ; /docs/user-guide/features/cron | documentado |
| Versión mínima de pause/resume | No figura en la documentación ni en una búsqueda de release notes. | — | no documentado |

#### 1.8 OpenAI Codex CLI

Nota: `developers.openai.com/codex/*` redirige (308) a `learn.chatgpt.com/docs/*`. Ninguna página muestra versión ni fecha. **Codex no está instalado en este equipo.**

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| Estado sin secretos | "`codex login status` exits with `0` when credentials are present"; muestra "the active authentication mode". No documenta otros códigos de salida. | https://learn.chatgpt.com/docs/developer-commands?surface=cli | documentado |
| `--sandbox`/`-s` | `read-only | workspace-write | danger-full-access` | ídem | documentado |
| `--ask-for-approval`/`-a` | `on-request | never` (en la página actual no aparecen `untrusted` ni `on-failure`) | ídem | documentado |
| Reanudar sesión | `codex resume [SESSION_ID]` (tipo "uuid \| session name"), `--last`, `--all`. `codex exec resume [SESSION_ID]`: "Resume an exec session by ID or add `--last`...". `codex exec --json`: "newline-delimited JSON events". No documenta dónde se muestra el id. | ídem | documentado |
| Hooks | Archivos `hooks.json`: `/etc/codex/hooks.json`, `$CODEX_HOME/hooks.json` y `.codex/hooks.json` (proyecto de confianza), o inline con `[hooks]` en `config.toml`. "Hooks are enabled by default" (`[features] hooks = false` los desactiva; `codex_hooks` es un alias obsoleto). Eventos: PreToolUse, PermissionRequest, PostToolUse, Pre/PostCompact, UserPromptSubmit, SubagentStart/Stop, SessionStart/End, Stop, Interrupt, Pre/PostModelRequest. El payload por stdin incluye `session_id`, `cwd`, `hook_event_name`, `model`, `tool_name`, `tool_use_id`, `tool_input` (`tool_input.command` para Bash y apply_patch). Para bloquear: `permissionDecision: "deny"`, o salir con código 2 y escribir el motivo en stderr. | https://learn.chatgpt.com/docs/hooks | documentado |
| Skills | "`.agents/skills` in every directory from your current working directory up to the repository root"; `$HOME/.agents/skills`; `/etc/codex/skills`. "The `SKILL.md` file must include `name` and `description`." No menciona `$CODEX_HOME/skills`. | https://learn.chatgpt.com/docs/build-skills | documentado |
| Agentes personalizados | "standalone TOML files under `~/.codex/agents/` ... or `.codex/agents/` for project-scoped agents"; obligatorios: `name`, `description`, `developer_instructions`. "`sandbox_mode`, `approval_policy`, `model_provider`, and `mcp_servers`, don't override the parent configuration". | https://learn.chatgpt.com/docs/agent-configuration/subagents.md | documentado |
| AGENTS.md | En el ámbito global, `AGENTS.override.md` y, si no existe, `AGENTS.md` en `~/.codex` (o `CODEX_HOME`). En el proyecto, desde la raíz hasta el cwd, en cada directorio: "`AGENTS.override.md`, then `AGENTS.md`, then any fallback names in `project_doc_fallback_filenames`". `project_doc_max_bytes` vale 32 KiB por defecto. | https://learn.chatgpt.com/docs/agent-configuration/agents-md | documentado |

#### 1.9 Claude Code y OpenCode

**Claude Code** (code.claude.com; las páginas no tienen fecha; las funciones indican su versión mínima)

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| Modo headless | `claude -p "query"`: "Query via SDK, then exit"; `--output-format` `text`/`json`/`stream-json`; `--session-id` (UUID); `-r "<session>"`; `--permission-mode` `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions` (`manual` es alias de default desde v2.1.200); `--setting-sources user,project,local`. | https://code.claude.com/docs/en/cli-reference | documentado |
| Comando de estado | `claude auth status`: "Show authentication status as JSON. Use `--text` for human-readable output. Exits with code 0 if logged in, 1 if not." `authMethod` ∈ `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`. `configDirectory` desde v2.1.268. También existe `claude doctor` (diagnóstico de solo lectura). | ídem | documentado |
| Payload de hooks | Campos comunes: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name`; en PreToolUse también `tool_name`, `tool_input`, `tool_use_id`. `tool_input` de **Read**: `file_path` ("Absolute path"), `offset`, `limit`. **Grep**: `pattern`, `path`, `glob`, `output_mode`, `-i`, `multiline`. **Glob**: `pattern`, `path` ("Defaults to current working directory"). Exit 2 en PreToolUse "Blocks the tool call" (stderr = motivo). | https://code.claude.com/docs/en/hooks.md | documentado |
| `permissions.deny` para Read | Patrones gitignore: `//path` = absoluto; `~/path` = home; `/path` = "Path relative to the settings source" (en `.claude/settings.json` y `settings.local.json` apunta al directorio de trabajo principal); `path` o `./path` = relativo al cwd. Ejemplos: `Read(./.env)`, `Read(./secrets/**)`. "Claude makes a best-effort attempt to apply `Read(path)` deny rules to all built-in tools that read files like Grep and Glob." Las reglas `Grep(path)`/`Glob(path)` **no** aplican; hay que usar `Read(...)`. Bash: se aplican a `cat`/`head`/`tail`/`sed`/`tee` y a las redirecciones, pero no a `grep -r pattern .` ni a scripts. Un deny de Read bloquea también Edit/Write sobre esa ruta (Write desde v2.1.228). | https://code.claude.com/docs/en/permissions | documentado |

**OpenCode** (instalado v2.3.2; las páginas no tienen fecha)

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| Ubicación de plugins | "loads direct `.ts` and `.js` files and immediate plugin package directories" de `.opencode/plugins/`; los globales van en `~/.config/opencode/plugins/`. | https://opencode.ai/docs/plugins/ | documentado |
| API V2 (actual) | `export default Plugin.define({ id, async setup(ctx) {...} })`. Hook de herramientas: `ctx.tool.hook("execute.before", (event) => {...})`, con `event.tool` y `event.input`; puede "inspect or replace tool input before execution". El callback devuelve `Promise<void> | void`. **No se documenta cómo bloquear desde el hook** (la única vía de rechazo documentada es `ctx.permission.assert`). `execute.after` recibe `status`, `result` y `error.message`. Eventos: `ctx.event.subscribe({ types, signal })`. | https://opencode.ai/docs/build/plugins/server | documentado (sin bloqueo) |
| Compatibilidad con V1 | Las claves `"tool.execute.before"` en `server()` son V1. "V2 reads the export's `id` and `setup()` ... and ignores `server()`"; "sharing an export does not translate V1 hooks into V2 hooks". El formato objeto de V1 está "supported in OpenCode `1.18.29`". **Riesgo:** un plugin solo-V1 (como `.opencode/plugins/ai-hub.js`, si usa la forma V1) no se ejecutaría en v2.3.2. Hay que verificarlo en código. | ídem | documentado |
| Aviso no bloqueante | Servidor: no hay API de toast ni de aviso (los ejemplos usan `console.log`). TUI plugin: `context.ui.toast.show({ title, message, variant, duration })` y `context.attention.notify(...)`. `client.app.log` y `tui.toast.show` (V1) no aparecen en las páginas actuales. | https://opencode.ai/docs/build/plugins/cli ; /build/plugins/server | documentado (solo TUI) |

#### 1.15 Git: lease en borrados y `update-ref -d`

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| Semántica de `--force-with-lease=<ref>:<expect>` | "will protect <refname> (alone), if it is going to be updated, by requiring its current value to be the same as the specified value <expect>... If <expect> is the empty string, then the named ref must not already exist." Las demás formas "are still experimental". | https://git-scm.com/docs/git-push ("last updated in 2.55.0"; sin cambios hasta 2.56.1) | documentado |
| ¿El lease aplica a `:<ref>` (borrado)? | La documentación no lo dice. El código sí: en `remote.c::set_ref_status_for_push()`, el bloque `if (ref->expect_old_sha1) { if (!oideq(&ref->old_oid, &ref->old_oid_expect)) reject_reason = REF_STATUS_REJECT_STALE;` no depende de `ref->deletion`; solo la regla de fast-forward excluye los borrados (`!ref->deletion`). | https://raw.githubusercontent.com/git/git/master/remote.c | no documentado; sí en código fuente |
| Salida porcelain | "<flag> \t <from>:<to> \t <summary> (<reason>)"; flags: espacio = fast-forward, `+` forzado, `-` "successfully deleted ref", `*` nuevo, `!` "rejected or failed to push", `=` sin cambios. La documentación no incluye "stale info". En código (`transport.c`): `case REF_STATUS_REJECT_STALE: print_ref_status('!', "[rejected]", ..., "stale info", ...)`, es decir, la línea es `!\t<from>:<to>\t[rejected] (stale info)`. | git-push ; https://raw.githubusercontent.com/git/git/master/transport.c | formato documentado; "stale info" solo en código |
| `git update-ref -d <ref> [<old-oid>]` | "With `-d`, it deletes the named <ref> after verifying that it still contains <old-oid>." Para `--stdin delete`: "If given, <old-oid> may not be zero." Atomicidad: "If all <ref>s can be locked with matching <old-oid>s simultaneously, all modifications are performed. Otherwise, no modifications are performed." | https://git-scm.com/docs/git-update-ref ("last updated in 2.53.0") | documentado |
| Versión mínima | En las RelNotes 1.8.5: "\"git push\" learned a more fine grained control over a blunt \"--force\" ... with the \"--force-with-lease=<refname>:<expected object name>\" option." | https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/1.8.5.adoc | documentado (1.8.5) |

#### 1.16 Hard links y renombrar sobre un archivo abierto

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| Node `fs.link` | "Creates a new link from the `existingPath` to the `newPath`. See the POSIX link(2) documentation". No hay notas sobre Windows. | https://nodejs.org/api/fs.html (v26.13.1) | documentado (sin notas de Windows) |
| Node `fs.rename` | "In the case that `newPath` already exists, it will be overwritten. If there is a directory at `newPath`, an error will be raised instead." Node no documenta EPERM/EBUSY en Windows para rename/link; solo `fs.rm` reintenta con EBUSY/EPERM. | ídem | no documentado (Windows) |
| Hard links en Windows | CreateHardLink: "This function is only supported on the NTFS file system, and only for files, not directories."; "all hard links to a file must be on the same volume"; máximo 1023 enlaces. ReFS: "No" (tabla de Windows 8/2012). **No se documenta qué código de error devuelve FAT/exFAT.** | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinka (updated 2025-07-01) ; https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions (2025-07-08) | documentado (solo NTFS); código de error no documentado |
| Renombrar sobre un archivo abierto (Windows) | MoveFileEx `MOVEFILE_REPLACE_EXISTING`: "replaces its contents ... provided that security requirements regarding access control lists (ACLs) are met". No menciona el caso de un destino abierto. CreateFile `FILE_SHARE_DELETE`: "Otherwise, other processes cannot open the file or device if they request delete access... **Note** Delete access allows both delete and rename operations."; un conflicto produce `ERROR_SHARING_VIOLATION`. La correspondencia con EPERM/EBUSY de Node no está documentada. | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa ; https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea | parcialmente documentado (se deduce de las reglas de compartición) |
| Linux, rename sobre un archivo abierto | "If newpath already exists, it will be atomically replaced"; "Open file descriptors for oldpath are also unaffected". EBUSY se describe para directorios en uso; EXDEV, entre sistemas de archivos distintos. | https://man7.org/linux/man-pages/man2/rename.2.html | documentado |

#### 1.17 Origen de hooks y plugins en Claude Code; webhook en Hermes

| Pregunta | Respuesta / cita | URL | Veredicto |
|---|---|---|---|
| ¿De dónde salen los hooks? | Tabla "Hook locations": `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy, "Plugin `hooks/hooks.json` — When plugin is enabled", frontmatter de skill y frontmatter de subagente. "When a plugin is enabled, its hooks merge with your user and project hooks." `allowManagedHooksOnly` bloquea los hooks de usuario, proyecto, local y plugin; `disableAllHooks: true`. | https://code.claude.com/docs/en/hooks | documentado |
| ¿Habilitar un plugin requiere settings? | Sí: el ámbito de instalación escribe `enabledPlugins` en user `~/.claude/settings.json`, project `.claude/settings.json` o local `.claude/settings.local.json`. En el ámbito de proyecto, cada colaborador ejecuta "`claude plugin install <name>@<marketplace> --scope project` once per clone". Un marketplace añadido desde la shell queda "declared in your user settings even when you pass `--scope project`". `extraKnownMarketplaces` (y `permissions.allow`) "apply only after each teammate trusts the folder". | https://code.claude.com/docs/en/discover-plugins.md ; https://code.claude.com/docs/en/settings.md | documentado |
| ¿Claude Code escribe sus settings? | Sí: "It writes `~/.claude/settings.json` when you save a user setting" y "writes `.claude/settings.local.json` when you give a standing approval" (en la raíz del repositorio; en Windows "the file stays with `.claude/settings.json` instead"). `/config` guarda la mayoría de opciones en `~/.claude/settings.json` y el output style en `.claude/settings.local.json`. Desinstalar un plugin del proyecto escribe `false` en `settings.local.json` o lo quita de `.claude/settings.json`. Además añade `**/.claude/settings.local.json` a los excludes globales de git. "Claude Code watches your settings files and reloads them" (incluidos los hooks). | https://code.claude.com/docs/en/settings.md ; discover-plugins.md | documentado |
| Hermes: ¿hay un comando para activar `platforms.webhook`? | No hay uno específico. La documentación de webhooks ofrece `hermes gateway setup` (asistente) o `WEBHOOK_ENABLED=true` en `.env`: "Enable via `hermes gateway setup` or environment variables". Los ajustes del adaptador pueden ir "directly under `platforms.webhook:`" o bajo `extra:`. El genérico `hermes config set <key> <value>` está documentado ("Dotted paths go to `config.yaml`; every `UPPER_SNAKE` name ... goes to `.env`"), pero ninguna página muestra `config set platforms.webhook.enabled`. Por lo tanto, `hermes config set platforms.webhook.enabled true` es una deducción, no un ejemplo documentado (puede producir el aviso de "did-you-mean" si la clave no está sembrada). | /docs/user-guide/messaging/webhooks (publicada y verificada) ; /docs/reference/cli-commands#hermes-config | comando específico no documentado; `config set` genérico documentado |

---

#### Versiones instaladas (solo `--version`)

| Herramienta | Versión |
|---|---|
| hermes | Hermes Agent v0.23.3 (2026.9.24) · stable · local caafe5389ae5 (instalado con git en `C:\Users\USUARIO\AppData\Local\hermes\hermes-agent`) |
| codex | **no instalado** (`command not found`) |
| claude | 2.1.330 (Claude Code) |
| opencode | v2.3.2 |
| git | 2.56.1.windows.1 |
| node | v24.18.0 |

#### Hallazgos con impacto (resumen)

1. Ni GitLab ni GitHub admiten escrituras condicionales en etiquetas. La protección CAS tiene que hacerla el cliente con releer-comparar-escribir; queda una ventana de carrera.
2. GitHub no indica el método de merge en el PR. GitLab sí lo expone a nivel de proyecto (`merge_method`) y por MR (`squash`, `squash_commit_sha`).
3. GitLab no tiene un parámetro `draft` en la API; se marca con el prefijo `Draft:` en el título.
4. OpenCode v2.3.2 ignora los hooks V1 (`server()` / `tool.execute.before`), y la API V2 de servidor no documenta ni bloqueo ni toast.
5. El lease de `git push` aplica a los borrados según el código fuente, no según la documentación. "stale info" aparece solo en `transport.c`.
6. `hermes gateway ensure` puede arrancar el runtime. Para observar sin efectos secundarios, usar `hermes gateway attach --json` sin `--start`, `hermes gateway status` o leer `gateway_state.json`.
7. Hermes no documenta la versión mínima de `cron pause|resume`, y Microsoft no documenta el código de error de hard link en FAT.

**Hallazgo material (OpenCode):**
- OpenCode v2.3.2 (API V2) ignora `server()`, así que los hooks V1 `tool.execute.before` no se ejecutan.
- La plantilla del motor usa la forma V1 (`core/engine/templates/opencode-plugin.js:40`). Con esa versión, las guardias no son efectivas en OpenCode.
- La API V2 no documenta cómo bloquear desde un hook.
- Afecta a #5 en OpenCode y a 4.34. Hasta tener evidencia, `doctor` debe tratar la cobertura de OpenCode ≥2 como no verificada.

### 1.12 Informe de viabilidad de los bloqueos (consolida 1.1–1.11 y 1.14–1.17)

| Bloqueo | Evidencia documental | Veredicto | Habilita / detiene |
|---|---|---|---|
| BT-1 GitLab | `PUT /issues/:iid` sin precondición documentada; `updated_at` asigna, no compara (1.1) | **necesita experimento**, sin expectativa favorable: solo valdría un rechazo estable no documentado (protocolo BT-1); alternativa: exclusión efectiva de escritores por permisos | 2.1 → 5.1; mientras tanto, retención (4.19) |
| BT-1 GitHub | «Conditional requests for unsafe methods … are not supported» (1.2) | **no viable** con la API documentada; 2.2 solo confirmaría la ausencia | 5.20 detenida; retención permanente salvo exclusión de escritores |
| BT-2 Hermes v0.23.3 | toolsets desactivables por plataforma y globalmente (`terminal`, `file`), MCP filtrable por perfil (1.6) | **necesita experimento** (2.3) con expectativa razonable | 5.3–5.5, 6.1 |
| BT-3 Hermes v0.23.3 | `gateway_state.json` con `state` y latido; `hermes gateway status`; `ensure --json` puede arrancar el runtime y no se usa para observar (1.7) | **necesita experimento** (2.4), estado documentado disponible | 5.2 |
| Cron de Hermes | `hermes cron pause|resume <id|name>` documentado; versión mínima no documentada (1.7) | **necesita experimento** (2.5) para fijar versión | 4.25, 4.24 |
| F0 Claude Code 2.1.330 | `claude -p`, `claude auth status` con JSON y salida 0/1, payloads de Read/Grep/Glob (1.9) | **necesita experimento** (2.6) | 5.6+ para Claude |
| F0 OpenCode 2.3.2 | API de plugins V2: hooks V1 no se ejecutan; bloqueo desde hook no documentado (1.9) | **no viable** como harness ni para guardias hasta verificar la API V2; además afecta al plugin actual | 5.6+ para OpenCode; hallazgo material |
| F0 Codex | documentado (1.8), **no instalado en este host** | **no viable en este host** hasta instalarlo (autorización aparte) | 5.6+, 5.18 para Codex; 4.78–4.81 (proyección) no dependen del binario |
| Borrado condicional GitLab/GitHub | lease aplicado a borrados en el código de git (`remote.c`), `stale info` solo en `transport.c`; APIs REST sin revisión esperada (1.15) | **necesita experimento** por tracker (2.9, 2.10) | 5.19 |
| Captura por enlace duro | CreateHardLink solo NTFS y mismo volumen; FAT/exFAT sin código documentado (1.16) | viable en NTFS/ext4/APFS; **`external_guard_reduced`** en el resto | 3.23 |
| Hooks de Claude sin `settings.json` | plugins con `hooks/hooks.json`, pero activarlos escribe `enabledPlugins` en un archivo de settings; Claude Code escribe sus propios settings (1.17) | **no evita editar configuración ajena** → alternativa 2 de D-65 descartada para Claude; queda la propuesta | 3.25 |
| Webhook de Hermes sin editar `config.yaml` | sin comando específico documentado; `config set` genérico (1.17) | **no documentado** → propuesta (D-65) | 4.89 |
| Compatibilidad 0.12.0–0.17.0 | código idéntico en las seis versiones (1.14) | lectura confirmada; ejecución real pendiente | 3.22 |

### Hallazgos de la aplicación (2026-11-23, rama `codex/harden-harness-orchestration`)

- **OpenCode 2.3.2 (material, sin corregir):**
  - el plugin generado usa hooks V1 (`tool.execute.before`, `core/engine/templates/opencode-plugin.js:40`), que la API V2 ignora;
  - las guardias y la política de lectura no son efectivas en OpenCode ≥2 hasta reescribir el plugin contra la API V2, que no documenta cómo bloquear desde un hook;
  - afecta a #5 en OpenCode y a 4.34.
- **Windows (corregido):** `powershell.exe` 5.1 lanzado desde pwsh 7 no carga el módulo de `Get-Acl` (por el `PSModulePath` heredado). La ACL del almacenamiento privado se lee con la API .NET y el proceso hijo no hereda `PSModulePath`.
- **Custodia (corregido en parte):**
  - la habilitación del webhook en un dueño compartido ya no hace la copia adyacente `config.yaml.pre-ai-hub` (D-65 propone en lugar de escribir);
  - **pendiente:** la migración de claves heredadas del `.env` del perfil de control sigue dejando `.env.pre-ai-hub` junto al archivo (sensible); queda para 3.11 y 3.7.
- **Tracker (corregido):** seguir `Link: rel="next"` habría enviado el token a otro origen; ahora se rechaza (`incomplete`).
- **Lectura del tablero:** `control tick` no recibe el `fetch` inyectado de la CLI de control (usa `defaultTrackerFetch`); las pruebas lo ejercitan con `runTick(…, { trackerFetch })`.
- **Retención:** con R-110, un directorio de run sin evento legible ya no se poda (antes, por nombre). La prueba 4.6 se adaptó.

### Corrección del hallazgo de OpenCode (2026-11-23, continuación)

- **Era incorrecto** que el plugin generado fuera solo V1. `core/engine/templates/opencode-plugin.js` ya exporta la forma 2.x (`export default { id: 'ai-hub', setup(ctx) }` con `ctx.tool.hook('execute.before', …)`) además de la 1.x. No se trata de un fallo de carga.
- **Error real de API (corregido):** en 2.x la entrada de la herramienta llega en `event.input` (opencode.ai/docs/build/plugins/server), y la plantilla solo leía `args`. El preflight recibía `{}` y nunca denegaba nada en OpenCode 2.x. Ahora lee `input.input`.
- **Límite real del host (declarado):** OpenCode 2.x documenta `execute.before` para inspeccionar o reemplazar la entrada, no para bloquearla. Que lanzar un error bloquee la herramienta no está documentado, y verificarlo exigiría ejecutar OpenCode real con sesión de modelo (no autorizado). `doctor` lo muestra como `opencode_block_unverified` y no lo presenta como protección.
- **Instalación:** el binario está en `@opencode/cli/bin/opencode.exe` (nativo); no hay código JS legible para comprobar el manejo de errores.

### 3.22 Compatibilidad con binarios publicados y candidato (2026-11-23, ejecución aislada)

Entorno: directorio temporal del scratchpad, `HERMES_HOME`, `LOCALAPPDATA` y `AI_HUB_LOCK_DIR` en carpetas temporales vacías, sin `.env`, sin tracker, sin red salvo la descarga autorizada. Identidad: `dist.integrity` del registro igual al del lockfile instalado (0.12.0 `sha512-9BWlAPA2…pa9mFQ==`, 0.17.0 `sha512-g/LatXcU…PtEFA==`); candidato `npm pack` de la rama, 2026 archivos, sha256 `73c7ef9c…1105dc`. Fixture creada con `init --preset-only --yes --no-speckit` de 0.17.0 y `policy.runs.keep: 3`. **A:** 5 runs v1 (enero), 2 runs v2 `0000-v2-first|second` (nombres que se ordenan primero, primer evento 2026-11-20), `runs/control/state/{grants,associations,execution-index}.json` y `control/decisions.jsonl`. **B (control):** solo los 5 runs v1. Payload de `hook pre` con `session_id` nuevo. Secuencia por binario en una copia nueva: `runs list` → `runs start` → `hook pre` → `doctor`. Script: `scratchpad/scripts/compat322.sh`; salidas en `scratchpad/compat/results/`.

| Binario | `runs list` (A) | `runs start` (A) | `hook pre` (A) | `control/` (A) | Control B | `doctor` |
|---|---|---|---|---|---|---|
| 0.12.0 | 0, lista los 7, lee líneas v2 sin error | 0; poda `0000-v2-first`, `0000-v2-second`, `…01`, `…02`, `…03` (por nombre) | 0, `allow`; poda `…04`; crea `session-…` con eventos `v:1` | 4 archivos con hash idéntico tras los 4 pasos | poda `…01–03` y luego `…04`: la poda ocurre | 1: `speckit:managed` (fixture `--no-speckit`) y `lock` por la edición de `manifest.yaml` de la fixture |
| 0.17.0 | igual que 0.12.0 | igual: los dos v2 podados primero | igual (`v:1`) | idéntico | igual | igual |
| candidato | 0, igual | 0; poda los 5 v1 por primer evento y **conserva los dos v2** | 0, `allow`; poda `0000-v2-first` (primer evento más antiguo de los 3 restantes); crea `session-…` con `v:2, origin: hook`; no añade eventos a v2 | idéntico | igual que los publicados | 1: además `drift` 1 en `.opencode/plugins/ai-hub.js`, que es la corrección de A2 (deriva de actualización; la resuelve `sync`) |

Causas de `doctor` comprobadas: sobre la base sin modificar, 0.17.0 tiene `lock` y `drift` verdes; el `lock` rojo de A/B viene de editar `manifest.yaml` (fuente del lock). Conclusión: la matriz de [design.md] › Persistencia se confirma sin contradicciones (los publicados podan v2 por nombre y no tocan `runs/control/`); la fila «pendiente de 3.22» pasa a medida. VMC fijada en **0.18.0** (primer release de esta rama). No medido: un binario antiguo con `runs event --run <v2>` (añadir v1 a un run v2), que el diseño ya declara no soportado; Linux (solo Windows).

### Ejecución completa huérfana `test-harden-full-2.log` (no íntegra)

Lanzada antes de la compactación con concurrencia por defecto, siguió como proceso huérfano y terminó: 66 archivos (11 fallidos, 55 aprobados), 1033 pruebas (97 fallidas, 929 aprobadas, 7 omitidas), 2288 s. **No es verificación integral**: el código cambió durante la ejecución (3.8–3.10 y A1/A2) y la máquina estaba sin memoria (~60 procesos MCP ajenos). No demuestra fallos de aserción ni su ausencia; se sustituye por la ejecución canónica `npm test` (`vitest run --maxWorkers=1`) tras `npm run build` y `manifest:build`, sin ediciones de código durante su curso (`test-harden-full-3.log`).

### Ejecución canónica `npm test` tras build (2026-11-23, `test-harden-full-3.log`)

Comando: `npm run build && npm run manifest:build && npm test` (`vitest run --maxWorkers=1`), sin ediciones de código durante la ejecución. Resultado: 69 archivos (67 aprobados, 2 fallidos), 1084 pruebas (**1075 aprobadas, 2 fallidas, 7 omitidas**), 4275 s, salida 1. **No es una ejecución única en verde.**

- `pack.test.ts` (recuento 2034 frente a 2026): las 8 entradas nuevas son exactamente `dist/harness/compat`, `dist/writes/{leftovers,sensitive-copies,writer-gate}` (`.js` y `.d.ts`), por diff de la lista de `npm pack --dry-run --json` contra el tarball candidato empaquetado al inicio de la continuación; sin pruebas, fixtures ni secretos. Expectativa actualizada con esa justificación; `pack` 6/6 al relanzarla.
- `speckit-real.test.ts` › end to end (10.1): `uvx … specify integration install cursor-agent` terminó en `spawnSync uvx ETIMEDOUT` tras 45 min (después `EBUSY` al borrar el temporal). Relanzada sola: **aprobada en 170 s** (`test-speckit-real-rerun.log`). Fallo de entorno (Spec Kit real por red/caché), no de aserción; queda pendiente verla verde dentro de una ejecución completa.

### Ejecución canónica `npm test` (2026-11-23, `test-harden-full-4.log`)

Tras `typecheck`, `build`, `manifest:build` y `manifest:check` en verde, sin ediciones de código durante la ejecución: 78 archivos (77 aprobados, 1 fallido), 1232 pruebas (**1220 aprobadas, 1 fallida, 11 omitidas**), 1487 s, salida 1. `speckit-real` pasó esta vez dentro de la ejecución completa.

- Fallo: `control-hardening.test.ts` › «a malformed remote line is discarded». La prueba (fase 5.1, anterior a este change) esperaba que una última nota de estado inválida se descartara y se propusiera desde la anterior; R-109 (4.84) exige lo contrario: la issue se detiene con `invalid_status`. Expectativa cambiada al contrato aprobado (la parte «un run local gana» se mantiene); la suite pasa 9/9. **La ejecución única no es verde**; queda pendiente repetirla completa.

### Ejecución canónica final `npm test` (2026-11-24, `test-harden-full-5.log`)

78/78 archivos, **1238 aprobadas, 0 fallidas, 11 omitidas** (POSIX/pty), salida 0, tras typecheck, build, `manifest:build` y `manifest:check` en verde. Es la primera ejecución única en verde del comando canónico en esta aplicación.

### Clasificación de las 45 tareas abiertas (2026-11-24, inicio de la continuación)

Dependencias revisadas una a una contra `tasks.md` (columna «Antes») y contra lo que el comportamiento necesita de verdad.

| Clase | Tareas | Motivo concreto |
|---|---|---|
| Trabajo local pendiente | 3.11, 3.19 (parte GitHub), 4.68, 4.69, 4.70, 5.15, 5.14 (tras 5.15), 5.17 (tras 5.14), 3.21 (redacción y prueba; su «Antes» incluye 3.23) | Sus dependencias están hechas o son internas; se verifican con dobles HTTP, fixtures y procesos locales. |
| Implementación local con dobles; dependencia declarada de 5.6 a evaluar | 5.7, 5.10, 5.11, 5.12, 5.16 | 5.6 aporta candidatos verificados en un host real; la prioridad, el lock, la cancelación, el fallback, los marcadores y la issue por ejecución se prueban con candidatos y procesos doble. Si se completan, la integración con el descubrimiento real queda pendiente de 5.6. |
| Implementación posible pero evidencia real exigida | 5.13 (sesiones del harness: 2.6), 5.18 (E2E con Codex real; su cuerpo necesita el runner con descubrimiento real) | El criterio exige un harness real o su evidencia; un doble no la sustituye. |
| Investigación documental | 4.25 (versión mínima de `hermes cron pause|resume`) | 1.7 no la encontró; se repite con fuentes primarias. |
| Otro entorno | 3.23 (reproducción de 1.16 en CI de Windows y Linux); omisiones POSIX/pty de la suite | Necesita CI o un host POSIX autorizado. |
| Experimento pendiente de autorización | 1.13, 2.1–2.10; condicionadas 5.1–5.6, 5.19–5.21, 6.1 | Servicios, perfiles o harnesses reales. |
| Posterior a publicación | 3.24 | Necesita el paquete publicado. |
| Excluida mientras no cambie el alcance | 4.88 (SC-03) ; 7.1–7.4 (sin las 10 mediciones reales no se reduce el panel) | Decisiones vigentes. |

### 4.25 — versión mínima de `hermes cron pause|resume` (2026-11-24, fuentes primarias)

- Documentación oficial vigente: `hermes cron <list|create|edit|pause|resume|run|remove|status|runs|incidents|doctor|tick>`; `pause` detiene un job sin borrarlo y `resume` lo reanuda calculando su próxima ejecución (https://hermes-agent.nousresearch.com/docs/reference/cli-commands ; https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals, que añade que pause/resume borra la plaza pendiente).
- Ninguna nota de release ni PR localizada fija cuándo se introdujeron: la PR #134299 (https://github.com/NousResearch/hermes-agent/pull/134299) solo documenta `runs`, `incidents` y `notepad`; el changelog de PyPI (https://data.safetycli.com/packages/pypi/hermes-agent/changelog) menciona cron en 2026.7.7.2 y 2026.7.20 sin anunciar pause/resume.
- **Resultado: mínimo no determinable con fuente fiable.** La capacidad se mantiene «no verificada»; 4.25 sigue abierta (su criterio exige la versión de 1.7 o del experimento 2.5). No se ejecutó Hermes.

### 4.68 — `tracker.kind: github` en binarios publicados (2026-11-24, fixture aislada de 3.22)

Con `tracker: { kind: github, urlEnv: GITHUB_API_URL, tokenEnv: GITHUB_TOKEN }` en `manifest.yaml`, `doctor` de 0.12.0 y de 0.17.0 sale 1 con `[FAIL] manifest: manifiesto inválido: /tracker/kind must be equal to one of the allowed values`. Es el error claro de una versión antigua que se documenta en las notas de versión (volver por debajo de la VMC con GitHub configurado no está soportado).

### Reevaluación de las 37 tareas abiertas (2026-11-24)

| Causa | Tarea | Exige | Estado local | Falta |
|---|---|---|---|---|
| Orden documental con 5.6 (condicionada a 2.6) | 5.11, 5.12, 5.16 | fallback, marcadores, issue única | implementado, integrado en `executeGrantedRun` y probado con dobles | solo el «Antes: 5.6»; decisión del propietario (ver propuesta) |
| Orden documental + evidencia real | 5.7 | prioridad configurable | parámetro `order` y pruebas (Claude no operativo; ningún candidato) | 5.6; no hay clave de configuración en el manifiesto |
| Plataforma | 5.10 | lock y cancelación POSIX y Windows | Windows en verde | ejecución en Linux (job `platform-evidence`) |
| Plataforma | 3.23 | determinista + 1.16 en CI Windows y Linux | todo lo determinista en verde en Windows | ejecución del CI |
| Depende de 3.23 | 3.21 | documentación fijada por prueba | hecha (`docs-writes.test.ts`) | su «Antes» 3.23 |
| Evidencia real | 5.13 | reanudación tras reconciliar | simulada (`resumeOffer`) | formato real de sesión (2.6) |
| Evidencia real | 5.18 | E2E con Codex omitido sin variable | prueba omitida sin `AI_HUB_CODEX_E2E=1` | 5.6 y Codex real |
| Condicionadas (experimento) | 5.6, 5.21 | descubrimiento y sondas | implementado con dobles; declaraciones reales vacías | 2.6 |
| Condicionadas (experimento) | 5.1, 5.2, 5.3, 5.4, 5.5, 5.19, 5.20, 6.1 | capacidades por experimento | — | 2.1, 2.2, 2.3/2.8, 2.4, 2.9, 2.10 |
| Experimentos | 1.13, 2.1–2.10 | autorización y ejecución | — | autorización del propietario por experimento |
| Documental + experimento | 4.25 | nombre configurado y versión mínima | nombre configurado probado (`control-enroll`) | versión mínima: 1.7 sin dato; 2.5 |
| Medición real | 7.1–7.4 | ≥10 cambios reales medidos con el panel completo | no hay mediciones registradas | ejecutar el panel sobre cambios reales (consume sesiones) |
| Posterior a publicar | 3.24 | VMC con el paquete publicado | — | publicación |
| Excluida | 4.88 | `config apply` | — | SC-03 deshabilitado |

### Omisiones de la suite (2026-11-24)

| Archivo › prueba | Causa | Entorno que la ejecutaría |
|---|---|---|
| `writes` › POSIX exige modo 700 | permisos POSIX | Linux (CI) |
| `idea-input-e2e` › IDEA.md not writable (dangling symlink) | semántica POSIX: en Windows `wx` sobre un enlace colgante crea el destino | Linux |
| `cli` › read-only target (POSIX) | directorio de solo lectura POSIX (y no root) | Linux sin root |
| `idea-input-pty` › node-pty sin declarar (1.5) | `node-pty` no es dependencia declarada | instalar `node-pty` con `--no-save` (decisión: no declarado) |
| `idea-input-pty` › nivel 3 ×4 (2000 líneas con y sin marcadores, 64 KiB, Ctrl+C) | `node-pty` no instalado | ídem |
| `idea-input-pty` › nivel 2 ×2 | pty POSIX de Python | Linux |
| `codex-e2e` › E2E con Codex real | opt-in `AI_HUB_CODEX_E2E=1` | Codex instalado y 2.6 |
| ~~`sync` › rejects symlinks~~ | resuelta: junction en Windows | — |

## Hito 2 — experimentos ejecutados (2026-11-24, autorizados por escrito en `history.md`)

### 2.2 BT-1 GitHub
- Entorno: github.com (versión del servicio no expuesta; API `2022-11-28`), cliente `gh`, repositorio privado desechable `dsalazardev/ai-hub-bt-disposable-20261124`, issue #1. Token del propietario en el llavero de `gh`, nunca impreso.
- Operación: A lee la issue (ETag de v1); B escribe `ai::blocked`; A escribe `ai::in-review` con `If-Match: <ETag v1>` por `PUT /repos/…/issues/:n/labels` y por `PATCH /repos/…/issues/:n`. 10 repeticiones; al final, escritura fresca con `If-Match` del ETag vigente.

| rep | lectura | ETag v1 | B | A PUT | A PATCH | etiqueta final | obsoleta aceptada |
|---|---|---|---|---|---|---|---|
| 1 | 200 | W/"c68d0c64e6e… | 200 | 400 | 400 | ai::blocked | no |
| 2 | 200 | W/"9f0799fe30b… | 200 | 400 | 400 | ai::blocked | no |
| 3 | 200 | W/"939fcc10734… | 200 | 400 | 400 | ai::blocked | no |
| 4 | 200 | W/"6ea636e035e… | 200 | 400 | 400 | ai::blocked | no |
| 5 | 200 | W/"d28f7e43e7d… | 200 | 400 | 400 | ai::blocked | no |
| 6 | 200 | W/"333bc6bc336… | 200 | 400 | 400 | ai::blocked | no |
| 7 | 200 | W/"0399da77a22… | 200 | 400 | 400 | ai::blocked | no |
| 8 | 200 | W/"ffc0c094370… | 200 | 400 | 400 | ai::blocked | no |
| 9 | 200 | W/"757a5dc43b6… | 200 | 400 | 400 | ai::blocked | no |
| 10 | 200 | W/"4c297c8ea5b… | 200 | 400 | 400 | ai::blocked | no |

- Escritura fresca con `If-Match`: 400; cuerpo: `{"message":"Bad Request","errors":["Conditional request headers are not allowed in unsafe requests unless supported by the endpoint"],"status":"400"}`.
- Veredicto: **fracaso** de BT-1 (no se acepta la escritura fresca condicionada: no existe la capacidad; los 400 no son un rechazo por precondición). La capacidad `conditional_label_update` de GitHub sigue `available: false`; 5.20 queda detenida y rige la retención (D-48).

### 2.10 Borrado condicional en GitHub
- Versiones: servidor github.com (no expuesta), transporte HTTPS, cliente `git version 2.56.1.windows.1`. Mismo repositorio desechable; clones A y B en un directorio temporal.
- Comando: `git push --porcelain --force-with-lease=refs/heads/<rama>:<cabeza leída por A> origin :refs/heads/<rama>`.

```text
rep=1 lease=8ed8ec22a4 B=772cec242d result=[!	(delete):refs/heads/bt-del-1	[rejected] (stale info) ] final=772cec242d conserved_B=yes
rep=2 lease=65c3f6f5c9 B=c1fed83e83 result=[!	(delete):refs/heads/bt-del-2	[rejected] (stale info) ] final=c1fed83e83 conserved_B=yes
rep=3 lease=d77347e393 B=22f027d1fb result=[!	(delete):refs/heads/bt-del-3	[rejected] (stale info) ] final=22f027d1fb conserved_B=yes
rep=4 lease=dff5c1f579 B=9b3bcb2feb result=[!	(delete):refs/heads/bt-del-4	[rejected] (stale info) ] final=9b3bcb2feb conserved_B=yes
rep=5 lease=8777f51647 B=169b3eea50 result=[!	(delete):refs/heads/bt-del-5	[rejected] (stale info) ] final=169b3eea50 conserved_B=yes
rep=6 lease=e1b219fb5b B=b5268ca156 result=[!	(delete):refs/heads/bt-del-6	[rejected] (stale info) ] final=b5268ca156 conserved_B=yes
rep=7 lease=b35c3743d2 B=e569c5fdf7 result=[!	(delete):refs/heads/bt-del-7	[rejected] (stale info) ] final=e569c5fdf7 conserved_B=yes
rep=8 lease=c0d8035577 B=413ac71d6d result=[!	(delete):refs/heads/bt-del-8	[rejected] (stale info) ] final=413ac71d6d conserved_B=yes
rep=9 lease=96ef49b5a4 B=37316ca8de result=[!	(delete):refs/heads/bt-del-9	[rejected] (stale info) ] final=37316ca8de conserved_B=yes
rep=10 lease=ea1da8e535 B=7c2d86cae5 result=[!	(delete):refs/heads/bt-del-10	[rejected] (stale info) ] final=7c2d86cae5 conserved_B=yes
control result=[] final=[]
```

- Veredicto: **éxito** según el protocolo (10/10 rechazos conservando el commit de B; control borrado). La secuencia ejercita el lease del cliente; la atomicidad del servidor frente a un push simultáneo se apoya en la documentación del protocolo (`old-id`) y no se presenta como medida. Habilita 5.19 solo para GitHub, HTTPS y git ≥ 2.56.1.

### 2.5 Cron de Hermes (pause/resume por nombre)
- Entorno: Hermes 0.23.4 (git, Windows), `HERMES_HOME` desechable en el scratchpad (runtime aislado instalado en él); ningún perfil del propietario ni su gateway.

```text
$ hermes --version
Hermes Agent v0.23.4 (2026.9.24) · stable · local 8fc037444731
exit=0
$ hermes cron create every 60m --name ai-hub-bt-poll --no-agent --script bt-poll.sh --deliver local
Created job: 524eb0686149
exit=0
$ hermes cron list
  524eb0686149 [active]
exit=0
$ hermes cron pause ai-hub-bt-poll
Paused job: ai-hub-bt-poll (ai-hub-bt-poll)
exit=0
$ hermes cron list
  524eb0686149 [paused]
exit=0
$ hermes cron pause AI-HUB-BT-POLL
Paused job: ai-hub-bt-poll (AI-HUB-BT-POLL)
exit=0
$ hermes cron resume ai-hub-bt-poll
Resumed job: ai-hub-bt-poll (ai-hub-bt-poll)
exit=0
$ hermes cron list
  524eb0686149 [active]
exit=0
$ hermes cron pause no-existe-ai-hub
Failed to pause job: Job with ID or name 'no-existe-ai-hub' not found. Use cronjob(action='list') to inspect jobs.
exit=1
$ hermes cron remove ai-hub-bt-poll
Removed job: ai-hub-bt-poll (ai-hub-bt-poll)
exit=0
$ hermes cron list
exit=0
```

- Veredicto: `pause` y `resume` por nombre funcionan (nombre sin distinguir mayúsculas); un nombre inexistente sale 1 y lo nombra. Versión mínima verificada: **0.23.4** (la documentación no fija una; versiones anteriores sin medir) → `MIN_HERMES_CRON_PAUSE` (4.25).

### 2.4 BT-3 estado del gateway
- Entorno: el mismo `HERMES_HOME` desechable; `hermes gateway run` como proceso hijo propio (sin `start/stop/restart`, que actúan sobre el servicio instalado); dos ciclos de arranque y parada (taskkill del árbol propio); cada ~8 s, `gateway_state.json` y `hermes gateway ensure --json --timeout 1`.
- Observado: antes y durante el arranque, sin `gateway_state.json` y `ensure` = `starting`/`deadline` (salida 5); listo, `gateway_state: running` y `ensure` = `ready` (salida 0); tras matar el proceso, el archivo sigue en `running` y `ensure` vuelve a `starting`/`deadline`; `hermes gateway status` = «Gateway is not running». Sin procesos residuales.
- Veredicto: **fracaso** de BT-3 para 0.23.4 — ningún estado documentado y estable distingue «arrancando» de «detenido». 5.2 queda detenida; rige la tabla conservadora (D-55).

### Impedimentos de los experimentos restantes
- **2.1 y 2.9 (GitLab):** no hay instancia ni credencial de prueba de GitLab en este equipo (ni `glab`); los únicos tokens de GitLab son los de consumidores existentes, que no se pueden usar. Necesario: un proyecto desechable en la instancia y versión del consumidor y un token de prueba de alcance mínimo en un `.env` del taller (no en el chat).
- **Limpieza de GitHub:** el token de `gh` no tiene el scope `delete_repo`; el repositorio desechable queda creado (privado). Para borrarlo: `gh auth refresh -h github.com -s delete_repo` (interactivo) y `gh repo delete dsalazardev/ai-hub-bt-disposable-20261124 --yes`.

### 2.6 Harnesses (directorio temporal vacío fuera de proyectos; salidas redactadas)

Sentinelas: `CLAUDE.md` pide responder `CLAVE-7C1` y `AGENTS.md` `AGENTE-9F2`; la pregunta pide ambas (o `NINGUNA`).

| Harness y versión | Estado | Sin interfaz | Sesión | Reanudación | Contexto consumido | Efectos de arranque | Coste |
|---|---|---|---|---|---|---|---|
| Claude Code 2.1.330 (`~/.local/bin/claude.exe`) | `claude auth status`: JSON `loggedIn: true`, `authMethod: claude.ai`, salida 0 (incluye correo y organización: no se leen) | `claude -p <tarea> --output-format json` → `result: "CLAVE-7C1 NINGUNA"`, salida 0, 1 turno, 3,8 s | `session_id` UUID | `--resume <id>` → misma sesión y respuesta | `CLAUDE.md` sí; `AGENTS.md` no | ningún archivo en el directorio; sesión en `~/.claude/projects` | 0,144 USD + 0,040 USD (reanudación); 17 328 tokens de caché creados |
| Codex 0.172.0 (`npm install @openai/codex` en el scratchpad, binario nativo `codex.exe`; no global) | `codex login status`: salida 0; «Logged in using ChatGPT» por **stderr** | `codex exec --json --skip-git-repo-check --sandbox read-only <tarea>` → `agent_message: "NINGUNA AGENTE-9F2"`; necesita stdin cerrado | `thread.started.thread_id` | `codex exec resume <id> --json` → mismo hilo y respuesta | `AGENTS.md` sí; `CLAUDE.md` no | ninguna herramienta; ningún archivo | 18 789 tokens de entrada (13 696 en caché), 48 de salida |
| OpenCode 2.3.2 | `opencode auth list`: integraciones «stored» (no valida la sesión) | `opencode run --format json --archived <tarea>` → `CLAVE-7C1 AGENTE-9F2` tras **ejecutar herramientas sin aprobación** (`read`, `glob` del directorio completo); eventos `retry` | `sessionID` (`ses_…`) | `--session <id>` → misma respuesta | los obtuvo leyendo archivos con herramientas | lecturas no pedidas del directorio; ningún archivo escrito | 0 (modelo de la cuenta) |

- **Resultado (D-31):** Claude Code 2.1.330 y Codex 0.172.0 verificados y declarados en `core/src/runner/discovery.ts` (rango cerrado en la versión medida); OpenCode 2.3.2 no verificable (sin estado que valide la sesión) y no seleccionable. Escribir con permisos no se midió: las ejecuciones declaradas no conceden escritura.
- **Hallazgos para el runner:** (1) Codex escribe su estado en stderr: la operabilidad se decide por la salida 0 documentada. (2) Los comandos del sandbox de Codex no ven `AI_HUB_RUN_ID`: un primer E2E real terminó con `run_mismatch` (la vinculación funcionó); el run id viaja ahora también en el texto de la tarea (`taskWithRun`). (3) En Windows, sin shell, solo se lanzan `.exe`/`.com`: los shims `.cmd` de npm no cuentan como presentes.
- **E2E (5.18):** con `AI_HUB_CODEX_E2E=1` y el binario local en `PATH`: descubrimiento (Codex presente, compatible y operativo) y ejecución concedida completa (concesión real del registro → Codex → cierre `DONE` aceptado con el run id asignado; telemetría `harness: codex`, `harness_version: 0.172.0`, `origin: runner`). Sin la variable, omitido.
- **Smoke real:** `ai-hub orchestrate discover` en este equipo → Claude Code 2.1.330 operativo y seleccionado; Codex «binario ausente» (instalación local fuera de `PATH`); OpenCode no verificable.

## Hito 7 — fase 2 de #8: mediciones del panel completo (2026-11-24)

- **Selección:** 12 commits reales del historial de `main` (antes de `c11feda`), agrupados por tipo: documentación (3), release (2), pruebas (2), corrección (4), funcionalidad pequeña (1). Se excluyeron los commits de cientos de archivos (catálogo, motor inicial), que ninguna lente puede revisar con rigor; ninguno se fabricó ni se dividió.
- **Ejecución:** por cambio, las tres lentes (`refuter-correctness`, `refuter-security`, `refuter-tests`) en paralelo y aisladas, con el cuerpo de su archivo de agente como prompt de sistema, solo `Read`/`Grep`/`Glob` (capacidades `read`, `search`), `max_turns` 40, sobre el árbol del commit exportado con `git archive` (sin worktree ni rama) y el diff en `CHANGE.diff`; luego `finding-verifier` por cada blocker o should-fix único. Claude Code 2.1.330, salida JSON (tiempo, tokens y coste reales).
- **Cuatro entradas:** contrato = mensaje del commit; spec aprobada = **no recuperable** para cambios históricos (limitación: el contrato es el mensaje); estado = el commit; entrada = `npm --prefix core test` (las lentes no ejecutan comandos).
- **Incidencia:** 7 cambios agotaron el límite de uso a mitad de la primera tanda (lentes con error en segundos y coste 0); se repitieron completos tras el reinicio del límite. Solo cuentan las ejecuciones válidas (12/12).

| Cambio | Grupo | Archivos (líneas; raíces) | correctness | security | tests | Verificación de blockers/should-fix |
|---|---|---|---|---|---|---|
| `91b63b0` | docs | 2 (+565/−1); .planning, documentation | 0 h · 117 s · 871k tok · 0.79 USD | 1 h · 72 s · 285k tok · 0.55 USD | 0 h · 54 s · 350k tok · 0.53 USD | — (0.00 USD) |
| `1de3e89` | docs | 34 (+2163/−0); .planning, AGENTS.md, architecture, openspec | 4 h · 98 s · 518k tok · 0.66 USD | 5 h · 143 s · 764k tok · 0.93 USD | 0 h · 69 s · 515k tok · 0.55 USD | correctness/should-fix: CONFIRMED; correctness/should-fix: CONFIRMED; correctness/should-fix: CONFIRMED; security-privacy/should-fix: CONFIRMED; security-privacy/should-fix: CONFIRMED (2.01 USD) |
| `3496f3f` | docs | 31 (+3/−0); .gitignore, documentation, {architecture => documentation | 1 h · 133 s · 889k tok · 0.65 USD | 2 h · 115 s · 721k tok · 0.60 USD | 2 h · 91 s · 556k tok · 0.56 USD | — (0.00 USD) |
| `9bb8e96` | release | 4 (+32/−14); CHANGELOG.md, core | 4 h · 150 s · 848k tok · 0.71 USD | 0 h · 91 s · 504k tok · 0.52 USD | 2 h · 84 s · 295k tok · 0.47 USD | — (0.00 USD) |
| `d4e54b0` | release | 4 (+31/−17); CHANGELOG.md, core | 2 h · 105 s · 439k tok · 0.48 USD | 2 h · 115 s · 551k tok · 0.51 USD | 2 h · 142 s · 573k tok · 0.59 USD | correctness/blocker: CONFIRMED; security-privacy/blocker: CONFIRMED (0.72 USD) |
| `bae6ac7` | tests | 1 (+1/−1); core | 0 h · 74 s · 302k tok · 0.36 USD | 0 h · 46 s · 166k tok · 0.28 USD | 0 h · 86 s · 307k tok · 0.39 USD | — (0.00 USD) |
| `72fe30d` | tests | 2 (+2/−2); core | 0 h · 57 s · 216k tok · 0.32 USD | 0 h · 52 s · 169k tok · 0.31 USD | 1 h · 64 s · 308k tok · 0.35 USD | — (0.00 USD) |
| `d737c2d` | fix | 2 (+34/−1); core | 0 h · 56 s · 384k tok · 0.40 USD | 0 h · 41 s · 215k tok · 0.31 USD | 1 h · 62 s · 241k tok · 0.42 USD | tests-as-evidence/should-fix: CONFIRMED (0.57 USD) |
| `fa86ae6` | fix | 5 (+24/−5); core | 2 h · 84 s · 529k tok · 0.57 USD | 1 h · 111 s · 576k tok · 0.69 USD | 2 h · 86 s · 450k tok · 0.52 USD | correctness/should-fix: CONFIRMED; tests-as-evidence/should-fix: CONFIRMED (0.94 USD) |
| `6a6965e` | fix | 8 (+316/−21); CHANGELOG.md, README.md, core | 3 h · 296 s · 1489k tok · 1.28 USD | 2 h · 257 s · 1505k tok · 1.12 USD | 3 h · 274 s · 1636k tok · 1.19 USD | correctness/should-fix: CONFIRMED; security-privacy/blocker: CONFIRMED; tests-as-evidence/should-fix: CONFIRMED; tests-as-evidence/should-fix: CONFIRMED (2.66 USD) |
| `d78de6d` | fix | 7 (+85/−18); CHANGELOG.md, core | 3 h · 128 s · 368k tok · 0.53 USD | 0 h · 117 s · 393k tok · 0.45 USD | 2 h · 130 s · 377k tok · 0.55 USD | — (0.00 USD) |
| `4e031c4` | feature | 9 (+282/−82); CHANGELOG.md, README.md, core | 1 h · 106 s · 324k tok · 0.53 USD | 0 h · 64 s · 197k tok · 0.41 USD | 5 h · 141 s · 640k tok · 0.68 USD | tests-as-evidence/should-fix: CONFIRMED; tests-as-evidence/should-fix: sin veredicto (0.66 USD) |

- **Coste total del panel válido:** 28,31 USD; mediana por cambio ≈ 1,8 USD; lentes de 41 a 296 s.
- **Criterio D-56 por grupo:** `low` (una lente) solo aplica a documentación sin rutas de riesgo. En **documentación** (3 cambios) `1de3e89` tuvo 5 `CONFIRMED` repartidos entre correctness (3) y security (2): cualquier lente única habría perdido hallazgos confirmados → **no se habilita `low`**. **Corrección** (4): `CONFIRMED` de las tres lentes. Release y pruebas (2 cada uno) y funcionalidad (1) no llegan a 3: muestra insuficiente. **Conclusión: ningún grupo habilita `low`; el panel completo se mantiene en todos los cambios.**
