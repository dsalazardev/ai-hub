# Delegation Rules

> Reglas de decisión para el orquestador: a quién delegar y cuándo.

---

## Regla Principal

**Si el orquestador siente la tentación de escribir código, crear un archivo, o editar código fuente, DEBE delegar.**

El orquestador solo lee, analiza, decide y lanza subagentes.

---

## Mapa de Delegación

### Por Intención del Usuario

| Intención del Usuario | Delegar A | Ejemplo de Trigger |
|----------------------|-----------|-------------------|
| "Quiero entender cómo funciona X" | `explorer-domain` | "Cómo funciona el flujo de aprobación de facturas?" |
| "Quiero agregar una nueva funcionalidad" | `spec-author` | "Agregar facturas recurrentes" |
| "Quiero implementar lo que propusimos" | `implementer-*` | "aprobado" (después de propose) |
| "Revisa si esto está bien" | `reviewer-*` | "Revisa mi código" |
| "Terminemos este cambio" | `archive` (orquestador) | "Archiva el cambio" |

### Por Palabras Clave en la Tarea

| Palabras Clave | Delegar A | Razón |
|----------------|-----------|-------|
| component, UI, template, CSS, HTML, Angular | `implementer-frontend` | Frontend-specific |
| service, DAL, API, HTTP, Observable | `implementer-frontend` | Frontend infrastructure |
| route, Express, middleware, DAL, BFF | `implementer-backend` | Backend-specific |
| test, spec, coverage, property-based | `reviewer-tests` | Testing expertise |
| convención, arquitectura, clean code | `reviewer-architecture` | Architecture expertise |
| investigar, entender, explorar | `explorer-domain` | Research |
| proponer, diseñar, especificar | `spec-author` | Specification |

### Por Tipo de Archivo Afectado

| Archivos Afectados | Delegar A | Verificación |
|-------------------|-----------|--------------|
| `frontend/src/**` | `implementer-frontend` | `cd frontend && ng build` |
| `frontend/**/*.spec.ts` | `implementer-frontend` | `cd frontend && npm test` |
| `backend/src/**` | `implementer-backend` | `cd backend && npx tsc --noEmit` |
| `backend/**/*.test.ts` | `implementer-backend` | `cd backend && npm test` |
| `openspec/changes/**` | `spec-author` | `openspec validate` |
| `AGENTS.md`, `*.md` | `spec-author` | Manual review |

---

## Reglas de Paralelismo

### SIEMPRE Paralelo

Lanza en paralelo cuando NO hay dependencias:
- `implementer-frontend` + `implementer-backend` (mismo cambio, diferentes archivos)
- `reviewer-architecture` + `reviewer-tests` (mismo código, diferentes perspectivas)

### SIEMPRE Secuencial

Lanza secuencialmente cuando hay dependencias:
- `spec-author` → `implementer-*` (no se puede implementar sin spec)
- `implementer-*` → `reviewer-*` (no se puede revisar sin código)
- `implementer-backend` → `implementer-frontend` (si frontend depende de API backend)

### Decisión de Paralelismo

El orquestador decide paralelismo leyendo `design.md`:
- Si design.md dice "frontend y backend son independientes" → paralelo
- Si design.md dice "frontend depende de endpoint X" → secuencial (backend primero)

---

## Reglas de Escalado

### Escalar a Usuario Cuando:

1. **Ambigüedad crítica**: spec no aclara requisito fundamental
2. **Conflicto de reviews**: reviewer-architecture dice "no cumple" pero implementador no puede corregir
3. **Cambio de scope**: implementación revela que el diseño es inválido
4. **Tercer reintento**: implementador falló 3 veces seguidas
5. **verify.sh falla**: entorno no está listo

### No Escalar Cuando:

1. **Tarea ambigua** → Relanzar spec-author con feedback
2. **Error de compilación** → Relanzar implementador con instrucciones de fix
3. **Review encontró issues** → Relanzar implementador con review como input
4. **Cobertura baja** → Relanzar implementador para agregar tests

---

## Formato de Delegación

Cuando el orquestador delega usando `Task`:

```
Task(
  description: "Implement frontend for invoice recurring",
  subagent_type: "general",
  prompt: """
    You are implementer-frontend. Read your definition at .ai-hub/agents/implementer-frontend.md.
    
    Change: add-recurring-invoices
    Location: openspec/changes/add-recurring-invoices/
    
    Tasks to implement: [list from tasks.md]
    
    Rules:
    1. Read AGENTS.md and .ai-hub/rules/frontend.md
    2. Read .ai-hub/skills/shared/angular-developer/SKILL.md
    3. Implement tasks in order
    4. Run verification: cd frontend && ng build
    5. Mark [x] in tasks.md as you complete
    6. Write summary to .planning/impl_add-recurring-invoices.md
  """
)
```

---

## Anti-Patrones de Delegación

| Anti-Patrón | Corrección |
|-------------|-----------|
| Orquestador escribe código directamente | STOP → Delegar a implementer |
| Orquestador edita tasks.md | STOP → Delegar a spec-author |
| Orquestador lanza reviewer antes de implementer | STOP → Esperar implementación |
| Orquestador no espera aprobación humana | STOP → Esperar "aprobado" |
| Orquestador ignora verify.sh | STOP → Arreglar entorno primero |
| Implementer-frontend modifica backend | STOP → Revertir, usar implementer-backend |
| Implementer-backend modifica frontend | STOP → Revertir, usar implementer-frontend |

---

## Referencias

- Manifest: `.ai-hub/manifest.yaml` (agent registry)
- PROMPT: `.ai-hub/orchestrator/PROMPT.md`
- Workflow: `.ai-hub/orchestrator/workflow.md`
