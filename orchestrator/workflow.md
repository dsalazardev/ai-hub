# OpenSpec + Harness Integration Workflow

> Documento de flujo de trabajo que conecta el ciclo de vida de OpenSpec con el sistema de subagentes del AI Hub.

---

## Ciclo de Vida Completo

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OPENSPEC + HARNESS INTEGRATION FLOW                       │
│                                                                              │
│   ENTRADA DEL USUARIO                                                        │
│      │                                                                       │
│      │ "Implementar facturas recurrentes"                                   │
│      ▼                                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  ORQUESTADOR (Leader)                                                │   │
│   │  1. Lee AGENTS.md, manifest.yaml, .planning/current.md              │   │
│   │  2. Ejecuta .ai-hub/bootstrap/verify.sh                              │   │
│   │  3. Identifica alcance desde openspec/changes/ o crea nuevo cambio  │   │
│   │  4. Decide estrategia de delegación                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│      │                                                                       │
│      ├── Caso A: {{OPSX_PREFIX}}explore                                      │
│      │   └── Agente(explorer-domain)                                        │
│      │       Escribe: .planning/findings.md                                 │
│      │                                                                       │
│      ├── Caso B: {{OPSX_PREFIX}}propose                                     │
│      │   └── Agente(spec-author)                                            │
│      │       Escribe: openspec/changes/<nombre>/{proposal,design,tasks}.md │
│      │       Actualiza: openspec/config.yaml o metadata del cambio          │
│      │       Output: "spec_ready → openspec/changes/<nombre>/"              │
│      │                                                                       │
│      │ ⏸ PUERTA DE APROBACIÓN HUMANA                                       │
│      │    Usuario revisa proposal.md + design.md, dice "aprobado"           │
│      │                                                                       │
│      ├── Caso C: {{OPSX_PREFIX}}apply (con aprobación)                      │
│      │   └── Identifica alcance desde design.md                             │
│      │       Si archivos frontend afectados → Agente(implementer-frontend)  │
│      │       Si archivos backend afectados  → Agente(implementer-backend)   │
│      │       Si ambos                      → Lanzamiento paralelo           │
│      │                                                                       │
│      │   PROTOCOLO DEL IMPLEMENTADOR (adaptado de BettaTech):               │
│      │   1. Lee AGENTS.md + agents.md del entorno                          │
│      │   2. Lee skills relevantes desde .ai-hub/skills/shared/             │
│      │   3. Lee tasks.md del cambio OpenSpec                                │
│      │   4. Para cada tarea T<n>:                                           │
│      │      a. Implementa cambio                                            │
│      │      b. Ejecuta verificación (ng build / npx tsc --noEmit)           │
│      │      c. Marca [x] en tasks.md                                        │
│      │   5. Escribe .planning/impl_<nombre>.md                              │
│      │   6. Output: "done → .planning/impl_<nombre>.md"                     │
│      │                                                                       │
│      └── Caso D: Revisión                                                   │
│          └── Agente(reviewer-architecture)                                  │
│              Valida: convenciones, Zero-Any, no NgModule, etc.              │
│              Output: .planning/review_arch_<nombre>.md                      │
│          └── Agente(reviewer-tests)                                         │
│              Valida: cobertura de tests, trazabilidad tareas ↔ código       │
│              Output: .planning/review_tests_<nombre>.md                     │
│                                                                              │
│   FINALIZAR                                                                  │
│      └── Orquestador marca cambio como "done" en OpenSpec                   │
│          Archiva cambio a openspec/changes/archive/                         │
│          Actualiza .planning/history.md                                     │
│          Ejecuta verify.sh como puerta final                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Estados del Cambio

| Estado | Descripción | Transición |
|--------|-------------|------------|
| **pending** | Cambio creado, sin especificar | spec-author → spec_ready |
| **spec_ready** | Proposal + design + tasks completos | ⏸ humano aprueba → in_progress |
| **in_progress** | Implementación activa | implementer → done / review |
| **reviewing** | Revisión en curso | reviewer → done / in_progress (si falla) |
| **done** | Completado y verificado | archive → archivado |
| **archived** | Movido a openspec/changes/archive/ | — |

---

## Regla Anti-Teléfono-Roto (de BettaTech)

**Problema**: En un flujo de agente único, el agente escribe código, luego intenta revisarse a sí mismo. El contexto se degrada.

**Solución**: Comunicación estricta basada en archivos:

| Paso | Agente | Escribe En | Lee Desde |
|------|--------|------------|-----------|
| 1 | spec-author | `openspec/changes/<nombre>/*.md` | AGENTS.md, feature request |
| 2 | orquestador | — | `openspec/changes/<nombre>/` |
| 3 | implementer-frontend | `frontend/src/**`, `.planning/impl_*.md` | `openspec/changes/<nombre>/tasks.md` |
| 4 | implementer-backend | `backend/src/**`, `.planning/impl_*.md` | `openspec/changes/<nombre>/tasks.md` |
| 5 | reviewer | `.planning/review_*.md` | `frontend/src/**`, `backend/src/**`, AGENTS.md |
| 6 | orquestador | `.planning/history.md` | `.planning/review_*.md` |

**Regla**: No diffs en chat. Solo referencias como `done → .planning/impl_factura_recurrente.md`.

---

## Lanzamiento Paralelo de Implementadores

Cuando un cambio afecta AMBOS frontend y backend:

1. Orquestador lee `design.md` para identificar archivos afectados
2. Lanza `implementer-frontend` y `implementer-backend` simultáneamente con `Task`
3. Espera a que AMBOS terminen (no puede revisar hasta que ambos completen)
4. Si uno falla, el otro continúa pero el cambio no avanza a revisión
5. Los implementadores NO se comunican entre sí — solo escriben a sus archivos respectivos

---

## Puerta de Aprobación Humana

Después de que `spec-author` completa:

1. Orquestador reporta: "spec_ready → openspec/changes/<nombre>/"
2. Orquestador lista los artefactos creados
3. Orquestador pide: "Revisa proposal.md y design.md. Di 'aprobado' para continuar."
4. ⏸ ORQUESTADOR SE DETIENE — no lanza implementadores hasta aprobación explícita
5. Usuario dice "aprobado" → orquestador transiciona a `in_progress`
6. Si usuario pide cambios → orquestador relanza spec-author con feedback

---

## Protocolo de Revisión

Cuando implementadores terminan:

1. Orquestador lee `.planning/impl_*.md` de ambos implementadores
2. Lanza `reviewer-architecture` y `reviewer-tests` en paralelo
3. Espera resultados
4. Si ambos pasan → transiciona a `done`
5. Si alguno falla → orquestador:
   - Lee `.planning/review_*.md` para entender problemas
   - Decide: reintentar implementador, actualizar spec, o escalar a usuario
   - Máximo 3 reintentos por cambio

---

## Archivado

Cuando cambio está `done`:

1. Orquestador verifica que no queden tareas pendientes
2. Verifica que reviews pasaron
3. Ejecuta `openspec archive <nombre>` (o mueve manualmente)
4. Actualiza `.planning/history.md` con:
   - Nombre del cambio
   - Fecha de finalización
   - Artefactos creados
   - Notas de implementación
5. Ejecuta `verify.sh` como validación final
6. Limpia `.planning/impl_*.md` y `.planning/review_*.md` (opcional)

---

## Recuperación de Sesión

Si el contexto se pierde (reinicio, nueva ventana, etc.):

1. Orquestador ejecuta startup protocol
2. Lee `.planning/.active_plan` para identificar cambio activo
3. Lee estado del cambio desde `openspec/changes/<nombre>/`
4. Resume desde el estado actual:
   - Si `spec_ready` → pide aprobación
   - Si `in_progress` → relanza implementadores
   - Si `reviewing` → relanza reviewers
   - Si `done` → sugiere archivar

---

## Referencias

- BettaTech SDD: `/tmp/betta-tech-repos/harness-sdd/`
- OpenSpec CLI: `openspec --help`
- AGENTS.md: `AGENTS.md`
- Delegación: `.ai-hub/orchestrator/delegation-rules.md`
