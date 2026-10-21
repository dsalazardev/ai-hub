# Reglas base de Doligestion
> **Fuente de verdad**: `.ai-hub/` · **Constitución**: `AGENTS.md` · **Versión AI Hub**: 2.0

---

## Startup Protocol

**Cuando el usuario diga "buenos días", "startup", "startup protocol" o inicie la conversación, NUNCA pidas que el usuario ejecute comandos. Claude ejecuta esta secuencia completa de forma autónoma antes de responder nada más:**

```bash
# 1. Generar contexto de sesión (PRIMERO — siempre)
npm run ai:context
# Luego leer el archivo generado:
cat .planning/context-next.md

# 2. Verificar entorno completo (si falta dist/, ejecutar antes: npm run ai:setup)
bash .ai-hub/bootstrap/verify.sh

# 3. Estado de cambios OpenSpec (versión fijada en package.json)
npx openspec list --json

# 4. Cargar el organigrama
cat .ai-hub/manifest.yaml
```

Reporta: cambio activo (de context-next.md), si verify.sh pasa, qué cambios OpenSpec existen y cuál es el siguiente paso recomendado.

---

## Identidad del Proyecto

**Doligestion** es un ERP empresarial compuesto por:

- **Frontend**: Angular 22 (standalone, Signals, Tailwind CSS 4, Material Angular migrando a Flowbite)
- **BFF**: Node.js + Express (orquestador entre Angular y Dolibarr)
- **Backend externo**: Dolibarr 21.0.4 REST API + Kubernetes API

El BFF es el único punto de acceso al exterior desde el frontend. El frontend nunca llama directamente a Dolibarr ni expone API keys.

---

## Reglas Críticas — SIEMPRE Activas

Estas reglas se aplican en CADA cambio de código, sin excepción:

### Prohibiciones absolutas (romper alguna = rechazar código)

| Regla | Descripción |
|-------|-------------|
| **Zero-Any** | Prohibido `any`. Usar `unknown` con type guards si es necesario |
| **No NgModule** | Solo componentes `standalone: true` |
| **No constructor injection** | Solo `inject()` a nivel de clase |
| **No legacy Angular** | Solo `@if`, `@for`, `@switch`. Prohibido `*ngIf`, `*ngFor`, `*ngSwitch` |
| **No herencia DolibarrDal** | Solo composición: `this.dolibarr = new DolibarrDal(...)` |
| **No TODOs en producción** | Solo código completo y funcional |
| **No JSDoc redundante** | Solo comentarios que aporten información no obvia |
| **No emojis en código** | Ni en logs, ni en UI (salvo excepción explícita del ingeniero) |
| **No implementar sin spec** | Todo cambio sigue: `/opsx:propose` → `/opsx:apply` → `/opsx:archive` |

### Regla de aislamiento de tipos (Clean Architecture)

Interfaces, tipos y DTOs viven EXCLUSIVAMENTE en la capa `domain/`. Los routes y componentes solo importan, nunca definen tipos.

### Sincronía frontend ↔ backend

Los tipos en `domain/` deben ser idénticos en ambos lados. Solo el campo `id` puede ser obligatorio. El resto, opcionales con `?`. Prohibidas las uniones de tipos en campos (`string | number`).

---

## Flujo de Trabajo Obligatorio (OpenSpec)

```
/opsx:explore  →  /opsx:propose  →  (aprobación humana)  →  /opsx:apply  →  /opsx:archive
```

### Comandos en Claude Code

| Comando | Acción |
|---------|--------|
| `/opsx:explore [tema]` | Exploración e investigación — nunca implementa |
| `/opsx:propose [nombre]` | Crea propuesta + diseño + tareas en `openspec/changes/<nombre>/` |
| `/opsx:apply [nombre]` | Implementa las tareas del cambio aprobado |
| `/opsx:archive [nombre]` | Archiva el cambio completado |

### Puerta de aprobación humana

Después de `/opsx:propose`, el sistema **se detiene** y espera que el usuario diga "aprobado" antes de lanzar cualquier implementación. Esta pausa es obligatoria y no negociable.

---

## Arquitectura Multi-Agente (AI Hub 2.0)

El orquestador (yo, en modo Claude Code) coordina subagentes especializados. **Regla de oro: el orquestador nunca escribe código de aplicación directamente.**

### Mapa de agentes

| Agente | Archivo | Puede modificar | No puede modificar |
|--------|---------|-----------------|-------------------|
| `spec-author` | `.ai-hub/agents/spec-author.md` | `openspec/changes/**`, `.planning/**` | `frontend/src/**`, `backend/src/**` |
| `implementer-frontend` | `.ai-hub/agents/implementer-frontend.md` | `frontend/src/**`, `*.spec.ts` | `backend/src/**` |
| `implementer-backend` | `.ai-hub/agents/implementer-backend.md` | `backend/src/**`, `*.test.ts` | `frontend/src/**` |
| `reviewer-architecture` | `.ai-hub/agents/reviewer-architecture.md` | `.planning/review_arch_*.md` | Todo código fuente |
| `reviewer-tests` | `.ai-hub/agents/reviewer-tests.md` | `.planning/review_tests_*.md` | Todo código fuente |
| `explorer-domain` | `.ai-hub/agents/explorer-domain.md` | `.planning/findings.md` | Todo código fuente |

### Delegación por tipo de tarea

| Si el usuario dice... | Delegar a |
|----------------------|-----------|
| "quiero entender cómo funciona X" | `explorer-domain` |
| "quiero agregar / construir X" | `spec-author` |
| "aprobado" (tras `/opsx:propose`) | `implementer-frontend` + `implementer-backend` (paralelo si aplica) |
| "revisa el código" | `reviewer-architecture` + `reviewer-tests` (paralelo) |

### Paralelismo

- `implementer-frontend` + `implementer-backend`: paralelo cuando el cambio afecta ambos lados independientemente
- `reviewer-architecture` + `reviewer-tests`: siempre paralelo
- Secuencial cuando `design.md` indica que frontend depende de un endpoint backend nuevo

### Regla anti-teléfono-roto

Los subagentes comunican resultados por archivo, nunca por chat:
- `implementer-*` → `.planning/impl_<nombre>.md`
- `reviewer-*` → `.planning/review_arch_<nombre>.md` / `.planning/review_tests_<nombre>.md`
- `explorer-domain` → `.planning/findings.md`

---

## Skills Disponibles

Registradas en `.ai-hub/manifest.yaml`. Se activan automáticamente por contexto:

### Skills compartidas (todos los entornos)

| Skill | Triggers | Descripción |
|-------|----------|-------------|
| `openspec-workflow` | `/opsx:*` | Flujo OpenSpec completo |
| `angular-developer` | component, signal, route, standalone | Angular 22 con Signals y inject() |
| `onna-architecture-common` | domain/, DTO, enum, mapper | Contrato compartido frontend ↔ BFF |

### Skills de frontend

| Skill | Triggers | Descripción |
|-------|----------|-------------|
| `onna-architecture-angular` | infrastructure/components/, .dal.ts, .service.ts | Patrón DAL, estructura Angular |
| `onna-design-system` | mat-table, tailwind, empty state | UI/UX, Glassmorphism, responsive |

### Skills de backend

| Skill | Triggers | Descripción |
|-------|----------|-------------|
| `onna-architecture-bff` | routes/, DolibarrDal, ErrorResult | Express BFF, composición DAL, errores |

---

## MCPs Integrados

Configurados en `.ai-hub/mcp-manifest.yaml`:

| MCP | Tipo | Variable | Uso |
|-----|------|----------|-----|
| **Playwright** | Local (`npx -y @playwright/mcp@0.0.83`) | — | Automatización E2E, verificación visual |

**GitLab (self-managed, `https://gitlab.v3.onnadigital.com`)** no usa MCP: se integra por las skills `gitlab-auth` y `gitlab-workflow` contra la API REST v4 con un PAT (`GITLAB_URL` / `GITLAB_TOKEN`) cargado desde `.ai-hub/.env` (nunca versionado). Referencia: `.ai-hub/skills/shared/gitlab-auth/SKILL.md`.

---

## Estructura del Proyecto

```
doligestion/
├── AGENTS.md                    ← Constitución global (leer primero)
├── CLAUDE.md                    ← Este archivo
├── .ai-hub/                     ← AI Hub 2.0 (fuente de verdad)
│   ├── manifest.yaml            ← Registro de agentes, skills, MCPs
│   ├── orchestrator/            ← PROMPT.md, workflow.md, delegation-rules.md
│   ├── agents/                  ← Definición de cada subagente
│   ├── skills/shared/           ← Skills únicas (una copia por skill)
│   ├── skills/adapters/         ← Mapeo de comandos por herramienta
│   ├── bootstrap/               ← verify.sh, detect-workspace.sh
│   └── mcp-local/               ← Setup scripts para MCPs locales
├── .planning/                   ← Estado de sesión y resultados de agentes
│   ├── .active_plan             ← Nombre del cambio activo
│   ├── findings.md              ← Output de explorer-domain
│   ├── impl_*.md                ← Output de implementers
│   └── review_*.md              ← Output de reviewers
├── openspec/
│   ├── changes/                 ← Cambios activos
│   │   └── <nombre>/
│   │       ├── proposal.md
│   │       ├── design.md
│   │       └── tasks.md
│   └── changes/archive/         ← Cambios completados
├── frontend/
│   ├── agents.md                ← Reglas específicas de frontend
│   ├── dessign.md               ← Sistema de diseño de ventanas
│   └── src/app/
│       └── <dominio>/
│           ├── domain/          ← Interfaces, enums (= backend)
│           ├── application/     ← Application services
│           └── infrastructure/
│               ├── dal/         ← Data Access Layer → BFF
│               └── components/  ← Componentes Angular
└── backend/
    ├── agents.md                ← Reglas específicas de backend
    └── src/
        └── <dominio>/
            ├── domain/          ← Interfaces, enums (= frontend)
            ├── application/     ← Application services
            └── infrastructure/
                ├── dal/         ← DAL → Dolibarr API
                └── routes/      ← Express endpoints
```

---

## Arquitectura Frontend (Angular 22)

### Reglas obligatorias

```typescript
// ✅ Correcto
@Component({
  selector: 'app-products-list',
  standalone: true,                    // siempre standalone
  imports: [...],
  templateUrl: './products-list.html',
  styleUrl: './products-list.css'
})
export class ProductsListComponent {
  private productsDal = inject(ProductsDal);   // inject(), no constructor
  products = signal<Product[]>([]);            // Signals con tipo explícito
  isLoading = signal(false);
}

// En templates
@if (isLoading()) { <spinner /> }             // @if, @for, @switch
@for (p of products(); track p.id) { ... }   // track obligatorio en @for
```

### Patrón DAL

```typescript
// infrastructure/dal/products.dal.ts
@Injectable({ providedIn: 'root' })
export class ProductsDal {
  private http = inject(HttpClient);

  getAll(pagination: ProductPagination): Observable<ProductListResponse> {
    return this.http.get<ProductListResponse>('/api/products', {
      params: { ...pagination },
      withCredentials: true              // cookies HTTP-only
    });
  }
}
```

### Convenciones de listados

- Paginación por defecto: 50 elementos. Opciones: `[10, 25, 50, 100, 250, 500, 1000]`
- Primera columna: estado/tipo con pipe de color e icono + matTooltip
- Última columna: acciones con iconos ghost (sin colores semánticos)
- Desktop: `mat-table`. Mobile: cards individuales
- Iconos estándar: `visibility` (ver), `edit` (editar), `add` (crear), `close` (eliminar)

### Nomenclatura

| Artefacto | Idioma | Forma | Ejemplo |
|-----------|--------|-------|---------|
| Rutas URL, carpetas, componentes | Inglés | Plural | `/products`, `products-list` |
| Interfaces, enums de dominio | Inglés | Singular | `Product`, `ProductStatus` |
| Texto visible al usuario | Español | — | `Crear`, `Guardar`, `Cancelar` |

---

## Arquitectura Backend (Node.js BFF)

### Reglas obligatorias

```typescript
// ✅ Correcto: composición del DAL
export class ProductsDal {
  private dolibarr: DolibarrDal;

  constructor(dolikey: string, entityId: number) {
    this.dolibarr = new DolibarrDal(dolikey, entityId);  // composición
  }
}

// ❌ Prohibido: herencia
export class ProductsDal extends DolibarrDal {} // NUNCA
```

### Jerarquía de errores

| Clase | statusCode | Uso |
|-------|------------|-----|
| `ArgumentError` | 400 | Parámetro inválido |
| `NotAuthenticatedError` | 401 | Sin sesión |
| `ForbiddenError` | 403 | Sin permisos |
| `NotFoundError` | 404 | No encontrado |
| `IllegalOperationError` | 422 | Operación no permitida |
| `InternalError` | 500 | Error no controlado |

### Comandos de verificación

```bash
# Verificar TypeScript (después de cambios)
cd backend && npx tsc --noEmit

# Rebuild Docker (después de cambios en backend)
docker compose down && docker compose build --no-cache backend && docker compose up -d backend

# Desarrollo frontend
cd frontend && ng serve

# Build de verificación frontend
cd frontend && ng build
```

---

## Testing

| Aspecto | Backend | Frontend |
|---------|---------|----------|
| Framework | Vitest | Vitest |
| Cobertura mínima | ≥ 70% | ≥ 60% |
| Imports | `import { describe, it, expect, vi } from 'vitest'` | `import { describe, it, expect } from 'vitest'` |
| Mock target | Mock `DolibarrDal` | Mock DALs (no services) |
| Tests complejos | property-based con `fast-check` | — |
| Integración backend | Supertest para routes | — |

---

## Recuperación de Sesión

Si el contexto se pierde o se inicia una nueva sesión:

1. Ejecutar `bash .ai-hub/bootstrap/verify.sh`
2. Leer `.planning/.active_plan` para identificar el cambio activo
3. Ejecutar `openspec status --change "<nombre>" --json`
4. Retomar según el estado:
   - `spec_ready` → pedir aprobación al usuario
   - `in_progress` → relanzar implementadores
   - `reviewing` → relanzar reviewers
   - `done` → sugerir `/opsx:archive`

---

## Reglas de Colaboración entre Agentes

1. **El orquestador no escribe código** — delega siempre a implementers
2. **Los reviewers no modifican código** — escriben informes y delegan fixes a implementers
3. **Los implementers no se comunican entre sí** — solo escriben a sus archivos respectivos
4. **Máximo 3 reintentos** por implementer antes de escalar al usuario
5. **Verificación obligatoria** después de cada tarea: `ng build` (frontend) / `npx tsc --noEmit` (backend)
6. **Chat limpio**: referencias de resultado solamente. Nunca pegar diffs completos ni contenido de archivos en el chat.

---

## Referencias

| Documento | Propósito |
|-----------|-----------|
| `AGENTS.md` | Constitución global — leer primero |
| `.ai-hub/manifest.yaml` | Registro de agentes, skills, MCPs |
| `.ai-hub/orchestrator/PROMPT.md` | Identidad del orquestador |
| `.ai-hub/orchestrator/workflow.md` | Flujo completo con diagrama |
| `.ai-hub/orchestrator/delegation-rules.md` | Reglas de delegación detalladas |
| `.ai-hub/rules/frontend.md` | Reglas específicas de Angular |
| `frontend/dessign.md` | Sistema de diseño de ventanas |
| `.ai-hub/rules/backend.md` | Reglas específicas del BFF |
| `backend/doc/swagger.json` | API de Dolibarr — fuente de verdad de endpoints |
