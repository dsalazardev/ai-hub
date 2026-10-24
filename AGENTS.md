# AGENTS.md — AI-HUB: Autonomous Software Factory

> **Este archivo es la fuente única de verdad (SSOT) para operar en este repositorio.**
> Todo agente (humano o IA) **MUST** leerlo completo antes de ejecutar cualquier comando, editar cualquier archivo o abrir una sesión de trabajo. Un agente que no lo haya leído se considera no conforme y sus cambios pueden ser rechazados.

**Alcance:** repositorio `ai-hub`. Aplica a Claude Code, OpenCode, Pi y cualquier herramienta que opere sobre este checkout.
**Naturaleza:** política y contrato operativo. No es un mecanismo de enforcement en tiempo de ejecución; el cumplimiento técnico corresponde a `hermes-control` (ver §2), que todavía no está implementado.
**Idioma:** identificadores, comandos, rutas y etiquetas en inglés; explicaciones en español.

---

## 1. Orden de precedencia y fuentes de referencia

### 1.1 Precedencia normativa

Cuando dos documentos discrepen, se aplica el nivel superior. Un nivel inferior puede aportar detalle, pero **MUST NOT** contradecir al superior:

| Nivel | Fuente | Uso |
|---|---|---|
| 1 | Instrucción explícita del usuario en la sesión actual | Manda sobre todo lo demás, salvo secretos o seguridad |
| 2 | **`AGENTS.md`** (este archivo) | Contrato operativo y de gobierno |
| 3 | `manifest.yaml` | Registro canónico de agentes, skills y scopes de escritura |
| 4 | `rules/core.md`, `orchestrator/*.md`, `architecture/` | Convenciones técnicas, estados y topología |
| 5 | `README.md` y copias generadas (`.claude/`, `.opencode/`, `.pi/`) | Material descriptivo o derivado |

**Regla de conflicto:** si un agente detecta una contradicción, **MUST** detenerse, registrar el conflicto en `.planning/findings.md` (fuente A, fuente B, nivel aplicado) y continuar con el nivel superior. No se resuelve "en silencio" ni se elige la opción más cómoda.

### 1.2 Fuentes de referencia obligatorias

| Fuente | Ruta / URL | Para qué se usa |
|---|---|---|
| **rsc-harness** | `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\ESCRITORIO\PROYECTOS_INTERESANTES\rsc-harness` | Empaquetado, manifiesto único, sincronización con hashes, CLI instalable, aislamiento por worktree, guards/hooks |
| **REPO-BETTATECH** | `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\ESCRITORIO\REPO-BETTATECH` | Estándares de arquitectura, buenas prácticas y patrones de integración |
| **Diagrama maestro (Lucidchart)** | https://lucid.app/lucidchart/939ef9b0-8a9c-425e-8a1a-7529e9232550/edit | Mapa visual de la fábrica: canales Spec Kit, `hermes-control`, `hermes-agent`, Kanban GitLab |
| **Vistas Mermaid** | `architecture/` — `master-agentic-architecture.mmd` y vistas `00`–`24` | Topología interna, estados, permisos, gates y modelo de datos |

### 1.3 Degradación elegante

- Si una ruta local no existe en la máquina actual, el agente **MUST** declarar la limitación en una línea y continuar sin esa fuente. **MUST NOT** inventar su contenido ni citarla como consultada.
- Si el diagrama de Lucid no es accesible, la fuente de respaldo es `architecture/master-agentic-architecture.mmd`.
- Si `architecture/` tampoco existe, se usa `README.md` como descripción de último recurso y se registra la carencia.

### 1.4 Límite de las referencias

El material de referencia inspira patrones; **MUST NOT** prevalecer sobre este archivo ni sobre `rules/core.md`. Copiar un patrón de `rsc-harness` o `REPO-BETTATECH` no autoriza a alterar los scopes de escritura, las etiquetas ni las puertas humanas definidas aquí.

---

## 2. Arquitectura objetivo: AI Hub Autonomous Software Factory

La fábrica convierte una issue de GitLab en un cambio de software verificado mediante tres carriles de especificación (Spec Kit), un plano de control event-driven y un gateway de mensajería para el humano.

### 2.1 `hermes-control` — plano de control interno

No es el gateway de mensajería. Recibe eventos, decide, despacha y publica evidencia.

| # | Componente | Responsabilidad |
|---|---|---|
| 1 | **GitLab Webhook Ingestion & HMAC** | Recibe eventos de issue y label change; verifica la firma HMAC; rechaza y audita los inválidos |
| 2 | **Deduplication & Event Router** | Clave `event_id + issue_iid + transición`; idempotencia; enruta por tipo (assessment, feature, bug) o descarta duplicados |
| 3 | **State Machine & Policy Engine** | Transiciones `ai::*` permitidas, precondiciones, autorización y niveles de autonomía **A0–A5** (matriz todavía pendiente de ratificación; por defecto no se supera **A3** sin aprobación humana) |
| 4 | **Prompt Compiler / Job Dispatcher** | Compone rol + Spec Kit + skills; versiona prompt y modelo; emite el job autorizado |
| 5 | **Job Queue — PostgreSQL `SKIP LOCKED`** | Dependencias, concurrencia, reintentos, timeout y recuperación de jobs interrumpidos; `SKIP LOCKED` es válido solo si el store es PostgreSQL |
| 6 | **Runner Coordinator** | Asigna un Git worktree aislado por job; paraleliza frontend/backend; aplica límites y presupuesto |
| 7 | **Evidence Collector & Publisher** | Reúne logs, tests, métricas y tiempos; los asocia a issue/job/artefacto; comenta y enlaza en GitLab |
| 8 | **Approvals & Audit** | Valida identidad y autorización; verifica el hash SHA-256; registra actor, decisión y motivo |

### 2.2 `hermes-agent` — gateway móvil

Interfaz humana. **No** es fuente de verdad, **no** ejecuta jobs y **no** sustituye a la máquina de estados.

| Elemento | Contenido |
|---|---|
| **Canales** | Telegram · Slack · Discord · WhatsApp |
| **Push** | `Spec Ready` (incluye SHA-256 de `spec.md + plan.md + tasks.md`) · `Job Blocked` · `Test Failures` · `PR Created` · `Issue Done` |
| **Pull** | `aprobar <iid> <hash>` · `cambios <iid>` · `status <iid>` · `mover <iid> a <columna>` |

Toda aprobación recibida por el gateway se revalida en `hermes-control` (identidad, autorización, issue, hash y estado actual). Si el contenido cambió, la aprobación queda inválida.

### 2.3 Tablero GitLab — siete etiquetas canónicas

| Etiqueta | Significado | Quién la mueve |
|---|---|---|
| `ai::todo` | Backlog; sin agente asignado | Humano |
| `ai::in-spec` | Exploración y autoría de spec | `hermes-control` al detectar el label change |
| `ai::spec-ready` | Spec completa; **espera aprobación humana** | Publisher, nunca el autor |
| `ai::in-dev` | Implementación autorizada | Solo tras aprobación válida |
| `ai::in-review` | Revisión de arquitectura y pruebas | Gates de calidad |
| `ai::done` | Merge/deploy verificado y cierre | Release + humano |
| `ai::blocked` | Bloqueo, fallo o dependencia sin resolver | Cualquier gate; requiere intervención |

**Regla:** un cambio de etiqueta **emite un evento**, no ejecuta un agente por sí mismo. El evento pasa por HMAC, deduplicación, máquina de estados y política antes de convertirse en job.

```text
GitLab (label change)
        |
        v
[HMAC] -> [Dedupe/Router] -> [State + Policy] -> [Prompt] -> [Queue]
                                                              |
                                                              v
                                                    [Runner / worktree]
                                                              |
                                              +---------------+---------------+
                                              v               v               v
                                        Assessment          Feature          Bug Fix
                                              |               |               |
                                              +---------------+---------------+
                                                              v
                                                    [Evidence + Publisher]
                                                              |
                                        +---------------------+---------------------+
                                        v                                           v
                                  GitLab (comment/label)                  hermes-agent (push)
                                                                                    |
                                                                          humano aprueba
```

---

## 3. Metodología activa: Spec Kit (17 comandos)

**Spec Kit es la única metodología activa** (`specify-cli`, estructura `.specify/`). OpenSpec se conserva **solo como referencia histórica** en `openspec/`; no se usa para trabajo nuevo salvo que un humano lo reabra explícitamente y lo registre en `.planning/history.md`.

### 3.1 Carril A — Idea Assessment (5 comandos)

| Comando | Propósito | Artefacto |
|---|---|---|
| `/speckit-assess-intake` | Captura y normaliza la idea | `intake.md` |
| `/speckit-assess-research` | Evidencia a favor/en contra y fuentes | `research.md` |
| `/speckit-assess-define` | Problema, usuarios, objetivos, métricas | `problem.md` |
| `/speckit-assess-shape` | Opciones de concepto, scope y appetite | `concept.md` |
| `/speckit-assess-decide` | Scorecard y decisión | `decision.md` |

Ruta: `.specify/assessments/<slug>/*.md`. Salidas terminales: **GO** (pasa a Feature SDD), **KILL** (archivar con justificación), **NEEDS_CLARIFICATION** (volver a `define`).

### 3.2 Carril B — Feature SDD Core (9 comandos)

| Comando | Propósito | Artefacto |
|---|---|---|
| `/speckit.constitution` | Principios, reglas y estándares | `constitution.md` |
| `/speckit.specify` | Requisitos EARS y escenarios | `spec.md` |
| `/speckit.clarify` | Resuelve ambigüedades de la spec | `spec.md` |
| `/speckit.plan` | Diseño técnico y enfoque | `plan.md` |
| `/speckit.checklist` | Gate de calidad y arquitectura | checklist |
| `/speckit.tasks` | Descomposición atómica y ordenada | `tasks.md` |
| `/speckit.analyze` | Consistencia, cobertura y trazabilidad | informe |
| `/speckit.implement` | Código y pruebas en worktree | `Codebase` |
| `/speckit.converge` | Verifica completitud frente a la spec | estado **CONVERGED** |

### 3.3 Carril C — Bug Fix (3 comandos)

| Comando | Propósito | Artefacto |
|---|---|---|
| `/speckit-bug-assess` | Diagnóstico **sin editar código** | `assessment.md` |
| `/speckit-bug-fix` | Reparación acotada | `fix.md` |
| `/speckit-bug-test` | Verificación y veredicto | `test.md` |

Veredictos: **VERIFIED** (pasa a revisión), **PARTIAL** (faltan evidencias o entorno), **FAILED** (nuevo diagnóstico).

### 3.4 Reglas de uso

- Total: **17 comandos** (5 + 9 + 3). No se inventan comandos ni se omiten pasos.
- `spec.md`, `plan.md` y `tasks.md` son la unidad aprobable (§5.1).
- `constitution.md` es transversal: se lee antes de `specify` y no se modifica sin aprobación humana.
- Los artefactos viven en `.specify/` o en `specs/<feature>/`, según el layout que `specify` haya inicializado; el agente **MUST NOT** mezclar ambos.
- OpenSpec (`openspec/`) es de solo lectura histórica: puede consultarse para contexto, nunca para iniciar un cambio nuevo.

---

## 4. Matriz de agentes y límites de escritura

`manifest.yaml` es la fuente canónica de scopes. La tabla es el resumen operativo y, ante duda, gana la restricción más estricta.

| Rol | Fuente canónica | Puede escribir | No puede escribir | Gate |
|---|---|---|---|---|
| **Prompt-Explorer** | Rol derivado (orquestador; sin archivo propio) | Nada (solo lectura) | Todo el repositorio | — |
| **Spec-Explorer** | `agents/explorer-domain.md` | `.planning/findings.md`, `.specify/assessments/**` | `frontend/**`, `backend/**` | — |
| **Reviewer-Exploration** | Rol derivado (orquestador + humano) | Nada | Todo el repositorio | Umbral de convergencia ≥ 95 %; si no, preguntas o `ai::blocked` |
| **Spec-Author** | `agents/spec-author.md` | `.specify/**`, `specs/**`, `.planning/**` | `frontend/**`, `backend/**` | Spec completa y sin preguntas abiertas |
| **Implementer-Frontend** | `agents/implementer-frontend.md` | `frontend/**` (incl. `frontend/src/app/**`) | `backend/**` | Build + tests del frontend |
| **Implementer-Backend** | `agents/implementer-backend.md` | `backend/**` (incl. `backend/src/services/**`) | `frontend/**` | `tsc --noEmit` + tests del backend |
| **Reviewer-Architecture** | `agents/reviewer-architecture.md` | `.planning/review_arch_*.md` | Todo el código fuente | PASS / NEEDS_FIX / BLOCKED |
| **Reviewer-Tests** | `agents/reviewer-tests.md` | `.planning/review_tests_*.md` | Todo el código fuente | Cobertura backend ≥ 70 %, frontend ≥ 60 % |

**Roles derivados.** `Prompt-Explorer` y `Reviewer-Exploration` no tienen archivo en `agents/`: los ejerce el orquestador. No se debe crear un agente nuevo para ellos sin un cambio aprobado.

### 4.1 Prohibiciones

1. Un reviewer **MUST NOT** escribir código, tests ni configuración; solo su archivo de revisión.
2. Un implementer **MUST NOT** cruzar la frontera frontend/backend.
3. `Spec-Author` **MUST NOT** implementar; su salida son artefactos de especificación.
4. Nadie **MUST NOT** aprobar su propio trabajo ni mover `ai::spec-ready` por sí mismo.
5. No se permiten `TODO`, `FIXME` ni placeholders en código de producción (ver `rules/core.md`).

### 4.2 Handoff en disco

Los agentes no se pasan contexto por chat. Escriben y leen archivos en `.planning/`:
`findings.md` → `impl_<name>.md` → `review_arch_<name>.md` / `review_tests_<name>.md` → `history.md`.

---

## 5. Contratos de seguridad, rutas y persistencia

### 5.1 Puerta humana en `ai::spec-ready`

`ai::spec-ready` **NUNCA** se auto-aprueba. El flujo es:

1. `Spec-Author` termina `spec.md`, `plan.md` y `tasks.md`.
2. El publisher calcula el hash **SHA-256** del conjunto aprobable.
3. Publica el artefacto y notifica por GitLab y `hermes-agent` con `iid + hash`.
4. Un humano autorizado aprueba explícitamente (`aprobar <iid> <hash>` o aprobación en GitLab).
5. `hermes-control` revalida identidad, autorización, issue, estado y hash.
6. Solo entonces se mueve a `ai::in-dev`.

**Conjunto aprobable:** exactamente `spec.md`, `plan.md` y `tasks.md` del cambio.

**Canonicalización del hash:**
- rutas relativas ordenadas lexicográficamente;
- separador `/`;
- contenido normalizado a **LF**;
- **sin BOM**;
- por cada archivo se concatena `ruta + "\n" + bytes`; el SHA-256 se calcula sobre esa secuencia.

**Registro de aprobación:** `issue_iid`, `change_id`, `hash`, `approver`, `timestamp`, `channel`.
**Invalidación:** cualquier cambio posterior en el conjunto invalida la aprobación y exige una nueva. Un hash que no coincide se rechaza (fail-closed).

### 5.2 Resolución dinámica de rutas: `resolveAiHubDir()`

Prohibido codificar `.ai-hub/` o `ai-hub/` a mano. Todo consumidor **MUST** usar `resolveAiHubDir()`, que resuelve en este orden:

1. Variable de entorno `AI_HUB_DIR`.
2. Campo `dir` de la configuración local del arnés, si existe.
3. `./.ai-hub` si existe.
4. `./ai-hub` si existe.
5. Raíz del repositorio que contenga `manifest.yaml`.

> **Estado:** el helper es normativo pero **todavía no está implementado**. Hasta que exista, se aplica el paso 5 (raíz con `manifest.yaml`). Implementarlo es un cambio aparte, no una edición improvisada.

### 5.3 Persistencia obligatoria en disco

El chat no es un almacén. Todo estado de sesión, hallazgo, propuesta, implementación y revisión **MUST** registrarse en `.planning/`:

| Archivo | Contenido |
|---|---|
| `.planning/findings.md` | Hallazgos verificables de exploración |
| `.planning/impl_<name>.md` | Cambios, pruebas y desviaciones de cada implementer |
| `.planning/review_arch_<name>.md` | Hallazgos de arquitectura |
| `.planning/review_tests_<name>.md` | Cobertura y veredicto de pruebas |
| `.planning/current.md` | Estado de la sesión y cambio activo |
| `.planning/history.md` | Decisiones, conflictos y cierres |

Si `.planning/` no existe, el agente lo crea en la primera escritura y lo anota en `history.md`.

### 5.4 Bloqueos y errores

Ante un fallo, el agente **MUST NOT** reintentar en silencio ni ampliar el alcance. Debe:

1. mover la issue a `ai::blocked` (o proponerlo al publisher);
2. comentar el motivo, el job y la evidencia;
3. registrar el bloqueo en `.planning/current.md`;
4. esperar decisión humana.

Un fallo técnico no cambia por sí solo el estado de la issue: lo hace la máquina de estados tras clasificarlo (retry, dead letter, blocked).

### 5.5 Secretos

`.env` y cualquier credencial **MUST NOT** versionarse. El PAT de GitLab se inyecta por entorno (`GITLAB_TOKEN`); nunca se escribe en artefactos, comentarios ni logs.

---

### 5.6 Checklist de cumplimiento

Antes de cerrar una sesión, el agente verifica:

- [ ] Leyó `AGENTS.md` completo y aplicó la precedencia de §1.1.
- [ ] Registró hallazgos, cambios y revisiones en `.planning/`.
- [ ] Usó `resolveAiHubDir()` (o el fallback documentado) y no hardcodeó la carpeta.
- [ ] Respetó su scope de escritura de §4.
- [ ] No aprobó su propio trabajo ni movió `ai::spec-ready` sin humano.
- [ ] Dejó la issue en el estado correcto o en `ai::blocked` con motivo y evidencia.
