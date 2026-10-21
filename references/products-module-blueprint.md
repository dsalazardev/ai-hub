# Blueprint: módulo `products` — referencia para replicar en otros módulos

> **Audiencia**: agentes de implementación (Claude Sonnet 4.6 u otros) que deben crear o migrar módulos (`fichajes`, `users`, etc.) siguiendo el mismo patrón que `products`.
>
> **Fuente de verdad viva**: el código en `backend/src/products`, `frontend/src/app/products` y `common` en ambos lados.
>
> **Última revisión**: 2026-06-26

---

## 0. Reglas obligatorias para el agente

1. **No inventar código ni endpoints**. Si no está en este documento ni en el código de referencia, **preguntar al usuario** por chat antes de implementar.
2. **No fallbacks innecesarios** ni ramas defensivas para casos que el spec no define.
3. **No magic strings** sueltos: usar enums, constantes nombradas o valores documentados en dominio/DTO.
4. **Prohibido `any`**. Usar tipos explícitos o `unknown` con type guards.
5. **`id`**: en `domain/` y en `*DolibarrDto`, `id` es **siempre** `id: number` **sin** `?` (como `productDolibarrDto` / `serviceDolibarrDto`). Único campo obligatorio en la entidad; el resto con `?`. Prohibido `id?:`, `number | string`, `id: string` en dominio. Si Dolibarr envía `"1"` como string JSON, el mapper hace `Number(item.id)`. Detalle y checklist: [products-coding-standard.md](./products-coding-standard.md).
6. **No copiar archivos legacy** listados en la sección 12. Usar solo la ruta **canónica (nuevo patrón)**.
7. **Sincronía FE ↔ BE**: DTOs con `@Field` y la entidad `Product` deben ser **idénticos** en frontend y backend (salvo imports relativos vs `@app/`).
8. **OpenSpec obligatorio**: `/opsx:propose` → aprobación humana → `/opsx:apply`. No escribir código productivo sin spec.
9. Si `AppQueryBase` / `AppServiceBase` tienen mensajes hardcodeados a "Producto", **parametrizar o sobrescribir** en el módulo nuevo (deuda conocida).
10. **KPIs en listados**: calcular en **frontend** con `statusCounts` desde `response.data` en cada `load()`, UI con `KpiCardComponent` + pipes `{entity}Status*` del módulo (patrón `products-getall`).
11. **Regla de paridad products** (users, fichajes y cualquier módulo migrado): lo **general** se hace **igual** que en `products`; solo cambian los **datos del dominio** (entidad, enum, campos, endpoint, permisos). Ver sección 0.1.

---

## 0.1 Regla de paridad products (general igual, datos distintos)

> Decisión proyecto (2026-06-26): **users** y **fichajes** (y el resto de módulos) replican el **mismo esqueleto** que `products`. No inventar variantes legacy en listados, DALs, KPIs o formularios si products ya define el patrón.

### Igual en todos los módulos (copiar de products)

| Área | Patrón canónico |
|------|-----------------|
| **Backend dominio** | `domain/{entity}.ts`, `domain/enums/`, DTOs `{Entity}s{Op}Dto`; **`id: number` sin `?`** (único obligatorio) |
| **Backend infra** | `{entity}DolibarrDto` snake_case, `mappers/` con `toDomain`/`fromDomain`, DAL `run(dto)`, `DolibarrDal` composición |
| **Backend router** | `createRequestScope` + Awilix, Zod en escritura, `AuthenticatedRequest` |
| **Frontend dominio** | Espejo byte-a-byte del backend |
| **Frontend DAL** | `infrastructure/dal/backend/`, `QueryBackendDal` / `ServiceBackendDal` |
| **Listado** | `extends AppQueryBase`, `load()` + `setStatus()`, **sin** `*RetrieveService` |
| **KPIs** | Mismo mecanismo: `statusCounts` en `load()`, `KpiCardComponent`, pipes `{entity}Status*`, `setStatus()` |
| **Tabla / UI** | `col-*`, `card-header`, `card-empty`, `form-field-*` desde **common** |
| **Create/Update** | `extends AppServiceBase`, `formGroupFromDto` |
| **Tests** | Vitest, mocks de DAL, sin `any` |

### Cambia por módulo (solo datos / negocio)

| Qué varía | products | users (employees) | fichajes (workdays / punches) |
|-----------|----------|-------------------|-------------------------------|
| Carpeta / URL BFF | `products` → `/api/products` | `users` → `/api/users/employees` | `workdays` → `/api/workdays`, `punches` → `/api/punches` |
| Entidad listado | `Product` | `EmployeeListItem` | `Workday`, `Punch` |
| Enum estado | `ProductStatus` | `UserStatus` | `WorkdayStatus`, `PunchStatus`, … |
| Pipes | `productStatus*` | `userStatus*` | `workdayStatus*`, `punchStatus*`, … |
| Campos `@Field` / filtros | `filterBy`, `status`, `ref`… | `filterBy`, `status`, `login`… | Según spec Dolibarr |
| Operaciones extra | `ChangePrice` | Auth, rights (fuera CRUD) | `clock-in`, `break-start`, … (`IServiceDal`) |
| Nº tarjetas KPI | 3 estado | 2 estado + 2 fichajes (opcional) | Según spec |
| API Dolibarr | `/products` estándar | `/users` + filtros employee | API custom `fichajestrabajadoresapi` |

**Prohibido** en migraciones: servicios retrieve paralelos, KPIs con `stats` del BFF, `<div class="kpi-card">` manual, `EstadosUsuario` en listados nuevos, DAL monolítico, tipos en routers.

**Permitido** solo si el spec lo documenta: operaciones no-CRUD (perfil B fichajes), rutas anidadas (`/users/employees`), **más o menos tarjetas KPI** que products si el módulo lo necesita (employees: 2 estado + 2 fichajes), extensiones de listado.

**Paridad ≠ copiar cantidad de KPIs**: products tiene 3 tarjetas de estado; employees puede tener 2 u otras — lo que debe ser **igual** es el **mecanismo** (`statusCounts` en `load()`, `KpiCardComponent`, pipes `{entity}Status*`, `setStatus()`), no el número de tarjetas.

## 1. Stack y versiones

| Entorno | Tecnología | Versión (package.json) |
|---------|------------|------------------------|
| Frontend | Angular | ^21.0.0 |
| Frontend | Angular Material | ^21.2.10 |
| Frontend | TypeScript | ~5.9.2 |
| Frontend | Tailwind CSS | ^4.1.12 |
| Frontend | Vitest | ^4.x (tests) |
| Backend | Node.js | 20+ (runtime Docker) |
| Backend | Express | ^5.2.1 |
| Backend | TypeScript | ^5.x |
| Backend | Awilix (DI) | ^13.0.3 |
| Backend | Zod | ^4.3.6 |
| Backend | RxJS | ^7.8.2 (solo en DALs de listado backend) |
| Backend | Vitest | tests |

**Angular obligatorio**: standalone components, `inject()`, `@if` / `@for` / `@switch` (prohibido `*ngIf`, `*ngFor`, `NgModule`).

---

## 2. Convenciones de nomenclatura e idioma

### 2.1 Idioma

| Qué | Idioma | Ejemplo |
|-----|--------|---------|
| Carpetas de módulo / URL / archivos de código | Inglés | `products`, `products-getall` |
| Interfaces y clases de dominio | Inglés | `Product`, `toSell`, `costPrice` |
| Labels `@Field` | Español | `'Referencia'`, `'Buscar por...'` |
| Mensajes HTTP / snackbar / diálogos | Español | `'Payload de producto invalido'` |
| Comentarios de código | Español o inglés técnico breve | Preferir autoexplicativo sin comentar |

### 2.2 Convenciones de casing

| Artefacto | Convención | Ejemplo |
|-----------|------------|---------|
| Carpeta módulo | kebab-case, plural (inglés) | `products/` |
| Carpeta componente | kebab-case, `{recurso}-{accion}` | `products-getall/`, `products-create/` |
| Archivo componente | igual que carpeta | `products-getall.ts` |
| Selector componente | kebab-case (inconsistente en products) | `products-getall`, `app-products-create` |
| Entidad dominio | PascalCase singular | `Product` |
| Enum | PascalCase | `ProductStatus` |
| Archivo enum | camelCase | `productStatus.ts` en `domain/enums/` |
| DTO operación | `{Recurso}s{Operacion}Dto` | `ProductsGetAllDto`, `ProductsCreateDto` |
| DTO Dolibarr (infra) | `{Entidad}DolibarrDto` | `ProductDolibarrDto` |
| DAL backend | `{Recurso}s{Operacion}Dal` | `ProductsGetAllDal` |
| DAL frontend activo | `{Recurso}s{Operacion}Dal` en `dal/backend/` | `ProductsGetAllDal` |
| Mapper | `{Entidad}Mapper` | `ProductMapper` |
| Mapper enum | `{Entidad}{Aspecto}Mapper` | `ProductStatusMapper` |
| Pipe | camelCase descriptivo | `productStatusLabel` |
| Router backend | `{recurso}Router.ts` | `productsRouter.ts` |
| Método DAL | `run(request: Dto): Promise/ Observable` | Un solo método público |
| Propiedades dominio | camelCase | `ivaRate`, `notePublic` |
| Campos API Dolibarr | snake_case | `tva_tx`, `cost_price` |
| Endpoint Dolibarr | string literal en propiedad privada | `private endpoint = "products"` |
| Ruta BFF | `/api/{recurso-plural}` | `/api/products` |
| Token Awilix | camelCase | `productsGetAllDal` |

### 2.3 Operaciones CRUD estándar

| Operación | Sufijo DTO | Sufijo DAL | HTTP |
|-----------|------------|------------|------|
| Listado | `GetAllDto` | `GetAllDal` | GET `/` |
| Detalle | `GetByIdDto` | `GetByIdDal` | GET `/:id` |
| Crear | `CreateDto` | `CreateDal` | POST `/` |
| Actualizar | `UpdateDto` | `UpdateDal` | PUT `/:id` |
| Eliminar | `DeleteDto` | `DeleteDal` | DELETE `/:id` |

`CreateDto` en products **extiende** `UpdateDto` sin campos extra.

---

## 3. Estructura de carpetas canónica

### 3.1 Backend — `backend/src/products/`

```
products/
├── domain/
│   ├── product.ts                    # interface Product (dominio limpio)
│   ├── productsGetAllDto.ts
│   ├── productsGetByIdDto.ts
│   ├── productsCreateDto.ts          # extends ProductsUpdateDto
│   ├── productsUpdateDto.ts          # @Field para formularios + Zod
│   ├── productsDeleteDto.ts
│   └── enums/
│       ├── productType.ts
│       ├── productStatus.ts
│       └── productPriceBaseType.ts
└── infrastructure/
    ├── router/
    │   └── productsRouter.ts
    └── dal/
        └── dolibarr/
            ├── productsGetAllDal.ts
            ├── productsGetByIdDal.ts
            ├── productsCreateDal.ts
            ├── productsUpdateDal.ts
            ├── productsDeleteDal.ts
            ├── productDolibarrDto.ts       # shape API externa (snake_case)
            ├── enums/
            │   └── productMode.ts          # solo infra (filtro query Dolibarr)
            └── mappers/
                ├── productMapper.ts
                ├── productStatusMapper.ts
                ├── productModeMapper.ts
                └── productPriceBaseTypeMapper.ts
```

**Capas opcionales en products (no replicar salvo necesidad):**

- `application/catalogGetAllUseCase.ts` — orquesta productos + servicios
- `application/productSchemas.ts` — schemas adicionales
- Routers hermanos: `services.ts`, `catalogRouter.ts`

### 3.2 Frontend — `frontend/src/app/products/`

```
products/
├── domain/                           # ESPEJO del backend (mismos DTOs y Product)
│   ├── product.ts
│   ├── productsGetAllDto.ts
│   ├── productsGetByIdDto.ts
│   ├── productsCreateDto.ts
│   ├── productsUpdateDto.ts
│   ├── productsDeleteDto.ts
│   └── enums/
│       ├── productType.ts
│       ├── productStatus.ts
│       └── productPriceBaseType.ts
├── application/                      # LEGACY comentado — NO usar como referencia
└── infrastructure/
    ├── components/
    │   ├── products-getall/
    │   ├── products-create/
    │   ├── products-update/
    │   └── product-updateprice-dialog/   # modal específico del dominio
    ├── dal/
    │   └── backend/                  # CANÓNICO — DALs activos
    │       ├── productsGetAllDal.ts
    │       ├── productsGetByIdDal.ts
    │       ├── productsCreate.dal.ts   # nota: extensión .dal.ts en algunos archivos
    │       ├── productsUpdate.dal.ts
    │       └── productsChangePriceDal.ts
    ├── dal/products-retrieve.dal.ts  # delete (nombre legacy pero activo)
    └── pipes/
        ├── product-status-color.pipe.ts
        ├── product-status-icon.pipe.ts
        ├── product-status-label.pipe.ts
        └── product-price-base-type-label.pipe.ts
```

**Rutas**: definidas en `frontend/src/app/app.routes.ts` (no hay `products.routes.ts`).

Orden crítico: `create` **antes** de `:id`.

### 3.3 Qué va en cada carpeta (backend)

**Raíz del slice**: `backend/src/{modulo}/` (ej. `products/`, `users/`).

| Carpeta / archivo | DEBE contener | NO debe contener |
|-------------------|---------------|------------------|
| `domain/{entity}.ts` | `interface` dominio limpio (camelCase, composición de objetos) | snake_case, `fk_*`, tipos Dolibarr, clases, lógica HTTP |
| `domain/{entity}ListItem.ts` | Proyección de listado si la entidad completa es más grande (ej. `EmployeeListItem`) | Campos que solo existen en formulario CRUD |
| `domain/enums/{name}.ts` | Enums de **negocio** usados en dominio y DTOs (`ProductStatus`, `UserStatus`) | Valores solo de filtro API Dolibarr |
| `domain/{Entity}sGetAllDto.ts` | `class extends QueryListDto` + `@Field` en filtros | Validación Zod (va en router) |
| `domain/{Entity}sGetByIdDto.ts` | `extends QueryItemDto` | — |
| `domain/{Entity}sUpdateDto.ts` | Campos formulario con `@Field` (español en labels) | — |
| `domain/{Entity}sCreateDto.ts` | `extends UpdateDto` (products) | Campos distintos al update salvo spec |
| `domain/{Entity}sDeleteDto.ts` | `id` + metadata `@Field` si aplica | — |
| `infrastructure/router/{modulo}Router.ts` | Rutas Express, `buildZodSchema`, `createRequestScope`, `requireHttpRight` | Interfaces, DTOs definidos aquí, lógica de mapeo |
| `infrastructure/dal/dolibarr/{Entity}sGetAllDal.ts` | `class extends DolibarrDal implements IQueryGetListDal` + `run(dto)` | Tipos de dominio definidos aquí |
| `infrastructure/dal/dolibarr/{entity}DolibarrDto.ts` | Shape fila Dolibarr (snake_case, campos opcionales `?`) | camelCase de dominio |
| `infrastructure/dal/dolibarr/enums/` | Enums **solo infra** (ej. `productMode` para `sqlfilters`) | Enums que el frontend muestra al usuario |
| `infrastructure/dal/dolibarr/mappers/{entity}Mapper.ts` | `toDomain` / `fromDomain` **síncronos** | `async`, llamadas HTTP |
| `infrastructure/dal/dolibarr/mappers/{entity}{Aspect}Mapper.ts` | Traducción enum dominio ↔ valor Dolibarr | — |

**Legacy users (hasta migración router)**: rutas pueden vivir en `backend/routes/users.ts`; el **código nuevo** del slice va en `backend/src/users/` como arriba. Objetivo final: `usersRouter.ts` en `infrastructure/router/`.

**Fichajes (perfil B)**: mismo `domain/` + `infrastructure/dal/`; DALs pueden llamar API custom (`fichajestrabajadoresapi`). `application/` solo para orquestación que no encaja en un solo `run()` — no sustituye al DAL.

### 3.4 Qué va en cada carpeta (frontend)

**Raíz del slice**: `frontend/src/app/{modulo}/` (ej. `products/`, `users/`, `fichajes/`).

| Carpeta / archivo | DEBE contener | NO debe contener |
|-------------------|---------------|------------------|
| `domain/` | **Espejo byte-a-byte** del backend (mismas interfaces, enums, DTOs) | Servicios, HTTP, componentes |
| `domain/enums/` | Enums de negocio (`productStatus.ts`) | Carpeta `Enumerations/` PascalCase (legacy) |
| `application/` | Solo lógica pura: formatters, mappers de error API, validators de dominio | DALs, estado de listado, `HttpClient` (legacy en users — no replicar en módulos nuevos) |
| `infrastructure/components/{recurso}-{accion}/` | `.ts` + `.html` del componente standalone | `.css` en listados estándar (ver §3.5) |
| `infrastructure/components/.../*.ts` | `inject()`, signals, `extends AppQueryBase` / `AppServiceBase` | `constructor()`, NgModule, tipos definidos en el componente |
| `infrastructure/dal/backend/{Entity}sGetAllDal.ts` | `extends QueryBackendDal`, `basePath`, `run()` → `api.queryList` | Lógica de UI, snake_case en tipos de dominio |
| `infrastructure/dal/backend/{Entity}sGetByIdDal.ts` | `extends QueryBackendDal` o patrón item | — |
| `infrastructure/dal/backend/{Entity}sCreate.dal.ts` | `extends ServiceBackendDal`, `post` | — |
| `infrastructure/pipes/{entity}-{aspect}-label.pipe.ts` | Pipe standalone para labels de enum | Lógica de negocio pesada |
| `infrastructure/pipes/{entity}-status-color.pipe.ts` | Color hex / token para badge | — |
| `infrastructure/pipes/{entity}-status-icon.pipe.ts` | Nombre icono Lucide | — |

**Prohibido en módulos migrados al patrón products**:

- `infrastructure/dtos/` con shapes de API (usar `domain/` + `QueryResult`)
- `*-retrieve.service.ts` para listados (usar `AppQueryBase` en el componente)
- `infrastructure/dal/` en raíz del módulo sin `backend/` (legacy `empleados-retrieve.dal.ts`)
- Componente hijo solo para búsqueda (`empleados-filters`) — todo en `{modulo}-getall`

### 3.5 Estilos CSS — global primero (patrón products)

**Regla**: pantallas tipo listado/formulario CRUD siguen **products**: clases globales en el HTML, **sin** `styleUrl` en el componente salvo excepción documentada.

| Referencia | Ubicación |
|------------|-----------|
| Tokens, dark mode | `frontend/src/assets/styles/variables.css` |
| Utilidades layout, KPI, mobile-card | `frontend/src/assets/styles/design-system.css` |
| Tablas, acciones fila | `frontend/src/assets/styles/tables.css` |
| Cards, page-container | `frontend/src/assets/styles/panels.css` |
| Formularios ventana | `frontend/src/assets/styles/form-window.css`, `forms.css` |
| Componentes Material | `frontend/src/assets/styles/components.css` |

**Ejemplo canónico** — `products-getall` solo declara `templateUrl`; **no** tiene `products-getall.css`:

```typescript
@Component({
  selector: 'products-getall',
  standalone: true,
  imports: [/* common + pipes */],
  templateUrl: './products-getall.html',
})
```

**Clases habituales en templates** (Tailwind + utilidades globales):

- Contenedor: `page-container`
- KPIs: `kpi-grid`, `kpi-grid--cols-2`, `kpi-grid--cols-3` + `<kpi-card>`
- Card listado: `premium-card`, `mat-card`
- Cabecera: `card-header`, `card-header-title`, `card-header-subtitle`
- Tabla desktop: `table-container`, `col-status`, componentes `col-*`
- Móvil: `mobile-list-container`, `mobile-card`, `mobile-only` / `desktop-only`
- Vacío: `<card-empty>` (common)

**Cuándo SÍ crear `.css` local** en el componente:

- Modales/diálogos con layout propio (ej. `product-updateprice-dialog.component.css`)
- Posicionamiento o animación que **no** existe en global y no debe reutilizarse
- Overrides Material muy específicos del diálogo

**Cuándo NO crear `.css` local**:

- Listados (`{modulo}-getall`), create/update estándar si el HTML puede usar solo global + Tailwind
- Duplicar estilos ya en `design-system.css` / `panels.css`

Al migrar `employees-list`: eliminar `empleados-list.css` / `empleados-filters.css` si el HTML pasa a las mismas clases que `products-getall.html`.

### 3.6 Árbol objetivo por módulo (sustituir nombres, misma forma)

Sustituir `{entity}`, `{modulo}`, `{recurso}` manteniendo la **misma profundidad de carpetas**:

#### `users` — slice listado empleados (`migrate-employees-list`)

```
backend/src/users/
├── domain/
│   ├── employeeListItem.ts
│   ├── employeesGetAllDto.ts
│   ├── userGroup.ts              # UserGroupRef existente
│   └── enums/
│       └── userStatus.ts
└── infrastructure/
    └── dal/dolibarr/
        ├── employeesGetAllDal.ts
        ├── userDolibarrDto.ts
        ├── userGroupDolibarrDto.ts
        └── mappers/
            ├── employeeListItemMapper.ts
            ├── userGroupMapper.ts
            └── userStatusMapper.ts
# Router: GET /employees en usersRouter (legacy path) hasta move a infrastructure/router/

frontend/src/app/users/
├── domain/                       # espejo de lo anterior
│   ├── employeeListItem.ts
│   ├── employeesGetAllDto.ts
│   ├── userGroup.ts
│   └── enums/userStatus.ts
├── application/                  # solo form/validators legacy hasta CRUD migrate
└── infrastructure/
    ├── components/
    │   └── employees-list/       # antes empleados-list; SIN employees-filters
    │       ├── employees-list.ts
    │       └── employees-list.html
    ├── dal/backend/
    │   └── employeesGetAllDal.ts   # basePath = 'users/employees'
    ├── pipes/
    │   ├── user-status-label.pipe.ts
    │   ├── user-status-color.pipe.ts
    │   └── user-status-icon.pipe.ts
    └── employees-export.service.ts
```

#### `fichajes` — objetivo (change futuro; nombres en inglés)

```
backend/src/fichajes/
├── domain/
│   ├── punch.ts / workday.ts     # según spec punches + workdays
│   └── enums/
│       └── punchStatus.ts        # migrar desde Enumerations/
└── infrastructure/
    ├── router/fichajesRouter.ts  # objetivo
    └── dal/dolibarr/ o dal/custom/
        ├── punchesClockInDal.ts
        └── mappers/

frontend/src/app/fichajes/
├── domain/                       # espejo
├── application/                  # formatters puros (locationStatusMessage, etc.)
└── infrastructure/
    ├── components/
    │   ├── punches-getall/       # ejemplo listado futuro
    │   └── workdays-getall/
    ├── dal/backend/
    └── pipes/
```

Hoy fichajes tiene más `.css` local y `Enumerations/` — al migrar, alinear enums a `domain/enums/` y reducir CSS a global donde coincida con products.

### 3.7 Plantilla de nombres al clonar products → otro módulo

| products | users (empleados) | fichajes (ejemplo) |
|----------|-------------------|---------------------|
| `Product` | `EmployeeListItem` (listado) / `User` (CRUD futuro) | `Punch`, `Workday` |
| `products-getall` | `employees-list` | `punches-getall` |
| `ProductsGetAllDto` | `EmployeesGetAllDto` | `PunchesGetAllDto` |
| `ProductsGetAllDal` (BE) | `EmployeesGetAllDal` | `PunchesGetAllDal` |
| `productsGetAllDal` (FE) | `employeesGetAllDal` | `punchesGetAllDal` |
| `productStatus` | `userStatus` | `punchStatus` |
| `product-status-label.pipe` | `user-status-label.pipe` | `punch-status-label.pipe` |
| `/api/products` | `/api/users/employees` | `/api/fichajes/...` |

---

## 4. Arquitectura backend (patrón products)

### 4.1 Separación de responsabilidades

```
HTTP Request
  → productsRouter.ts          (validación Zod, permisos, scope DI)
  → ProductsXxxDal.run(dto)    (orquestación Dolibarr)
  → ProductMapper              (DolibarrDto ↔ Product)
  → DolibarrClient             (HTTP axios)
```

| Capa | Qué va | Qué NO va |
|------|--------|-----------|
| `domain/` | `Product`, enums, DTOs | Tipos Dolibarr, lógica HTTP |
| `infrastructure/dal/` | DALs, mappers, `ProductDolibarrDto` | Interfaces de negocio nuevas |
| `infrastructure/router/` | Express, `buildZodSchema`, `createRequestScope` | Definir tipos/DTOs |

### 4.2 Interfaces DAL (`backend/src/common/domain/`)

```typescript
// Listado
interface IQueryGetListDal<P, T> {
  run(request: P): Promise<QueryListResult<T>>;
}

// Detalle
interface IQueryGetItemDal<P, T> {
  run(request: P): Promise<QueryItemResult<T>>;
}

// Comandos (create/update/delete)
interface IServiceDal<P, T> {
  run(request: P): Promise<T>;
}
```

### 4.3 `DolibarrDal` (clase abstracta)

Ubicación: `backend/src/common/infrastructure/dolibarr/dolibarrDal.ts`

- Instancia `DolibarrClient` en constructor `(dolikey, entityId)`.
- Helpers protegidos:
  - `mapFiltersFromDomain(value, columns[])` → fragmentos `sqlfilters` Dolibarr
  - `combineSqlFilters(...filters)` → une con ` and `
  - `mapStatusFilterFrom(status, column)`

**GetAll** extiende `DolibarrDal`. **GetById** usa `DolibarrClient` por composición directa (inconsistencia menor aceptada).

### 4.4 `ProductsGetAllDal` — patrón de listado (el más complejo)

Responsabilidades:

1. Normalizar `sortfield` → `t.${sortfield || "rowid"}`
2. Construir `paramsSql` (sqlfilters, mode, status)
3. `this.dolibarr.query2<ProductDolibarrDto>(endpoint, paramsSql, request)`
4. Pipeline RxJS: `map(toDomain)` → `pick(fields)` → `toArray()`
5. Retornar `{ data, pagination }`

**Por qué es más grande que GetById/Create**: paginación, ordenación, filtros SQL, proyección de campos y traducción masiva de filas.

### 4.5 Mappers

- `ProductMapper.toDomain(dto: ProductDolibarrDto): Product`
- `ProductMapper.fromDomain(product: Product): ProductDolibarrDto`
- Mappers pequeños para enums (`ProductStatusMapper`, `ProductModeMapper`, `ProductPriceBaseTypeMapper`)
- Todos extienden `DolibarrMapper` (marcador vacío en common)

**Regla**: dominio limpio en camelCase; DTO Dolibarr en snake_case. Nunca mezclar en `domain/product.ts`.

### 4.6 Router (`productsRouter.ts`)

Patrón por ruta:

```typescript
router.get("/", async (req, res, next) => {
  const { session, query } = req as AuthenticatedRequest;
  const queryRequest = new ProductsGetAllDto(query);
  const scope = createRequestScope(session.dolikey, session.entity);
  const dal = scope.resolve(InjectionTokens.productsGetAllDal);
  const result = await dal.run(queryRequest);
  res.json(result);
});
```

Mutaciones (POST/PUT/DELETE):

```typescript
const parsed = buildZodSchema(ProductsCreateDto).safeParse({ ...req.body, type: ProductType.Product });
if (!parsed.success) {
  return res.status(400).json({ error: "Payload de producto invalido", statusCode: 400, details: z.flattenError(parsed.error) });
}
```

Middleware global del router: `requireHttpRight(productHttpRightPolicy, "No tienes permiso...")`.

### 4.7 DI Awilix (`backend/src/container.ts`)

```typescript
productsGetAllDal: asClass(ProductsGetAllDal, { lifetime: Lifetime.SCOPED }),
// ... una línea por DAL
```

Uso:

```typescript
const scope = createRequestScope(session.dolikey, session.entity);
const dal = scope.resolve(InjectionTokens.productsGetAllDal);
```

Constructor DAL: `constructor(dolikey: string, entityId: number = 1)` — Awilix inyecta por nombre.

Montaje: `server.ts` → `app.use('/api/products', productsRouter)`.

---

## 5. Arquitectura frontend (patrón products)

### 5.1 Flujo de datos

```
Componente (extends AppQueryBase / AppServiceBase)
  → DAL en dal/backend/ (extends QueryBackendDal / ServiceBackendDal)
  → ApiDalService.queryList | queryItem | post | put | delete
  → BFF /api/products
```

### 5.2 Bases comunes

| Clase | Archivo | Uso |
|-------|---------|-----|
| `AppBase` | `common/infrastructure/app-base.ts` | Snackbar, router, `isMobile` |
| `AppQueryBase<DTO, T>` | `app-query-base.ts` | Listados: `formGroupFromDto`, `dal.run()` |
| `AppServiceBase<DTO, T>` | `app-service-base.ts` | Create/Update: `loadDal` + `dal`, `form.disable()` en update |

Constructor en componente hijo:

```typescript
constructor() {
  super(ProductsGetAllDto);  // o ProductsUpdateDto
  this.dal = this.productsGetAllDal;
  // update además:
  this.loadDal = this.productsGetByIdDal;
}
```

### 5.3 DAL frontend canónico

```typescript
@Injectable({ providedIn: 'root' })
export class ProductsGetAllDal extends QueryBackendDal<ProductsGetAllDto, QueryResult<Product>> {
  private api = inject(ApiDalService);
  private basePath = 'products';

  run(request: ProductsGetAllDto): Observable<QueryResult<Product>> {
    return this.api.queryList<QueryResult<Product>>(this.basePath, request);
  }
}
```

- **Lectura lista**: `QueryBackendDal` + `api.queryList`
- **Lectura item**: `QueryBackendDal` + `api.queryItem`
- **Mutación**: `ServiceBackendDal` + `api.post` / `api.put` / `api.delete`

### 5.4 Componente listado (`ProductsGetAllComponent`)

Extiende `AppQueryBase<ProductsGetAllDto, QueryResult<Product>>`.

Patrones UI:

- KPIs (`kpi-card`) filtran por `status`
- Filtro texto en `filterBy` vía `form-field-text`
- Tabla desktop: `mat-table` + columnas `col-icon`, `col-text`, `col-currency`, `col-button`
- Mobile: cards expandibles con `selectedId` signal
- Permisos: `computed` desde `GlobalInfoService`
- `dataSource`: array directo `items()` (no `MatTableDataSource` en este módulo)
- Pipes de dominio para estado (color, icono, label)

### 5.5 Componentes create / update

Extienden `AppServiceBase<ProductsCreateDto | ProductsUpdateDto, Product>`.

- Formulario generado desde `@Field` en DTO (`formGroupFromDto`)
- Secciones: `mat-card` + `card-section` + `form-field-*`
- Update: `ngOnInit` → `this.form.disable()` → botón "Modificar" habilita edición
- Enums en selects: pipe con método `selector()` → `SelectorResult[]`

### 5.6 Pipes de dominio (patrón)

```typescript
@Pipe({ name: 'productStatusLabel', standalone: true })
export class ProductStatusLabelPipe implements PipeTransform {
  transform(status?: ProductStatus): string { /* español */ }
  selector(): SelectorResult[] { /* para mat-select */ }
}
```

Replicar por cada enum visible en UI: `color`, `icon`, `label` si aplica.

### 5.7 Rutas y guards (`app.routes.ts`)

```typescript
{
  path: 'products',
  children: [
    { path: '', loadComponent: () => import('...products-getall')..., canActivate: [canReadProductsGuard] },
    { path: 'create', loadComponent: () => import('...products-create')..., canActivate: [canCreateProductsGuard] },
    { path: ':id', loadComponent: () => import('...products-update')..., canActivate: [canCreateProductsGuard] },
  ]
}
```

Guards: `common/infrastructure/guards/commercial-module.guards.ts`.

---

## 6. `common` — qué reutilizar (DRY / KISS)

### 6.1 Backend `backend/src/common/`

| Artefacto | Ruta | Cuándo usar |
|-----------|------|-------------|
| `QueryListDto` | `domain/queryListDto.ts` | Todo listado paginado |
| `QueryItemDto` | `domain/queryItemDto.ts` | GET por id |
| `QueryListResult` / `QueryItemResult` | `domain/` | Respuestas DAL |
| `field-meta` + `@Field` | `domain/field-meta.ts` | DTOs con metadata |
| `buildZodSchema` | `infrastructure/zodSchemas.ts` | Validación router |
| `DolibarrDal` | `infrastructure/dolibarr/dolibarrDal.ts` | DALs con filtros SQL |
| `DolibarrClient` | `infrastructure/dolibarr/dolibarrClient.ts` | HTTP Dolibarr |
| `DolibarrMapper` | `infrastructure/dolibarr/dolibarrMapper.ts` | Base mappers |
| `AuthenticatedRequest` | `domain/AuthenticatedRequest.ts` | Routers |
| `pick` (RxJS) | `utils/rxjs-utils.ts` | Proyección `fields` en GetAll |
| `EntityResolver` | `infrastructure/EntityResolver.ts` | Hidratar relaciones (órdenes, facturas) |
| Errores tipados | `backend/src/errors/domain/` | Jerarquía `BaseError` |

**No duplicar** en el módulo: lógica de paginación, generación Zod, filtros SQL base.

### 6.2 Frontend `frontend/src/app/common/`

| Artefacto | Cuándo usar |
|-----------|-------------|
| `ApiDalService` | Único HTTP al BFF (`withCredentials: true`) |
| `QueryBackendDal` / `ServiceBackendDal` | Bases DAL |
| `AppQueryBase` / `AppServiceBase` | Componentes listado / formulario |
| `formGroupFromDto` | Formularios desde `@Field` |
| `col-*`, `form-field-*`, `card-*`, `kpi-card` | UI listados y formularios |
| `confirm-dialog` | Borrados |
| Guards en `guards/` | Permisos por módulo |
| DTOs base (`QueryListDto`, etc.) | Espejo backend |

**Imports**: preferir alias `@app/common/...` y `@app/{modulo}/...`.

### 6.3 Contrato `@Field` (un DTO, dos usos)

```
ProductsUpdateDto con @Field
        ├─ buildZodSchema()     → validación backend (router)
        └─ formGroupFromDto()   → FormGroup Angular (frontend)
```

Labels en **español**; nombres de propiedad en **inglés camelCase**.

---

## 7. Flujo end-to-end (listado)

```
Browser GET /api/products?page=0&limit=50&filterBy=mesa&status=1
  → productsRouter: new ProductsGetAllDto(query)
  → ProductsGetAllDal.run(dto)
      → sqlfilters + query2 → Dolibarr /products
      → ProductDolibarrDto[] → ProductMapper.toDomain → Product[]
  → JSON { data: Product[], pagination: {...} }

Angular ProductsGetAllComponent.load()
  → ProductsGetAllDal.run(dto)
  → ApiDalService.queryList('products', dto)
  → mismo JSON
  → items.set(response.data)
```

---

## 8. Checklist para replicar un módulo CRUD (ej. `users`, `fichajes`)

### Backend

- [ ] `domain/{entity}.ts` — interface dominio
- [ ] `domain/enums/` — enums de negocio
- [ ] `domain/{Entity}sGetAllDto.ts` extends `QueryListDto` + filtros `@Field`
- [ ] `domain/{Entity}sGetByIdDto.ts` extends `QueryItemDto`
- [ ] `domain/{Entity}sCreateDto.ts` / `UpdateDto` con `@Field`
- [ ] `domain/{Entity}sDeleteDto.ts`
- [ ] `infrastructure/dal/dolibarr/{entity}DolibarrDto.ts`
- [ ] `infrastructure/dal/dolibarr/mappers/{entity}Mapper.ts`
- [ ] 5 DALs (GetAll, GetById, Create, Update, Delete)
- [ ] `infrastructure/router/{entity}Router.ts`
- [ ] Registrar DALs en `container.ts` (`Lifetime.SCOPED`)
- [ ] Montar en `server.ts` `/api/{entities}`
- [ ] Policy `requireHttpRight` del módulo
- [ ] Tests Vitest (DAL + routes)
- [ ] Verificar: `cd backend && npx tsc --noEmit`

### Frontend

- [ ] Espejar `domain/` del backend
- [ ] `infrastructure/dal/backend/{Entity}sGetAllDal.ts` etc.
- [ ] `{entity}s-getall` extends `AppQueryBase`
- [ ] `{entity}s-create` / `{entity}s-update` extends `AppServiceBase`
- [ ] Pipes de enums si hay estados visibles
- [ ] Rutas en `app.routes.ts` (estáticas antes de dinámicas)
- [ ] Guards existentes o nuevos en `common/guards/`
- [ ] Verificar: `cd frontend && ng build`

---

## 9. Variaciones esperadas por módulo

| Aspecto | products | users (`migrate-employees-list`) | fichajes (esperado) |
|---------|----------|-----------------------------------|---------------------|
| Patrón | Nuevo (referencia) | En curso — listado GetAll | Legacy hoy — migrar |
| DI Awilix | Sí | Solo `employeesGetAllDal` en listado | No aún — añadir |
| API Dolibarr | `/products` estándar | `/users` + filtros employee | API custom `fichajestrabajadoresapi` |
| CRUD puro | Sí | Parcial (solo listado en change 1) | No — acciones (`clock-in`, etc.) |
| Entidad listado | `Product` completa | `EmployeeListItem` (proyección) | `Punch` / `Workday` |
| KPIs estado | `statusCounts` página | **Igual** (`statusCounts` + `kpi-card`) | FE (definir en spec) |
| DTOs `@Field` | Sí | Sí en `EmployeesGetAllDto` | Migrar formularios de acción |
| Common UI | col-*, form-field-* | Reutilizar + pipes `userStatus*` | `punch-card`, `time-hm-input` |
| EntityResolver | Sí (otros módulos) | No en listado (grupos N+1 legacy) | Si hidrata `User` |

**Fichajes**: modelar cada acción como `IServiceDal` con su DTO (`PunchesClockInDto`, etc.), no forzar CRUD si la API no lo es.

**Users**: spec `migrate-employees-list` cerrado — sin `stats` en BFF; `UserGroupRef` en `userGroup.ts`; ruta FE DAL `users/employees`.

---

## 10. Archivos de referencia (leer antes de codificar)

### Backend

| Propósito | Archivo |
|-----------|---------|
| Router + Zod + DI | `products/infrastructure/router/productsRouter.ts` |
| List DAL completo | `products/infrastructure/dal/dolibarr/productsGetAllDal.ts` |
| GetById DAL | `products/infrastructure/dal/dolibarr/productsGetByIdDal.ts` |
| Mapper principal | `products/infrastructure/dal/dolibarr/mappers/productMapper.ts` |
| DTO formulario | `products/domain/productsUpdateDto.ts` |
| DTO listado | `products/domain/productsGetAllDto.ts` |
| DI | `container.ts` |
| Filtros SQL | `common/infrastructure/dolibarr/dolibarrDal.ts` |
| Zod desde @Field | `common/infrastructure/zodSchemas.ts` |

### Frontend

| Propósito | Archivo |
|-----------|---------|
| Listado | `products/infrastructure/components/products-getall/products-getall.ts` + `.html` (**sin .css**) |
| Create | `products/infrastructure/components/products-create/products-create.ts` |
| Update | `products/infrastructure/components/products-update/products-update.ts` |
| DAL listado | `products/infrastructure/dal/backend/productsGetAllDal.ts` |
| AppQueryBase | `common/infrastructure/app-query-base.ts` |
| AppServiceBase | `common/infrastructure/app-service-base.ts` |
| ApiDalService | `common/infrastructure/api.dal.service.ts` |
| Form desde DTO | `common/infrastructure/formField.ts` |

---

## 11. Estado de madurez en `products` (no replicar bugs)

| Área | Estado |
|------|--------|
| GetAll + GetById + mappers | Referencia estable |
| Create / Update / Delete backend | **WIP** — mapper/retornos incompletos |
| Delete frontend en listado | UI preparada, llamada comentada |
| Paginador en template | Comentado |
| `application/*.service.ts` frontend | Comentado — no usar |
| DALs duplicados en `dal/` raíz vs `dal/backend/` | Usar solo `dal/backend/` |
| `domain/Enumerations/` (PascalCase) | Legacy — usar `domain/enums/` |
| `AppServiceBase.onSave` mensajes | Hardcodeados a "Producto" |
| GetById no extiende `DolibarrDal` | Inconsistencia menor |

Antes de replicar mutaciones, **confirmar con usuario** si products debe terminarse primero o si el nuevo módulo debe implementar Create/Update/Delete completos desde el inicio.

---

## 12. Archivos legacy — NO usar como plantilla

### Backend

- `products/infrastructure/dal/dolibarr/productsDal.ts`
- `productMappers.ts`, `productMapper.ts` (raíz dolibarr, fuera de `mappers/`)
- `domain/Enumerations/*` (duplicado de `domain/enums/`)
- `DolibarrProductResponse.ts` si existe duplicado con `productDolibarrDto.ts`

### Frontend

- `application/productsGetAllService.ts` (comentado)
- `application/products-update.service.ts` (comentado)
- `infrastructure/dal/productsGetAllDal.ts` (raíz, usar `dal/backend/`)
- `infrastructure/dal/products-update.dal.ts` (legacy ApiDalService)
- `domain/Enumerations/` vs `domain/enums/` — consolidar en `enums/`

---

## 13. Verificación obligatoria

```bash
# Backend
cd backend && npx tsc --noEmit
cd backend && npm test -- tests/products  # si existen tests del módulo

# Frontend
cd frontend && ng build

# Zero-Any (muestra debe estar vacía en código productivo)
rg "\bany\b" backend/src/{modulo}/ frontend/src/app/{modulo}/
```

Backend Docker tras cambios BFF:

```bash
docker compose down && docker compose build --no-cache backend && docker compose up -d backend
```

---

## 14. Preguntas abiertas — escalar al usuario

El agente **debe preguntar** si no tiene respuesta en spec ni en este documento:

1. ¿El módulo nuevo es CRUD estándar Dolibarr o API custom (como fichajes)?
2. ¿Qué política de permisos `requireHttpRight` / guards aplicar?
3. ¿Los KPIs del listado vienen del backend o se calculan en frontend (como products hoy con `statusCounts`)?
4. ¿Campos del formulario y filtros exactos (lista de `@Field`)?
5. ¿El módulo necesita `EntityResolver` / objetos compuestos en dominio?
6. ¿Create/Update/Delete deben estar completos en la primera entrega o solo listado + detalle?
7. ¿Endpoint Dolibarr exacto y parámetros documentados en `backend/doc/swagger.json`?

---

## 15. Documentos relacionados

| Documento | Propósito |
|-----------|-----------|
| `AGENTS.md` | Constitución global |
| [module-implementation-flow.md](./module-implementation-flow.md) | Orden paso a paso (domain → BE → FE) |
| [common-imports-catalog.md](./common-imports-catalog.md) | Imports de common usados por products |
| [fichajes-migration-notes.md](./fichajes-migration-notes.md) | Plan fichajes (renombres, endpoints) |
| [users-migration-notes.md](./users-migration-notes.md) | Plan users/employees |
| [replicate-module-checklist.md](./replicate-module-checklist.md) | Checklist corto |

---

*Mantener este archivo actualizado cuando `products` evolucione o cuando un módulo migrado establezca un patrón nuevo validado.*
