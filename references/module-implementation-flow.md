# Flujo de implementación paso a paso (módulos tipo `products`)

> **Objetivo**: Guía ordenada para que un agente implemente un módulo (nuevo o migrado) sin perder contexto ni romper contratos FE↔BE.
>
> **Referencia canónica**: [products-module-blueprint.md](./products-module-blueprint.md)
>
> **Regla de mantenimiento**: Si este flujo cambia, actualizar este archivo **y** el blueprint. No dejar documentos contradictorios.

---

## Principios del flujo

1. **Contrato primero, código después** — El dominio y los DTOs definen qué se construye; el resto los consume.
2. **Backend antes que frontend** en cada vertical (salvo que el spec diga lo contrario).
3. **Una operación = un DAL = un DTO de entrada** (patrón products).
4. **Verificar tras cada fase** (`tsc`, `ng build`, tests del slice).
5. **No inventar** — Si falta endpoint, campo Dolibarr o permiso: **preguntar al usuario**.
6. **KPIs en listados**: patrón `products-getall` (`statusCounts` + `KpiCardComponent` + pipes del módulo).
7. **Regla de paridad products**: lo general igual que `products`; solo cambian entidad, enums, campos, endpoints y operaciones del dominio ([blueprint §0.1](./products-module-blueprint.md#01-regla-de-paridad-products-general-igual-datos-distintos)).

---

## Perfiles de módulo

| Perfil | Ejemplo | Operaciones típicas |
|--------|---------|---------------------|
| **A — CRUD Dolibarr nativo** | `products`, `users/employees` | GetAll, GetById, Create, Update, Delete |
| **B — API custom + acciones** | `fichajes` | Clock-in/out, breaks, manual entry + CRUD workdays |
| **C — Transversal** | `users` (auth, rights) | Login, me, policies; no forzar patrón CRUD puro |

Cada módulo puede **extender** el perfil A con operaciones extra (ej. `ProductsChangePriceDal`). Las extensiones se documentan en el spec del módulo.

---

## Fase 0 — Nutrición (solo lectura, sin código)

**Entrada**: nombre del módulo, spec OpenSpec aprobada (o borrador para explorar).

**Leer obligatoriamente**:

| Orden | Qué leer |
|-------|----------|
| 1 | [products-module-blueprint.md](./products-module-blueprint.md) |
| 2 | [common-imports-catalog.md](./common-imports-catalog.md) |
| 3 | Código canónico de `products` (lista en blueprint §10) |
| 4 | `backend/doc/swagger.json` — endpoints Dolibarr del recurso |
| 5 | Anexo del módulo si existe: `fichajes-migration-notes.md`, `users-migration-notes.md` |
| 6 | Módulo legacy actual (si es migración) — inventario de archivos y rutas |

**Salida escrita** (en `.planning/` o en el change OpenSpec):

- `findings.md` — endpoints reales, campos Dolibarr, permisos, deuda legacy
- `entity-map.md` — nombres ES→EN si aplica (fichajes)
- Lista de operaciones → DTOs → DALs (tabla)

**Criterio de salida**: tabla operaciones/DTOs aprobada (usuario o spec).

---

## Fase 1 — Dominio compartido (FE + BE en paralelo conceptual)

> Tu intuición de empezar por `domain` es correcta. Es la **primera fase de código**, pero hay un paso previo (Fase 0) y un orden interno.

### 1.1 Entidad principal

- Crear `domain/{entity}.ts` — `interface` con camelCase.
- **Solo `id: number` es obligatorio** — **nunca** `id?: number` en `domain/` (FE ni BE). El resto de propiedades con `?`.
- Verificación: `rg "id\?:" backend/src/{modulo}/domain frontend/src/app/{modulo}/domain` → **0 coincidencias** (salvo comentarios).
- Si el listado es una proyección (ej. `EmployeeListItem` vs `User` completo), documentar en el spec; el mapper sigue el patrón `{Entity}Mapper`.
- Enums de negocio en `domain/enums/{name}.ts` (no `Enumerations/` PascalCase).
- **Backend y frontend: archivos espejo** (mismo contenido, distintos imports relativos).

### 1.2 DTOs por operación

Crear en este orden (dependencias de herencia):

| Orden | Archivo | Extiende |
|-------|---------|----------|
| 1 | `{Entity}sUpdateDto` | — (campos con `@Field`) |
| 2 | `{Entity}sCreateDto` | `UpdateDto` (si aplica mismo formulario) |
| 3 | `{Entity}sGetAllDto` | `QueryListDto` + filtros `@Field` |
| 4 | `{Entity}sGetByIdDto` | `QueryItemDto` |
| 5 | `{Entity}sDeleteDto` | `id` mínimo |
| 6 | DTOs de **acciones** extra | Según spec (fichajes: `PunchesClockInDto`, `WorkdaysGetAllDto`, etc.) |

**Reglas `@Field`**:

- `label` en español
- `type`, `required`, `min`, `max`, `enumType` según campo
- Labels alimentan Zod (BE) y `FormGroup` (FE)

### 1.3 Verificación Fase 1

- [ ] Sin `any`
- [ ] FE y BE: mismos nombres de propiedades en DTOs y entidad
- [ ] Enums idénticos en ambos lados
- [ ] `npx tsc --noEmit` (BE) si ya hay tsconfig que incluye domain
- [ ] No crear aún DALs ni componentes

**Por qué antes que DAL**: Los DALs y routers **solo importan** tipos de dominio. Cambiar dominio después rompe mappers y formularios.

---

## Fase 2 — Infraestructura backend (por operación)

### 2.1 DTO Dolibarr + mappers

| Orden | Artefacto |
|-------|-----------|
| 1 | `infrastructure/dal/dolibarr/{entity}DolibarrDto.ts` — snake_case, shape API |
| 2 | `mappers/{entity}Mapper.ts` — `toDomain` / `fromDomain` |
| 3 | Mappers de enum si hace falta | `ProductStatusMapper` pattern |

### 2.2 DALs (uno por operación)

Implementar en este orden recomendado:

| Orden | DAL | Por qué este orden |
|-------|-----|-------------------|
| 1 | **GetById** | Valida mapper con un solo registro |
| 2 | **GetAll** | El más complejo; reutiliza mapper |
| 3 | **Create** | `fromDomain` → Dolibarr |
| 4 | **Update** | Igual |
| 5 | **Delete** | Mínimo |
| 6 | **Acciones** custom | Fichajes: clock-in, etc. |

Cada DAL: `run(request: XxxDto): Promise<...>` + interfaz `IQueryGetListDal` / `IQueryGetItemDal` / `IServiceDal`.

### 2.3 Router + DI

| Orden | Tarea |
|-------|-------|
| 1 | `infrastructure/router/{entity}Router.ts` |
| 2 | `requireHttpRight` con policy del módulo |
| 3 | `buildZodSchema` en POST/PUT/DELETE |
| 4 | Registrar DALs en `container.ts` (`Lifetime.SCOPED`) |
| 5 | Montar en `server.ts` |

### 2.4 Verificación Fase 2

```bash
cd backend && npx tsc --noEmit
cd backend && npm test -- tests/{modulo}   # cuando existan
```

Probar manualmente o con supertest: GetById → GetAll → Create (si spec lo incluye).

---

## Fase 3 — Infraestructura frontend

### 3.1 DALs (`infrastructure/dal/backend/`)

Mismo orden que backend:

1. `GetByIdDal` → `api.queryItem`
2. `GetAllDal` → `api.queryList`
3. `CreateDal` / `UpdateDal` / `DeleteDal` → `ServiceBackendDal`

### 3.2 Pipes de dominio (si hay enums en UI)

- `{entity}StatusLabel`, `Color`, `Icon` + método `selector()` para selects.

### 3.3 Componentes (orden UI)

| Orden | Componente | Base |
|-------|------------|------|
| 1 | `{entity}s-getall` | `AppQueryBase` |
| 2 | `{entity}s-create` | `AppServiceBase` |
| 3 | `{entity}s-update` | `AppServiceBase` + `loadDal` |
| 4 | Modales / acciones extra | Según spec |

**Listado (KPIs frontend — patrón products)**:

- `items = signal<Entity[]>([])`
- `statusCounts = signal<Partial<Record<StatusEnum, number>>>({})`
- Tras cada `load()`, agrupar `response.data` con RxJS `groupBy` + `reduce` (copiar de `products-getall.ts`)
- Tarjeta «Total»: `[value]="items().length"` + `[total]="request().total"`
- UI: `KpiCardComponent` + pipes `{entity}StatusLabel|Color|Icon`
- Filtro por tarjeta: `setStatus()` → actualiza `request().status` + `load()`
- **Prohibido**: requests HTTP extra solo para KPIs; **prohibido** leer `stats` del BFF

### 3.4 Rutas

- Añadir en `app.routes.ts`: rutas estáticas (`create`) **antes** de `:id`
- Guards desde `common/guards/`

### 3.5 Verificación Fase 3

```bash
cd frontend && ng build
```

---

## Fase 4 — Integración y cierre

- [ ] Flujo E2E manual documentado en `progress.md`
- [ ] Tests mínimos (DAL BE, routes BE, DAL FE críticos)
- [ ] Eliminar o marcar deprecated archivos legacy del módulo
- [ ] Actualizar anexo de migración del módulo
- [ ] `/opsx:archive` cuando spec completo

---

## Migración vs módulo nuevo

| Aspecto | Módulo nuevo | Migración (fichajes, users) |
|---------|--------------|----------------------------|
| Fase 0 | Swagger + spec | + inventario legacy + mapa renombres |
| Fase 1 | Crear domain | Renombrar/mover domain; aliases temporales si spec lo pide |
| Rutas BFF | Solo inglés | Decidir: ¿mantener rutas ES con deprecation? (preguntar) |
| Código legacy | No existe | Convivencia hasta fase 4; no borrar sin spec |

**Estrategia recomendada para migraciones grandes** (fichajes):

1. **Vertical por feature**: ej. primero `workdays` listado+detalle, luego punch actions, luego config.
2. **No renombrar todo el módulo en un solo PR** — el spec debe trocear por OpenSpec changes.

---

## Qué NO hacer en medio del flujo

- No crear componentes antes de DTOs
- No definir tipos en `routes/` o componentes
- No duplicar lógica de filtros SQL fuera de `DolibarrDal`
- No usar `application/services` en FE si el patrón products usa `AppQueryBase` / `AppServiceBase`
- No registrar en Awilix hasta tener el DAL con constructor `(dolikey, entityId)`

---

## Diagrama resumen

```
Fase 0: Leer products + common + swagger + legacy
           ↓
Fase 1: domain/{entity}.ts + enums + DTOs (FE espejo BE)
           ↓
Fase 2: BE: DolibarrDto → mappers → DALs → router → container
           ↓ verify tsc
Fase 3: FE: DALs → pipes → componentes → rutas
           ↓ verify ng build
Fase 4: Tests, limpieza legacy, archive
```

---

## Documentos relacionados

| Archivo | Contenido |
|---------|-----------|
| [products-module-blueprint.md](./products-module-blueprint.md) | Patrón completo products |
| [common-imports-catalog.md](./common-imports-catalog.md) | Qué importar de common |
| [replicate-module-checklist.md](./replicate-module-checklist.md) | Checklist corto |
| [fichajes-migration-notes.md](./fichajes-migration-notes.md) | Fichajes: nombres, subdominios, endpoints |
| [users-migration-notes.md](./users-migration-notes.md) | Users: auth, employees, transversal |

---

*Actualizar este documento cuando se valide un flujo distinto en un módulo real (fichajes/users).*
