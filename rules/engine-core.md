# Core rules — AI Hub engine

> Fuente de verdad del proyecto: `manifest.yaml` · Contrato del motor: `core/engine/engine.yaml`
> Versión del motor: 2.0

---

## Identidad

`ai-hub` es una fábrica de software multi-proyecto. El motor no contiene conocimiento de un stack concreto: ese conocimiento vive en `core/presets/<stack>/` y se materializa una sola vez en `.ai-hub/` cuando el proyecto ejecuta `ai-hub init`.

| Capa | Ruta | Quién la edita |
|---|---|---|
| Motor | `core/src/`, `core/engine/` | Mantenedores del CLI |
| Preset | `core/presets/<id>/` | Mantenedores del preset |
| Proyecto | `.ai-hub/`, `manifest.yaml`, `.ai-hubrc.json` | Equipo del proyecto |

---

## Startup Protocol

Al iniciar una sesión, el orquestador ejecuta sin pedir comandos al usuario:

```bash
npm run ai:build
node core/dist/bin/ai-hub.js context
node core/dist/bin/ai-hub.js doctor
node core/dist/bin/ai-hub.js drift
```

Después lee `.planning/context-next.md` y `.planning/state.json`, y reporta:

- proyecto, preset y targets;
- cambio activo, fase y tareas pendientes;
- resultado de `doctor` y `drift`;
- siguiente paso recomendado.

Si `doctor` falla, no se implementa nada hasta resolverlo.

---

## Metodología activa: Spec Kit

Spec Kit es la única metodología de runtime. Son **17 comandos en 3 carriles**:

| Carril | Comandos | Artefactos |
|---|---|---|
| Assessment (5) | `assess-intake`, `assess-research`, `assess-define`, `assess-shape`, `assess-decide` | `.specify/assessments/<slug>/*.md` |
| Feature SDD (9) | `constitution`, `specify`, `clarify`, `plan`, `checklist`, `tasks`, `analyze`, `implement`, `converge` | `.specify/memory/constitution.md`, `specs/<feature>/*.md` |
| Bug Fix (3) | `bug-assess`, `bug-fix`, `bug-test` | `.specify/bugs/<slug>/*.md` |

Estados terminales: **GO / KILL / NEEDS_CLARIFICATION** en Assessment; **CONVERGED / NEEDS_WORK** en Feature; **VERIFIED / PARTIAL / FAILED** en Bug Fix.

### Puerta humana

`ai::spec-ready` nunca se auto-aprueba. El publisher calcula el SHA-256 de `spec.md + plan.md + tasks.md` con rutas ordenadas, separador `/`, LF y sin BOM. Un humano autorizado aprueba ese hash; cualquier cambio posterior invalida la aprobación.

### Etiquetas GitLab

`ai::todo`, `ai::in-spec`, `ai::spec-ready`, `ai::in-dev`, `ai::in-review`, `ai::done`, `ai::blocked`.

Un cambio de etiqueta emite un evento; no ejecuta un agente por sí mismo.

---

## Reglas críticas del motor

| Regla | Descripción |
|---|---|
| Zero-Any | Prohibido `any` en TypeScript; usar `unknown` con type guards |
| Sin NgModule | Componentes standalone y APIs modernas del framework |
| Sin inyección por constructor | `inject()` a nivel de clase |
| Sin directivas legacy | `@if`, `@for`, `@switch` |
| Composición sobre herencia | Los DALs componen clientes, no heredan del transporte |
| Sin TODOs | Código completo, sin placeholders ni `FIXME` |
| Sin emojis en código | Ni en logs ni en UI |
| Sin secretos | `.env` y credenciales nunca se versionan |
| Sin implementar sin spec | Flujo Spec Kit completo antes de tocar código |

Estas reglas son del motor y aplican a cualquier preset. Las reglas de dominio viven en `.ai-hub/rules/` y pueden añadir restricciones, nunca quitar las del motor.

---

## Flujo de trabajo

```text
Assessment ──GO──> Feature SDD ──CONVERGED──> ai::in-review ──PASS──> ai::done
      │                  │
      └──KILL──> archivo └──NEEDS_WORK──> implement / specify
```

1. `ai-hub init` (una vez) o `ai-hub install` tras actualizar el preset.
2. El agente explora y el `spec-author` escribe `spec.md`, `plan.md`, `tasks.md`.
3. Un humano aprueba `ai::spec-ready` con el hash.
4. Los implementers trabajan en rama o worktree y verifican cada tarea.
5. Los reviewers emiten `PASS` / `NEEDS_FIX` / `BLOCKED`.
6. `converge` demuestra que cada requisito tiene código y test.
7. Se archiva el cambio y se actualiza `.planning/history.md`.

---

## Agentes

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
| Refuter | refuter | — (read-only) | Todo | REFUTED / NOT-REFUTED |

Los dos roles derivados los ejerce el orquestador; no tienen archivo propio.

**Panel de refutación.** Entre `CONVERGED` y `ai::in-review` está disponible un panel
adversarial: tres lentes (`refuter-correctness`, `refuter-security`, `refuter-tests`) más
`finding-verifier`. Lo despacha quien orquesta la revisión; cada lente recibe exactamente
los cuatro inputs del contrato (contrato de tarea con cambios aprobados, spec aprobado,
estado exacto del fuente, punto de entrada) y nunca la conversación ni la defensa del
builder. El veredicto del panel es `REFUTED` (al menos un blocker o should-fix sobrevive
como `CONFIRMED`) o `NOT-REFUTED` (nada sobrevive — no es una aprobación); por hallazgo,
el verifier emite `CONFIRMED`, `REFUTED` o `UNPROVEN`, y sólo `CONFIRMED` puede bloquear.
El panel no mueve etiquetas ni aprueba nada: su veredicto es insumo para quien orquesta.

---

## Handoff en disco

Los agentes no se pasan contexto por chat. Escriben en `.planning/`:

`findings.md` → `impl_<name>.md` → `review_arch_<name>.md` / `review_tests_<name>.md` → `history.md`.

`.planning/state.json` guarda el cambio activo, fase y conteo de tareas. `.planning/memory.jsonl` guarda decisiones y checkpoints con esquema cerrado; nunca prompts, contenido de archivos ni secretos.

---

## Comandos del CLI

`init`, `install`, `add`, `list`, `sync`, `drift`, `doctor`, `check`, `backups`, `restore`, `uninstall`, `purge`, `upgrade`, `repair`, `worktrees`, `trunk`, `memory`, `context`.

- `sync` escribe; `drift` solo informa.
- `purge` y `uninstall` crean backup antes de borrar.
- `doctor` sale con 1 si falla cualquier comprobación.
- `verify` y `judge` se mantienen como compatibilidad, fuera del catálogo.

---

## Bloqueos

Ante un fallo:

1. mover la issue a `ai::blocked` o proponerlo;
2. comentar motivo, job y evidencia;
3. registrar el bloqueo en `.planning/current.md`;
4. esperar decisión humana.

Un fallo técnico no cambia el estado por sí solo; lo clasifica la máquina de estados.

---

## Referencias

- `manifest.yaml` — configuración del proyecto.
- `core/engine/engine.yaml` — invariantes del motor.
- `core/presets/` — presets disponibles.
- `AGENTS.md` — constitución del repositorio.
- `README.md` — uso del CLI.
