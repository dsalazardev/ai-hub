# AGENTS.md — AI Hub: fábrica de software multi-proyecto

> **Fuente única de verdad operativa del repositorio.**
> Todo agente debe leerlo completo antes de ejecutar comandos, editar archivos o abrir una sesión.
> Identificadores, comandos y rutas en inglés; explicaciones en español.
> **Autor de la plataforma:** Daner Alejandro Salazar Colorado.

---

## 1. Precedencia normativa

| Nivel | Fuente | Uso |
|---|---|---|
| 1 | Instrucción explícita del usuario en la sesión | Manda sobre todo salvo secretos o seguridad |
| 2 | `AGENTS.md` (este archivo) | Contrato operativo |
| 3 | `manifest.yaml` | Configuración del proyecto: preset, stack, comandos, paths, targets, policy |
| 4 | `core/engine/engine.yaml` | Invariantes del motor: 8 roles, 17 comandos, 7 etiquetas |
| 5 | `rules/core.md`, `orchestrator/`, `README.md` | Convenciones y material descriptivo |

Si dos fuentes discrepan, se aplica el nivel superior, se registra el conflicto en `.planning/findings.md` y no se resuelve en silencio.

---

## 2. Arquitectura del motor

`ai-hub` es una DevTool universal, no un arnés de un proyecto concreto. Se compone de tres capas:

| Capa | Ruta | Contenido | Editable por el proyecto |
|---|---|---|---|
| Motor | `core/src/`, `core/engine/`, `core/agents/`, `core/skills/shared/` | Rutas, CLI, sync, guardias, memoria, 17 skills Spec Kit | No |
| Preset | `core/presets/<id>/` | Detección, stack, comandos, reglas, agentes y skills de dominio | No (se elige) |
| Proyecto | `.ai-hub/`, `manifest.yaml`, `.ai-hubrc.json` | Copia del preset, overrides, targets y política | Sí |

El motor no contiene nombres de lenguajes, frameworks, empresas ni módulos. Esa información vive en los presets y en `.ai-hub/`.

### Componentes

| Componente | Responsabilidad |
|---|---|
| `ai-hub init` / `install` | Detectar el repo, elegir preset, imprimir plan y materializar `.ai-hub/` |
| `ai-hub sync` / `drift` | Proyectar reglas, agentes y skills a Claude, OpenCode, Pi, Cursor y Copilot |
| `ai-hub doctor` | Validar motor, preset, manifiesto, targets, hooks y deriva |
| `ai-hub check` | Alias de `doctor`; no ejecuta `drift` |
| `harness/guards` | `runPreflight` puro: danger, trunk, branch y ship |
| `harness/worktree` | Reaper conservador de worktrees |
| `harness/memory` | `.planning/state.json` y ledger JSONL |
| `hermes-control` | Plano de control event-driven (fuera de alcance de este repo) |

### Dos ambientes, una frontera

Este repositorio es el **ambiente de desarrollo**. Un repositorio consumidor es el **ambiente de instalación**. Las carpetas se parecen; el contrato no.

| | Ambiente de desarrollo (este repo) | Ambiente de instalación (consumidor) |
|---|---|---|
| Naturaleza | Taller: compila, prueba y publica el motor | Fábrica instalada: opera el producto |
| `.ai-hub/` | No existe | **Obligatoria**, siempre |
| Metodología | La del mantenedor: OpenSpec | Spec Kit, única de runtime |
| `openspec/`, `.planning/`, `.github/` | Artefactos del taller; gitignoreados | No existen, salvo `.github/workflows` |
| `.claude/`, `.opencode/`, `.pi/`, `.codex/` | Herramientas del taller, con lo que el mantenedor necesite | Salida generada por `sync`, sólo en los `targets` elegidos |
| `sync`, `install`, `upgrade` | Se niegan a escribir sin `--force` | Escriben los destinos del consumidor |
| `drift`, `sync --check-lock` | No aplican: no hay destinos que comparar | Deben estar en verde |

**Reglas:**

1. `runSync` aborta si `root` es el checkout del motor (`core/package.json` + `core/src/paths.ts`). `--force` existe sólo para dogfooding deliberado.
2. El gate de artefactos legacy escanea el catálogo publicado (`core/presets`, `core/skills`, `core/agents`) en el motor, y todos los destinos en el consumidor. Nunca el taller.
3. `.ai-hub/` es obligatoria en la instalación; los destinos de agente son opcionales y se eligen con `targets`.
4. El catálogo publicado no puede describir un flujo SDD paralelo ni depender de `openspec`.
5. Lo que el mantenedor use para desarrollar —OpenSpec, `.planning/`, `.github/`— no viaja en el paquete ni se proyecta al consumidor.

El consumidor no es un usuario local: es una **fábrica de software autónoma**, operable en remoto —incluso desde un dispositivo móvil— sobre un host con el arnés instalado. De ahí que la instalación tenga que ser reproducible por `npx`/`pnpm`, sin pasos manuales ni estado oculto en el checkout.

---

## 3. Metodología activa: Spec Kit

**Spec Kit es la única metodología de runtime.** Son 17 comandos en 3 carriles:

| Carril | Comandos | Artefactos |
|---|---|---|
| Assessment (5) | `/speckit-assess-intake`, `-research`, `-define`, `-shape`, `-decide` | `.specify/assessments/<slug>/*.md` |
| Feature SDD (9) | `/speckit.constitution`, `specify`, `clarify`, `plan`, `checklist`, `tasks`, `analyze`, `implement`, `converge` | `.specify/memory/constitution.md`, `specs/<feature>/*.md` |
| Bug Fix (3) | `/speckit-bug-assess`, `bug-fix`, `bug-test` | `.specify/bugs/<slug>/*.md` |

Salidas terminales: **GO / KILL / NEEDS_CLARIFICATION**, **CONVERGED / NEEDS_WORK**, **VERIFIED / PARTIAL / FAILED**.

OpenSpec no forma parte del runtime. El directorio `openspec/` de este repositorio es un archivo histórico de cambios y no se lee, escribe ni proyecta.

---

## 4. Matriz de roles

`manifest.yaml` elige el preset; `core/engine/engine.yaml` define los roles. Los scopes concretos se resuelven contra `paths` del proyecto.

| Rol | Canonical | Puede escribir | No puede escribir | Gate |
|---|---|---|---|---|
| Prompt-Explorer | orchestrator (derivado) | — | Todo | — |
| Spec-Explorer | explorer-domain | `.planning/findings.md`, `.specify/assessments/**` | Código | — |
| Reviewer-Exploration | orchestrator (derivado) | — | Todo | convergencia ≥ 95 % |
| Spec-Author | spec-author | `.specify/**`, `specs/**`, `.planning/**` | Código | spec sin preguntas abiertas |
| Implementer-Frontend | implementer-frontend | Frontend del proyecto | Backend | build + tests |
| Implementer-Backend | implementer-backend | Backend del proyecto | Frontend | typecheck + tests |
| Reviewer-Architecture | reviewer-architecture | `.planning/review_arch_*.md` | Código | PASS / NEEDS_FIX / BLOCKED |
| Reviewer-Tests | reviewer-tests | `.planning/review_tests_*.md` | Código | cobertura declarada |

### Prohibiciones

1. Un reviewer no escribe código, tests ni configuración.
2. Un implementer no cruza la frontera frontend/backend.
3. `Spec-Author` no implementa.
4. Nadie aprueba su propio trabajo ni mueve `ai::spec-ready`.
5. No se permiten `TODO`, `FIXME` ni placeholders.
6. El motor no contiene términos de dominio; el gate `doctor` lo comprueba.

---

## 5. Puerta humana y hash

`ai::spec-ready` nunca se auto-aprueba.

1. `Spec-Author` termina `spec.md`, `plan.md` y `tasks.md`.
2. El publisher calcula el SHA-256 del conjunto aprobable.
3. Publica y notifica con `iid + hash`.
4. Un humano autorizado aprueba.
5. `hermes-control` revalida identidad, issue, estado y hash.
6. Solo entonces se mueve a `ai::in-dev`.

**Canonicalización:** rutas relativas ordenadas, separador `/`, contenido normalizado a LF, sin BOM; por archivo `ruta + "\n" + bytes`; SHA-256 sobre la secuencia.

Cualquier cambio posterior invalida la aprobación. Un hash que no coincide se rechaza (fail-closed).

---

## 6. Resolución de rutas y configuración

`resolveAiHubDir()` es la única forma de localizar el arnés. Orden:

1. `AI_HUB_DIR`
2. `dir` de `.ai-hubrc.json`
3. `./.ai-hub`
4. `./ai-hub`
5. ancestro más cercano con `manifest.yaml`

`.ai-hubrc.json` v2:

```json
{
  "version": 2,
  "dir": ".",
  "preset": "generic-ts",
  "targets": ["claude", "opencode", "pi", "cursor", "copilot"],
  "guardMode": "shadow"
}
```

Un `.ai-hubrc.json` v1 se lee y se migra; una fuente explícita que no contiene `manifest.yaml` falla en vez de continuar.

MCP es del consumidor: `mcp-manifest.yaml` en la raíz es la única fuente. Los presets no declaran `mcp.source`; sin ese archivo, `doctor` reporta `MCP: no configurado` y no se generan `.mcp.json`, `.cursor/mcp.json` ni `.vscode/mcp.json`.

---

## 7. Persistencia obligatoria (solo taller)

`.planning/` pertenece al checkout de desarrollo. Una instalación no lo crea; `init --migrate` sale 2 y `memory`/`context` salen 0 con `no aplica en instalación`. El chat no es un almacén. En el taller, todo estado va a `.planning/`:

| Archivo | Contenido |
|---|---|
| `.planning/state.json` | Proyecto, preset, cambio activo, fase y conteo de tareas |
| `.planning/findings.md` | Hallazgos verificables |
| `.planning/impl_<name>.md` | Cambios, pruebas y desviaciones |
| `.planning/review_arch_<name>.md` | Revisión de arquitectura |
| `.planning/review_tests_<name>.md` | Cobertura y veredicto |
| `.planning/current.md` | Estado de la sesión |
| `.planning/memory.jsonl` | Ledger cerrado: eventos y decisiones |
| `.planning/history.md` | Decisiones, conflictos y cierres |

El ledger nunca escribe prompts, respuestas, contenido de archivos, tokens ni variables de entorno.

---

## 8. Guardias

`runPreflight(command, ctx)` es puro: no importa `node:fs`, `node:child_process` ni `node:net`. Devuelve `decision`, `rule` y `reason`.

- **danger**: borrado recursivo forzado, `mkfs`, escritura en dispositivo, fork bomb, push forzado, reset duro, SQL destructivo, pipe-to-shell.
- **trunk**: cierra la rama principal con señales de CI, despliegue o equipo, o por política explícita.
- **branch**: bloquea cambiar a una rama ocupada por otro worktree.
- **ship**: bloquea volver a la trunk con cambios sin commit o commits sin push.

El runner de Hermes es autoritativo; los hooks locales son adaptadores finos. `guardMode` es `shadow` por defecto y `enforce` opt-in. Un adaptador que no puede construir el contexto falla abierto.

---

## 9. Bloqueos y secretos

Ante un fallo: mover a `ai::blocked` o proponerlo, comentar motivo y evidencia, registrar en `.planning/current.md` y esperar decisión humana.

`.env` y credenciales nunca se versionan. El PAT de GitLab se inyecta por entorno (`GITLAB_TOKEN`); nunca se escribe en artefactos, comentarios ni logs.

---

## 10. Checklist de cumplimiento

- [ ] Leí `AGENTS.md` completo y apliqué la precedencia.
- [ ] Registré hallazgos, cambios y revisiones en `.planning/`.
- [ ] Usé `resolveAiHubDir()` y no hardcodeé `.ai-hub/`.
- [ ] Respeté el scope de mi rol y el `paths` del proyecto.
- [ ] No aprobé mi propio trabajo ni moví `ai::spec-ready`.
- [ ] Dejé la issue en el estado correcto o en `ai::blocked` con motivo y evidencia.
- [ ] No introduje términos de dominio en `core/src/`.
- [ ] `ai-hub doctor` y `ai-hub drift` están en verde.
