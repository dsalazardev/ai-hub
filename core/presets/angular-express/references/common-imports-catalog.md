# Catálogo de imports `common` (desde el patrón `products`)

> Inventario de lo que **products** importa de `common` y para qué sirve. Usar al implementar otros módulos (DRY).

---

## Backend — `backend/src/common/`

### Domain

| Símbolo | Ruta | Uso en products | Cuándo reutilizar |
|---------|------|-----------------|-------------------|
| `QueryListDto` | `domain/queryListDto.ts` | Base de `ProductsGetAllDto` | Todo listado paginado |
| `QueryItemDto` | `domain/queryItemDto.ts` | Base de `ProductsGetByIdDto` | GET por id |
| `QueryListResult<T>` | `domain/queryListResult.ts` | Retorno GetAll DAL | Listados |
| `QueryItemResult<T>` | `domain/queryItemResult.ts` | Retorno GetById DAL | Detalle |
| `SortOrder` | `domain/queryListDto.ts` | Orden ASC/DESC | Listados |
| `Field`, `FieldType`, `FieldGenere`, `FieldSubType` | `domain/field-meta.ts` | Decoradores en DTOs | Formularios + Zod |
| `AuthenticatedRequest` | `domain/AuthenticatedRequest.ts` | Router: session | Todos los routers |
| `IQueryGetListDal` | `domain/IQueryGetListDal.ts` | `ProductsGetAllDal` | List DALs |
| `IQueryGetItemDal` | `domain/IQueryGetItemDal.ts` | `ProductsGetByIdDal` | GetById DALs |
| `IServiceDal` | `domain/IServiceDal.ts` | Create/Update/Delete DALs | Mutaciones |

**Legacy (evitar en módulos nuevos)**:

| Símbolo | Notas |
|---------|-------|
| `QueryRequest` | Usado en `catalogGetAllUseCase`, `servicesGetAllDal` legacy |
| `IQueryGetAllPaginatedDal` | Patrón viejo multi-arg |

### Infrastructure

| Símbolo | Ruta | Uso en products |
|---------|------|-----------------|
| `DolibarrDal` | `infrastructure/dolibarr/dolibarrDal.ts` | GetAll, Create, Update, Delete |
| `DolibarrClient` | `infrastructure/dolibarr/dolibarrClient.ts` | GetById (composición directa) |
| `DolibarrMapper` | `infrastructure/dolibarr/dolibarrMapper.ts` | Base de todos los mappers |
| `buildZodSchema` | `infrastructure/zodSchemas.ts` | Router POST/PUT/DELETE |
| `pick` | `utils/rxjs-utils.ts` | Proyección `fields` en GetAll |

**Helpers heredados vía `DolibarrDal`**:

- `mapFiltersFromDomain(value, columns[])`
- `combineSqlFilters(...filters)`
- `mapStatusFilterFrom(status, column)`

**`DolibarrClient.query2`** (vía `this.dolibarr`):

- Paginación: `page`, `limit`, `pagination_data`
- Sort: `sortfield`, `sortorder`
- Filtros custom en `params`

### Errores (fuera de `common/`, transversal)

`backend/src/errors/domain/` — `ArgumentError`, `ForbiddenError`, etc. Usar en DALs y dejar propagar al middleware.

---

## Frontend — `frontend/src/app/common/`

### Domain (espejo backend)

| Símbolo | Uso en products |
|---------|-----------------|
| `QueryListDto` | `ProductsGetAllDto` |
| `QueryItemDto` | `ProductsGetByIdDto` |
| `QueryResult<T>` | Tipo retorno listado (`data` + `pagination`) |
| `QueryItemResult<T>` | Retorno GetById |
| `field-meta` | `@Field` en DTOs |
| `SelectorResult` | Pipes `selector()` para enums |
| `SelectorResponse` | Modal precios (selectores API) |
| `nullToUndefined` | Normalización en modales |

### Infrastructure — HTTP y bases

| Símbolo | Ruta | Uso en products |
|---------|------|-----------------|
| `ApiDalService` | `api.dal.service.ts` | Todos los DALs |
| `QueryBackendDal` | `dal/backend/queryBackendDal.ts` | GetAll, GetById |
| `ServiceBackendDal` | `dal/backend/serviceBackendDal.ts` | Create, Update, ChangePrice |
| `AppQueryBase` | `app-query-base.ts` | `ProductsGetAllComponent` |
| `AppServiceBase` | `app-service-base.ts` | Create, Update |
| `formGroupFromDto` | `formField.ts` | Vía bases: FormGroup desde DTO |

**Métodos `ApiDalService` usados por products**:

| Método | Operación |
|--------|-----------|
| `queryList(url, QueryListDto)` | GetAll |
| `queryItem(url, QueryItemDto)` | GetById |
| `post(url, body)` | Create |
| `put(url, id, body)` | Update |
| `delete(url, id)` | Delete |

### Infrastructure — Componentes UI (listados)

| Componente | Uso en products-getall |
|------------|------------------------|
| `kpi-card` | Total / Activos / Inactivos |
| `card-header`, `card-empty` | Cabecera y vacío |
| `col-icon`, `col-text`, `col-currency`, `col-empty`, `col-button` | Columnas tabla |
| `form-field-text`, `form-submit` | Filtro búsqueda |
| `confirm-dialog` | Confirmar borrado |

### Infrastructure — Componentes UI (formularios)

| Componente | Uso en create/update |
|------------|---------------------|
| `card-section` | Secciones del formulario |
| `form-field-text`, `area`, `boolean`, `enum`, `number`, `euro` | Campos |
| `form-button`, `form-submit`, `form-button-principal` | Acciones |

### Guards

| Guard | Módulo products |
|-------|-----------------|
| `canReadProductsGuard` | Listado |
| `canCreateProductsGuard` | Create, Update |

Definidos en `common/infrastructure/guards/commercial-module.guards.ts`.

---

## Matriz: qué va en `common` vs módulo

| Va en `common` | Va en el módulo |
|----------------|-----------------|
| Paginación genérica (`QueryListDto`) | `Product`, `ProductsGetAllDto` |
| `buildZodSchema`, `formGroupFromDto` | Campos `@Field` del recurso |
| `DolibarrDal` helpers SQL | `ProductDolibarrDto`, mappers |
| `ApiDalService` | `ProductsGetAllDal` |
| `col-*`, `form-field-*`, `kpi-card` | Pipes `{entity}Status*` (ej. `productStatus*`, `userStatus*`) |
| `AppQueryBase` | `ProductsGetAllComponent` |

**Criterio KISS**: Si solo un módulo lo usa y no es genérico → **no** subir a common. Si 2+ módulos lo repetirían → valorar extraer (ej. parametrizar mensajes de `AppServiceBase`).

---

## Imports preferidos

- Frontend cross-module: `@app/common/...`, `@app/products/...`
- Backend: rutas relativas `../../common/...` desde `domain/` o `infrastructure/`

---

*Ampliar este catálogo cuando un módulo migrado importe algo nuevo de common que products no usa.*
