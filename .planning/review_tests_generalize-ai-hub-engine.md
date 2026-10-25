# Revisión de tests — `generalize-ai-hub-engine`

- **Rol:** reviewer-tests (solo lectura; no se modificó código ni tests).
- **Fecha:** 2026-10-24.
- **Alcance:** `openspec/changes/generalize-ai-hub-engine/specs/**` (5 specs), `tasks.md`, `core/tests/**` e inspección de `core/src/**` para comprobar que los tests ejercitan la conducta real.
- **Veredicto final:** **PASS** (0 bloqueantes; quedan residuales no bloqueantes documentados en §5).

---

## 1. Evidencia de ejecución

| Dato | Valor |
|---|---|
| Comando | `npm --prefix core test` |
| Entorno | Windows (`win32`), Node `v24.18.0`, npm `12.1.0`, Vitest `3.2.4` |
| Resultado | **exit 0** |
| Archivos | 10/10 passed |
| Tests | **140 passed**, **1 skipped**, 141 total |
| Duración | 23.40 s |
| Fecha/hora | 2026-10-24 21:26 |

Reparto: `reaper` 7, `coupling` 4, `paths` 12, `state` 4, `targets` 3, `ledger` 6, `manifest` 18, `guards` 41, `sync` 21 (1 skipped), `cli` 25.

**Test omitido:** `core/tests/sync.test.ts:190-195` (`rejects symlinks inside generated folders`) se salta en Windows por `process.platform === 'win32'`. No cuenta como cobertura en este entorno. Las cuatro categorías de drift que exige `dev-cli` (missing, stale, hand-edited, obsolete) sí están cubiertas; `symlink` es una categoría adicional.

**Umbral de cobertura:** no hay umbral numérico declarado. `core/package.json` no tiene script ni proveedor de cobertura y `.specify/memory/constitution.md` sigue siendo una plantilla. La puerta aplicada es de **trazabilidad requisito → test**, no de porcentaje.

---

## 2. Checklist solicitada

| # | Área | Estado | Evidencia |
|---|---|---|---|
| 1 | Presets: herencia | ✅ | `manifest.test.ts:119-126` (`base → generic-ts → angular-express`, override de stack/comandos) |
| 2 | Presets: detección | ✅ | `manifest.test.ts:147-161` (angular), `173-182` (python) |
| 3 | Presets: empate | ✅ unitario | `manifest.test.ts:163-171` (`chooseDetection` devuelve `base` + `ambiguous`). El camino `init` ambigua → error no tiene test de CLI (residual §5) |
| 4 | Presets: ciclo | ✅ | `manifest.test.ts:139-145` (ciclo artificial rechazado con `/ciclo/`) |
| 5 | Targets (5) | ✅ | `targets.test.ts:6-15` (5 ids), `17-21` (formas), `23-26` (coincide con el motor); `sync.test.ts:83-92` (salida por target) |
| 6 | Guardias: danger | ✅ | `guards.test.ts:46-72` (tabla de 20 comandos), `74-82` (comillas/regla/motivo) |
| 7 | Guardias: trunk | ✅ | `guards.test.ts:145-153` (CI cierra), `155-165` (opt-out); `buildGuardContext` lee `.planning/trunk.json` en `262-298` |
| 8 | Guardias: branch | ✅ | `guards.test.ts:105-126` (worktree ajeno), `128-143` (checkout propio) |
| 9 | Guardias: ship | ✅ | `guards.test.ts:167-176` (commits sin push), `178-184` (sin pendientes) |
| 10 | Guardias: fail-open | ✅ | `guards.test.ts:209-220` (builder falla → allow), `222-227` (contexto válido conserva decisión) |
| 11 | Guardias: shadow/enforce | ✅ | `guards.test.ts:194-201`, `312-320` |
| 12 | Preset no puede debilitar un `deny` | ✅ | `guards.test.ts:84-90`; `danger.ts:150` evalúa el motor antes de los patrones del preset |
| 13 | Memoria: redacción | ✅ | `ledger.test.ts:26-41` (`prompt`, `content`, `token` no llegan al JSON) |
| 14 | Memoria: retención | ✅ | `ledger.test.ts:76-82` |
| 15 | Memoria: decision | ✅ | `ledger.test.ts:57-74` (decisión + `changeId` + `queryLedger`); `cli.test.ts:308-319` |
| 16 | Memoria: resume | ✅ | `ledger.test.ts:84-97`; `cli.test.ts:308-321` |
| 17 | Sync: idempotencia | ✅ | `sync.test.ts:60-65` (segunda pasada 0 escrituras); `cli.test.ts:179-191` |
| 18 | Sync: drift | ✅ | `sync.test.ts:157-184` (missing/stale/hand-edited/obsolete), `150-155` (check no escribe); `cli.test.ts:193-200` |
| 19 | Sync: lock v1→v2 | ✅ | `sync.test.ts:105-120` (migra y conserva el conjunto de destinos) |
| 20 | Sync: rutas con espacios | ✅ | `sync.test.ts:211-222` |
| 21 | Sync: CRLF | ✅ | `sync.test.ts:67-73`, `199-201` |
| 22 | CLI: 18 comandos | ✅ | `cli.test.ts:40-69` (lista literal hardcodeada + longitud + filas) |
| 23 | CLI: init base/generic/python/angular | ✅ | `cli.test.ts:78-88` (generic + no escribe), `117-125` (python), `127-135` (angular), `137-143` (base) |
| 24 | CLI: migrate | ✅ | `cli.test.ts:156-167`; `state.test.ts:45-64` |
| 25 | CLI: hooks | ✅ | `cli.test.ts:169-175` (post-merge contiene `worktrees reap --auto`) |
| 26 | CLI: init idempotente | ✅ | `cli.test.ts:145-154` (conserva edición y reporta colisión) |
| 27 | CLI: uninstall | ✅ | `cli.test.ts:255-271` (agente + skill del motor), `273-282` (skill de preset, manifiesto y `doctor` verde) |
| 28 | CLI: purge/restore | ✅ | `cli.test.ts:286-304` (purge sin `--yes` falla, `--dry-run` no borra, snapshot, `backups`, restore) |
| 29 | CLI: install/repair dry-run | ✅ | `cli.test.ts:243-251` (no restaura el archivo borrado) |
| 30 | Coupling gate | ✅ | `coupling.test.ts:23-52` (términos de dominio), `54-69` (prefijo legacy), `71-79` (docs + `verify.sh` sin OpenSpec), `81-89` (17 skills) |

**Resultado de la checklist: 30/30 áreas con al menos un test.** La única sub-área parcial es `--dry-run` en `add`/`uninstall` (implementado, sin test; §5).

---

## 3. Trazabilidad por spec

Leyenda: ✅ cubierto; ⚠️ parcial (hay test, pero un escenario o variante no se ejerce); ❌ sin test.

### 3.1 `agent-guardrails` (4 requisitos)

| Requisito | Estado | Evidencia / nota |
|---|---|---|
| Preflight autoritativo en todas las superficies | ✅ | `guards.test.ts:231-249` (Hermes/Claude/OpenCode), `300-330`; negaciones nombran salida en `105-184` |
| Fail-open y configurable por proyecto | ✅ | shadow/fail-open `194-229`; opt-out de trunk `155-165`; `doctor` reporta opt-outs `cli.test.ts:215-224`; sin `.git` se prueba con builder que lanza (`209-220`) |
| Sin conocimiento específico de proyecto | ✅ | `coupling.test.ts:23-52`; preset como datos `guards.test.ts:92-101` |
| Reaper compone con hooks de Git | ⚠️ | `reaper.test.ts:18-61` cubre keep/ask/remove; `cli.test.ts:169-175` comprueba el texto del hook. No hay test de `worktrees reap --auto` ni de procedencia por marcador/ruta |

### 3.2 `dev-cli` (5 requisitos)

| Requisito | Estado | Evidencia / nota |
|---|---|---|
| Sync multi-target idempotente | ✅ | idempotencia `sync.test.ts:60-65`; cinco targets `31-41`/`83-92`; lock con `generatorVersion` y hashes `43-58`; v1→v2 `105-120`; drift `150-195` |
| Manifest v2 y validación | ⚠️ | roles/unknown preset/unknown target `manifest.test.ts:65-81`; stale vía `doctor` `cli.test.ts:226-233`. No se prueba rechazo de `commands`/`labels` del proyecto ni binding/lane ausente |
| Diagnóstico, backup y restore | ✅ | `doctor` `cli.test.ts:179-191`; opt-outs `215-224`; purge/restore/backups `286-304`; repair `235-241`; uninstall con backup (código) y `doctor` verde `273-282`; `upgrade --dry-run` `202-213`. El camino real de `upgrade` (re-sync + overrides) no se ejerce (residual §5) |
| Onboarding universal | ⚠️ | init sin `--yes` `78-88`; plan aplicado `90-100`; preset explícito gana `102-107`; base en repositorio vacío `137-143` (con `--preset`). No se prueba el fallback automático a `base` sin `--preset` |
| Descubrimiento de comandos | ✅ | help con lista literal `40-69`; desconocido/no args exit 2 `71-74`; `purge` exige confirmación `291`; `--dry-run` en init/install/repair/sync/purge/restore/upgrade. `add`/`uninstall` lo implementan pero no tienen test (residual §5) |

### 3.3 `harness-memory` (4 requisitos)

| Requisito | Estado | Evidencia / nota |
|---|---|---|
| Estado en `.planning` | ✅ | `state.test.ts:25-64`; `cli.test.ts:90-100` (creación) y `156-167` (migración). No se afirma que el archivo legacy quede intacto ni el backup |
| Ledger cerrado y redactado | ✅ | `ledger.test.ts:26-46`, `76-82` |
| Resume desde disco | ⚠️ | `ledger.test.ts:84-97`; `cli.test.ts:308-321`. No hay clon limpio literal ni lectura del `tasks.md` del proyecto al reanudar (`resumeLedger` usa solo `state.json`) |
| Decisiones durables | ✅ | `ledger.test.ts:57-74` (`changeId`, `queryLedger` por cambio y sesión, negativo); `cli.test.ts:312-318` (`memory list --change`) |

### 3.4 `preset-system` (6 requisitos)

| Requisito | Estado | Evidencia / nota |
|---|---|---|
| Presets declarativos y heredables | ✅ | herencia/override `manifest.test.ts:119-126`; preset inválido `128-137` (`commands.deploy` desconocido, nombra `commands`). La variante “comando no textual” no se ejerce |
| Selección determinista | ⚠️ | `--preset` gana `cli.test.ts:102-107`; detección `manifest.test.ts:147-182`; empate unitario `163-171`. No se prueba que `init` reporte el empate y exija `--preset` antes de escribir; precedencia del `preset` de `.ai-hubrc.json` tampoco |
| Manifest separa motor y proyecto | ⚠️ | rechazo de `roles` `manifest.test.ts:65-69`; invariantes en `doctor` `cli.test.ts:183-189`. Falta rechazo de `commands`/`labels` del proyecto |
| Scaffolding una vez | ✅ | `cli.test.ts:145-154` (conserva edición, reporta colisión); `install` directo usa el mismo materializador |
| Targets declarativos | ⚠️ | registro y formas `targets.test.ts:6-26`; `sync.test.ts:83-92`. No se prueba que añadir un target sea solo datos |
| Motor sin presets ni dominio | ✅ | `coupling.test.ts:23-52`; `cli.test.ts:137-143` (base sin skills de lenguaje) |

### 3.5 `spec-kit-pipeline` (3 requisitos)

| Requisito | Estado | Evidencia / nota |
|---|---|---|
| Spec Kit es la única metodología | ✅ | `coupling.test.ts:23-69` (término `openspec` en `core/src`/skills/agentes/presets; prefijo legacy), `cli.test.ts:40-69` (catálogo sin comandos legacy) |
| 17 comandos como skills nativas | ✅ | mapeo `speckit-*` + artifacts/estados terminales `manifest.test.ts:34-45`; existencia vía `doctor` `cli.test.ts:183-189`; autosuficiencia: el escaneo de `openspec` cubre `core/skills` (`coupling.test.ts:27-34`) |
| Fuente única de verdad | ⚠️ | `coupling.test.ts:71-79` verifica que `AGENTS.md`, `README.md` y `rules/core.md` contienen “Spec Kit”, no usan `/opsx`, y que `bootstrap/verify.sh` no contiene “openspec”. No se ejecuta `verify.sh` ni se afirma la coherencia de los 17 comandos/3 carriles |

---

## 4. Requisitos sin cobertura

**Ninguno a nivel de requisito.** Los 22 requisitos de las 5 specs tienen al menos un test directo:

- `agent-guardrails`: 4/4.
- `dev-cli`: 5/5.
- `harness-memory`: 4/4.
- `preset-system`: 6/6.
- `spec-kit-pipeline`: 3/3.

**No hay bloqueantes.** La suite pasa completa y las áreas que motivaron el informe anterior quedaron cubiertas: preset inválido, opt-outs en `doctor`, `upgrade`/`backups` por CLI, `--dry-run` en los comandos principales, `generatorVersion`/hashes del lock, `changeId` + consulta, artifacts/estados terminales, documentación/`verify.sh` sin OpenSpec, help hardcodeado y `buildGuardContext` con git real.

---

## 5. Residuales no bloqueantes

Se documentan para el siguiente cambio; ninguno invalida la evidencia de los requisitos.

| # | Residual | Evidencia | Impacto / clasificación |
|---|---|---|---|
| 1 | `add --dry-run` y `uninstall --dry-run` no tienen test | Búsqueda en `core/tests`: solo hay `--dry-run` para init (111-112), sync/upgrade (206-212), install/repair (247-250), purge (292), restore (300). `maintenance.ts:91-94` y `145-148` implementan ambos | No bloqueante: la cláusula “todo comando mutante soporta `--dry-run`” ya se ejerce en 7 comandos y la implementación es un `return` temprano. Añadir dos tests de una línea cierra la variante |
| 2 | `restore --dry-run` se invoca pero no se afirma que no escriba | `cli.test.ts:300-303`: se llama al dry-run y luego al restore real; el estado final no distingue si el dry-run escribió | No bloqueante: `maintenance.ts:211-219` retorna antes de `restoreBackup`. El test es débil, no incorrecto |
| 3 | `upgrade` real no se ejerce | `cli.test.ts:210-212` solo prueba `upgrade --dry-run`; el camino `runSync(...)` + preservación de overrides (`maintenance.ts:278`) no tiene test | No bloqueante: `runSync` está cubierto por 21 tests; el riesgo se limita al wiring del comando |
| 4 | Empate a nivel de plan/CLI | `manifest.test.ts:163-171` prueba `chooseDetection`; el throw de `resolveSelection` no se ejerce | No bloqueante: la unidad de decisión está cubierta; el camino `init` ambigua → error es un guard de tres líneas. Es el residual más cercano a bloqueante |
| 5 | Preset inválido: variante “comando no textual” | `manifest.test.ts:128-137` prueba campo desconocido (`commands.deploy`), no un valor no string | No bloqueante: el escenario “campo desconocido o comando no textual” tiene una de sus dos ramas cubierta |
| 6 | `ship` con cambios sin commit / merge; trunk `closed`/`open` explícitos | `guards.test.ts:167-184` cubre `ahead > 0`; no `dirty` ni merge. `trunkIsClosed` cubre `auto`+CI y opt-out, no `policy.trunk: 'closed'/'open'` | No bloqueante: las ramas principales están cubiertas; añadir dos casos a la tabla unitaria es barato |
| 7 | Reaper: procedencia y `reap --auto` | `reaper.test.ts:18-61` construye `WorktreeFacts` a mano; `collectWorktreeFacts`/marcador `.ai-hub-worktree`/`--auto` sin test | No bloqueante para este cambio: el reaper puro está cubierto; la integración con Git queda como riesgo |
| 8 | `resume` no lee el `tasks.md` del proyecto; no hay clon limpio literal | `ledger.test.ts:84-97` usa `state.json` con `tasks` ya calculadas | No bloqueante: el requisito “reconstruye desde disco” se cumple vía `state.json`; el escenario de tareas pendientes desde el task file no |
| 9 | Target data-only y precedencia del `preset` de `.ai-hubrc.json` | `targets.test.ts` es estructural; `cli.test.ts:102-107` prueba `--preset`, no el rc | No bloqueante: comportamientos secundarios del selector |
| 10 | `doctor` con hook ausente/preset inválido/target inválido; `.gitignore` sin `.worktrees/` | `cli.test.ts` solo prueba inventario obsoleto (226-233) y opt-outs (215-224) | No bloqueante: `doctor` tiene cobertura de contrato; faltan ramas de fallo |
| 11 | Golden tests de `manifest.json` y del plan | No existen fixtures golden; `cli.test.ts:109-115` prueba determinismo, no un golden | No bloqueante: el inventario se compara contra su generación (`checkInventory`) y el plan es determinista |
| 12 | `tasks.md` a 0/58 | `tasks.md`: 0 `[x]`, 58 `[ ]`; `.planning/state.json`: `done: 0` | No bloqueante para el veredicto de tests, pero **impide certificar la trazabilidad de tareas**. Debe actualizarse al cerrar el cambio |

---

## 6. Tests débiles o mejorables

- **`manifest.test.ts:90-94`:** el test “detects a stale manifest.json” afirma `result.ok === true`; comprueba que el inventario está fresco, no que detecte obsolescencia. El caso stale real está en `cli.test.ts:226-233`. Renombrar o invertir el fixture.
- **`cli.test.ts:300-303`:** `restore --dry-run` no afirma ausencia de escritura (ver residual 2).
- **`sync.test.ts:43-58`:** los hashes se validan por formato (`/^[a-f0-9]{64}$/`). El hash de salida se prueba por comportamiento en `171-177` (hand-edited), pero el de fuente no se recalcula; un valor aleatorio de 64 hex pasaría.
- **`targets.test.ts:6-15`:** comprueba campos truthy del registro; aceptable para un requisito declarativo, pero no demuestra que el renderer no ramifique por nombre.
- **Tabla de danger:** cubre 20 comandos, pero no `danger:power-state`, `danger:disk-partition` ni `danger:npm-token-leak`.
- **`sync.test.ts:190-195`:** skipped en Windows; no es cobertura de symlinks en este entorno.
- **`manifest.test.ts:9`:** `EXPECTED_COUNTS` se importa y no se usa. Higiene, no cobertura.
- **`buildGuardContext`:** el test de integración (`guards.test.ts:262-298`) crea un repo real con `.planning/trunk.json`, CI y el worktree principal; no crea un segundo worktree ni ejerce el guard de branch a través del builder. Cubre el builder, no la cadena completa builder → preflight → deny.

---

## 7. OpenSpec y contenido de dominio en los tests

- **Runtime (`core/src`):** el gate incluye `openspec` (`core/engine/coupling.json`) y escanea `core/src`, `core/skills`, `core/agents` y los presets `base`, `generic-ts`, `python`. Pasa.
- **Tests:** persisten dos fixtures que crean rutas `openspec/` para probar la migración obligatoria:
  - `state.test.ts:45-64` (`migrateLegacyState`).
  - `cli.test.ts:156-167` (`init --migrate`).

  Son la única referencia a OpenSpec en tests y están justificadas por `harness-memory` R1/S2. Si la regla se interpreta literalmente, conviene centralizar el fixture en `fixtures.ts` con nombre `LEGACY_*` y comentario histórico. No se debe borrar: la migración es un escenario normativo.
- **Contenido de dominio:** `manifest.test.ts:119-161` y `cli.test.ts:127-135` nombran Angular/`angular-express` para probar herencia y detección. No introduce política de dominio en el motor. No hay referencias a Dolibarr, Doligestión ni Onna en tests.
- **Excepción del gate:** `core/engine/legacy-paths.json` contiene `openspec/state.json` y `openspec/changes` como datos, fuera del escaneo. Es coherente con la migración; documentarlo evita que parezca una fuga.

---

## 8. Trazabilidad de tareas

`tasks.md` tiene **58 tareas y 0 marcadas `[x]`**; `.planning/state.json` declara `tasks: { total: 58, done: 0 }`. El archivo exige marcar una tarea solo cuando su criterio de verificación se cumple y queda registrado. Por tanto la trazabilidad de **tareas** no está cerrada, aunque la de **requisitos → tests** sí. Se clasifica como no bloqueante para el veredicto de tests, pero debe corregirse antes de archivar el cambio.

---

## 9. Veredicto final

**PASS.**

- **Bloqueantes:** ninguno.
- **Requisitos sin cobertura:** ninguno (22/22 con al menos un test directo).
- **Residuales no bloqueantes:** 12, listados en §5. Los más relevantes son el empate a nivel de CLI, `add`/`uninstall --dry-run`, el camino real de `upgrade` y la afirmación de no-escritura en `restore --dry-run`.
- **Ejecución:** `npm --prefix core test` → exit 0; 140 passed / 1 skipped; el skipped es el test de symlinks en Windows y no cubre un escenario obligatorio de la spec.
- **Trazabilidad de tareas:** pendiente (0/58), no bloqueante para este veredicto.

**Recomendación para el siguiente cambio:** añadir los dos tests de `add`/`uninstall --dry-run`, un test de `init` con empate real (dos presets con igual puntuación) que afirme error y cero escrituras, y un test de `upgrade` sin `--dry-run` que verifique re-sync y preservación de overrides. Ninguno es necesario para aprobar la cobertura actual; los tres cierran las variantes más expuestas.
