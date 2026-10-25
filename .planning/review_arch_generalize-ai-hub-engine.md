# Revisión de arquitectura — `generalize-ai-hub-engine`

**Rol:** Reviewer-Architecture
**Fecha:** 2026-10-24 — rondas 1, 2 y 3 (verificación final)
**Alcance:** `core/src/**`, `core/engine/**`, `core/agents/**`, `core/skills/**`, `core/presets/**`, `core/schema/**`, `skills/`, `manifest.yaml`, `package.json`, `bootstrap/verify.sh`, `mcp-manifest.yaml`, `.gitignore` y documentación de runtime.
**Artefactos del cambio:** `openspec/changes/generalize-ai-hub-engine/{proposal.md, design.md, tasks.md, specs/**}`.
**Modo:** solo lectura sobre el código. No se modificó fuente, tests, specs ni configuración.

---

## Veredicto final: `PASS`

No queda ningún hallazgo bloqueante. Los siete bloqueantes de la ronda 1 están cerrados y el residuo
B1-R de la ronda 2 (comandos `/opsx:*` del preset y adaptadores huérfanos) está eliminado y protegido
con una prueba de acoplamiento nueva.

Verificado en esta ronda: `npm --prefix core run build` exit 0 · `npm --prefix core test` **140 passed,
1 skipped** · `manifest:check` `[OK]` · `ai-hub doctor` **22 checks `[OK]`**, exit 0 · `ai-hub drift`
`[OK] Sin deriva` · `rg -i "opsx"` en todo el repositorio devuelve únicamente los literales de la
propia prueba · `rg -i "openspec" core/presets` = 0 · árbol proyectado (`init --preset angular-express
--yes` + `install` en `%TEMP%`) con 0 coincidencias de `openspec|opsx` · `npm pack --dry-run` incluye
`engine/`, `presets/`, `agents/`, `skills/shared/speckit-*` y los `references/` sin `/opsx`.

**Alcance del PASS.** Es un veredicto técnico sobre el código y el contenido del paquete. El archivo
del cambio sigue sujeto a la puerta humana (`ai::spec-ready` con hash SHA-256 y marcado de tareas):
ver §5.

---

## 1. Verificación de B1-R (ronda 3)

| Comprobación | Evidencia |
|---|---|
| `skills/adapters` eliminado | `git status` → `D skills/adapters/claude-commands.yaml`, `D skills/adapters/opencode-commands.yaml`; el directorio ya no existe; `skills/` solo conserva `gitlab-auth`, `gitlab-workflow` y `planning-with-files`. |
| `references/` migradas a Spec Kit | `products-module-blueprint.md:20` → `/speckit.specify` → aprobación humana → `/speckit.implement`; `module-implementation-flow.md:202` → `/speckit.converge`; `users-migration-notes.md:170` → `/speckit.converge` / `/speckit.specify`; `fichajes-migration-notes.md:5` → `/speckit.implement`. `rg -i "opsx|openspec" core/presets` = 0. |
| Ningún `/opsx` en el repositorio | `rg -i opsx` (excluyendo `openspec/`, `.git`, `node_modules`, `dist` y árboles generados) devuelve solo `core/tests/coupling.test.ts:63` y `:75`, que son los literales de la prueba. |
| Prueba de acoplamiento nueva | `core/tests/coupling.test.ts:54-69` escanea `core/presets`, `core/skills` y `skills` (`.md|.yaml|.yml`) y falla si aparece `/opsx` u `opsx:`; `:71-79` exige «Spec Kit» y ausencia de `/opsx` en `AGENTS.md`, `README.md`, `rules/core.md`, y ausencia de `openspec` en `bootstrap/verify.sh`. |
| Árbol proyectado limpio | `init --preset angular-express --yes` + `install` en `%TEMP%`: 0 coincidencias de `openspec|opsx` en `.ai-hub` y `.claude`; `.ai-hub/agents/spec-author.md` es el agente genérico de `core/agents` (`description: Authors Spec Kit requirements…`); `super-dev` ausente; `doctor` «Resultado: sano». |
| Paquete limpio | `npm pack --dry-run` incluye `presets/angular-express/references/*`; esos archivos no contienen `opsx` ni `openspec`. |
| `backend/package.json` fuera del detector | `core/src/presets/detect.ts:44-56` lee solo el `package.json` raíz; `:81-90` no lista `backend/package.json`. Sin regresión: `init --dry-run` sigue detectando `angular-express` tanto con `@angular/core` en la raíz como cuando `express` solo está en `backend/package.json` (el marcador `backend/package.json` declarado en `preset.yaml:8` se resuelve por `exists()` en `detect.ts:106-110`). Test: `core/tests/manifest.test.ts:147`. |

---

## 2. Historial de bloqueantes (todas cerradas)

| # | Ronda | Hallazgo | Cierre verificado |
|---|---|---|---|
| B1 | 1 | El preset `angular-express` prescribía OpenSpec en agentes y `super-dev`, y se proyectaba a los 5 targets | Agentes y skill eliminados; agentes servidos desde `core/agents`; proyección sin OpenSpec (ronda 2) |
| B1-R | 2 | Residuo `/opsx:*` en 4 `references/` y 2 adaptadores huérfanos en `skills/adapters/` | Cerrado en ronda 3 (§1) |
| B2 | 1 | `angular.json` en `core/src/presets/detect.ts` y `coupling.json` sin `angular` | Lista eliminada, término añadido; `rg -i angular core/src` = 0 |
| B3 | 1 | `install --dry-run` y `repair --dry-run` escribían | `onboarding.ts:240-254`, `:277-291`; test `cli.test.ts:199` |
| B4 | 1 | `uninstall` de skill del preset corrompía el manifiesto sin backup | `maintenance.ts:136,144`; test `cli.test.ts:229` |
| B5 | 1 | Adaptador con worktrees en `branch: ''` y señales CI/deploy/team en `false` | `adapters/context.ts:62-98`; verificado con repo real |
| B6 | 1 | `trunk lock` escribía un estado que ningún guardia leía | `adapters/context.ts:100-117`; verificado `closed`/`open` |
| B7 | 1 | Patrones del preset podían degradar `deny` del core a `ask` | `guards/danger.ts:150-170`; test `guards.test.ts:85` |

---

## 3. Debt no bloqueante (para el siguiente cambio)

| # | Archivo:línea | Detalle y corrección sugerida |
|---|---|---|
| S2 | `core/src/cli/drift.ts:4-10`; `core/src/cli/doctor.ts:195-200` | Las categorías de deriva se deducen de prefijos en español sobre los mensajes de `sync.ts:60-77`. Devolver `SyncProblem { kind, path, source? }` y formatear en la CLI. |
| S3 | `core/src/sync/render.ts:202`, `:311-322` | El renderer aún ramifica por `tool === 'claude'` y escribe `opencode.json` aunque `opencode` no se declare. Añadir `agentFrontmatter` y `mcp: boolean` a `ToolTargets`. |
| S4 | `core/src/sync/sync.ts:25-45` | Las proyecciones antiguas no se borran ni se reportan: siguen 7 directorios `openspec-*` en `.claude/skills`, `.opencode/skills` y `.pi/skills`, 6 en `.cursor/rules`, `.claude/commands/opsx` (todo gitignorado), con `drift` en verde. Borrar por `coupling.legacySkillPrefix` y reportarlo como `obsolete` antes de pasar a `enforce`. |
| S5 | `core/src/presets/materialize.ts:4`; `core/src/backup/snapshots.ts:3` | `presets` y `backup` dependen de `sync` por `sha256`; viola `design.md:457`. Extraer `core/src/hash.ts`. |
| S6 | `core/engine/legacy-paths.json:2-3`; `harness/memory/state.ts:9,113-120` | Rutas de OpenSpec en datos genéricos. Concentrar en `core/src/migrate/legacy-openspec.ts` con allow-list explícita en el gate. |
| S7 | `core/src/cli/legacy.ts:19-20` | `judge` sigue siendo un stub que retorna 0; `AGENTS.md` §4.5 prohíbe placeholders. Eliminarlo o devolver `2`. |
| S8 | `core/src/manifest/manifest.ts:15,159` | `INVENTORY_RELATIVE = 'core/manifest.json'` asume este layout; usar `.ai-hub/manifest.json` o campo del manifiesto. |
| S9 | `adapters/hermes.ts:18`; `adapters/hooks.ts:50,74`; `adapters/context.ts:165` | `mode: GuardMode = 'shadow'` ignora `ctx.policy.guardMode`. |
| S10 | `.gitignore:94-95,103`; `mcp-manifest.yaml:33-34` | `.gitignore` cita «OpenSpec» y `openspec init`; `mcp-manifest.yaml` apunta a `.ai-hub/prompts/*` inexistentes. |
| R1 | `core/tests/coupling.test.ts:23-52` | El test de términos de dominio sigue excluyendo `core/presets/angular-express` y el test nuevo solo busca `/opsx`: una prosa «OpenSpec» reintroducida en ese preset pasaría ambos. Añadir `openspec` al escaneo de todos los presets. Hoy `rg -i openspec core/presets` = 0. |
| R2 | `core/tests/coupling.test.ts:58-61` | El escaneo de `skills` solo cubre `.md|.yaml|.yml`; scripts `.sh/.ps1/.py` no se revisan. Riesgo bajo. |
| OBS-9 | `guards/danger.ts:150-170` | El hardening impide escalar un `ask` del core a `deny` desde preset; si se necesita, comparar severidad con `rank = { allow: 0, ask: 1, deny: 2 }`. |
| OBS-10 | `core/tests` | `buildGuardContext` (B5/B6) no tiene test automático (`rg "buildGuardContext" core/tests` = 0); la verificación fue manual. Pedir cobertura a `reviewer-tests`. |
| OBS-11 | `adapters/context.ts:79` | `dirty: false` por worktree sigue siendo dato ficticio; ningún guardia lo consume hoy. |
| OBS-12 | `adapters/context.ts:132-136` | `defaultBranch` cae a `'main'` sin leer `init.defaultBranch`; un trunk con otro nombre queda fuera del guardia. |

---

## 4. Lo que cumple (verificado)

| Criterio | Resultado |
|---|---|
| `core/src/**` sin `openspec`, `Dolibarr`, `Doligestion`, `Angular` | ✅ `rg` = 0 |
| Presets y skills sin OpenSpec ni `/opsx` | ✅ `rg -i "openspec|opsx" core/presets core/skills skills` = 0 (solo los literales del test) |
| Árbol proyectado sin OpenSpec | ✅ 0 coincidencias; agentes desde `core/agents`; sin `super-dev` |
| Separación motor / preset / proyecto | ✅ `engine.yaml` (8/17/7 + 5 targets) validado en `engine.ts:90-133`; `presets/` con herencia y `scaffold-once`; `manifest.yaml` solo con campos de proyecto |
| `manifest.yaml` no redefine invariantes | ✅ `manifest.schema.json:18`; test `manifest.test.ts:59-62` |
| Guardias puros, adaptadores aparte | ✅ solo `guards/adapters/context.ts` hace IO; `guards/index.ts` sin adaptadores; test `guards.test.ts:249-257` |
| Sin `any` ni `TODO` de producción | ✅ 0 `any`; 0 `TODO/FIXME` (queda el stub `judge`, S7) |
| `package.json` empaqueta motor/presets/agents/skills | ✅ `core/package.json:9-17`; `npm pack --dry-run` verificado |
| 17 skills nativas sin `openspec-*` | ✅ `core/skills/shared/speckit-*`; gate `coupling.test.ts:81-89` |
| 14 patrones de peligro con precedencia core-first | ✅ `guards/danger.ts:35-124,150-170`; tabla de 20 comandos `guards.test.ts:46-67` |
| Memoria en `.planning/` con esquema cerrado y redacción | ✅ `harness/memory/{state,ledger}.ts`, retención `ledger.ts:133-146` |
| Reaper conservador y `--confirm` | ✅ `harness/worktree/reaper.ts:30-71`, `cli/worktrees.ts:140` |
| Build, tests, `manifest:check`, `drift`, `doctor` | ✅ 140 tests, 22 checks, exit 0 en los cinco |

---

## 5. Pendientes de proceso (no bloquean el veredicto técnico)

1. **Aprobación humana:** no existe artefacto con el hash SHA-256 de `spec.md + plan.md + tasks.md`.
   `.planning/state.json` marca `done: 0` sobre 58 y `tasks.md` no tiene ninguna tarea `[x]`. El cambio
   no debe archivarse hasta que el humano apruebe el hash y las tareas se marquen con su criterio de
   verificación cumplido.
2. **Traspaso a `reviewer-tests`:** cubrir `buildGuardContext` (OBS-10), la proyección limpia de
   `angular-express` (B1) y la ausencia de `/opsx` en el contenido empaquetado (B1-R/R1).
3. **Antes de `guardMode: enforce`:** resolver S4 (proyecciones antiguas) y S9 (modo por defecto en
   adaptadores), y decidir si S2/S3/S5 se abordan en un cambio corto.
