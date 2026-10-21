# Notas de migración: `users` → patrón `products`

> **Estado**: listado y CRUD employees migrados. **`migrate-users-repository-split` archivado (2026-06-26)**. **`cleanup-users-rights` completado (2026-06-29)**. **`migrate-auth-router` completado (2026-06-29)**. Módulo `users` completamente migrado al patrón `products`.
>
> **Referencias**: [module-implementation-flow.md](./module-implementation-flow.md), [products-module-blueprint.md](./products-module-blueprint.md) (§0.1 paridad products)

---

## Regla de paridad products

Migración **users/employees**: mismo esqueleto que `products-getall` / `ProductsGetAllDal`. Cambian solo:

- Entidad `EmployeeListItem`, enum `UserStatus`, pipes `userStatus*`
- Ruta BFF `/api/users/employees`, campos Dolibarr de usuario
- Extensiones de pantalla (tab fichajes, export) — UI con **common** (`kpi-card`, `col-*`), sin patrones legacy

**Prohibido** mantener diferencias “porque users ya lo hacía así” si products define el patrón (retrieve service, `stats` BFF, KPIs con requests extra, enums ES en listado).

---

## Resumen del estado actual

| Aspecto | Situación |
|---------|-----------|
| Perfil | **C** transversal + **A** parcial en employees |
| Backend | `infrastructure/api/usersRouter.ts`, `authsRouter.ts`; Awilix parcial (employees + users list/groups) |
| DAL | DALs Awilix (`usersListDal`, `usersGroupsListDal`, `usersGetUserGroupsDal`, `usersLoginDal`) + DALs employees |
| Frontend | Rutas `/employees` (EN); componentes `employees-*` (list, form, change-password); legacy `empleados-*` eliminado |
| KPIs listado empleados | **Frontend** — `statusCounts` + `kpi-card` (patrón `products-getall`) |
| Container | employees + users list/groups registrados en Awilix |

---

## Partes del módulo (no migrar todo a la vez)

| Slice | Responsabilidad | Patrón products |
|-------|-----------------|-----------------|
| **Auth** | login, logout, me, cookies | Commands (`UsersLogin`, `UsersGetMe`) — no CRUD |
| **Rights** | `Right*`, `commercialModuleHttpPolicies` | **No mover** — usado por todos los módulos |
| **Employees** | CRUD empleados, listado paginado | **Sí** — candidato principal a products pattern |
| **Users admin** | getAll users, groups | Migrar tras employees o en paralelo según spec |

**Recomendación**: primer OpenSpec change = **`migrate-employees-list`** (solo listado + renombre ES→EN), sin tocar auth/rights en ese change. CRUD y limpieza de permisos en changes posteriores.

---

## Endpoints BFF actuales

### Auth (`/api/auth`, `/api/login`)

| Método | Ruta | Handler |
|--------|------|---------|
| GET | `/me` | `UsersGetMe` |
| POST | `/login` | `UsersLogin` |
| POST | `/logout` | cookies |

### Users (`/api/users`)

| Método | Ruta | Implementación actual |
|--------|------|------------------------|
| GET | `/` | `UsersListDal` → `UserListItem` |
| GET | `/employees` | `EmployeesGetAllDal` (paginado + stats) |
| GET | `/employees/selector` | `EmployeesSelectorDal` |
| GET | `/groups` | `UsersGroupsListDal` |
| GET | `/:id` | `EmployeesGetByIdDal` → `{ item: Employee }` |
| GET | `/:id/groups` | `UsersGetUserGroupsDal` → `UserGroupRef[]` |
| POST | `/` | `EmployeesCreateDal` → `usersonna/users` |
| PUT | `/:id` | `EmployeesUpdateDal` → `PUT users` + setGroup |
| PUT | `/change-password` | `ChangePasswordCommand` |
| DELETE | `/:id` | `EmployeesDeleteDal` |

**API custom Dolibarr**: `usersonna/users` para create/update/password — documentar en spec; no asumir CRUD estándar `/users`.

---

## Mapa de renombrado (propuesta)

| Actual | Propuesta |
|--------|-----------|
| `Enumerations/EstadosUsuario` | `domain/enums/userStatus.ts` |
| `Enumerations/Generos` | `domain/enums/gender.ts` |
| `UsuarioListadoDto` | `UserListItem` en `domain/` (listado admin `GET /api/users`) |
| `UsuarioListadoDto` (employees) | `EmployeeListItem` en `domain/` (listado paginado `GET /api/users/employees`) |
| `empleados-list/` | `employees-list/` |
| `empleados-change-password-page/` | `employees-change-password/` |
| `EmpleadosListComponent` | `EmployeesListComponent` |
| `empleadoForm.types` | `employeeForm.types` |
| `usersRespository.ts` | Eliminado (fase 2); mapper en `dolibarr/mappers/dolibarrUserMapper.ts` |
| `infrastructure/api/` | `infrastructure/router/` |

**Mantener en español**: labels UI, mensajes de error.

---

## DTOs objetivo (employees — patrón products)

| DTO | Base | Notas |
|-----|------|-------|
| `EmployeesGetAllDto` | `QueryListDto` | `filterBy`, `status?: UserStatus`; camelCase |
| Respuesta listado | `QueryListResult<EmployeeListItem>` | Sin `stats`; filas camelCase vía mapper |
| `EmployeesGetByIdDto` | `QueryItemDto` | |
| `EmployeesCreateDto` | `@Field` | Campos formulario empleado |
| `EmployeesUpdateDto` | extends Create o Update base | |
| `EmployeesDeleteDto` | `id` | |

Sincronizar FE ↔ BE antes de DALs.

**Stats en listado** — decisión cerrada:

- El BFF **elimina** `stats` en `migrate-employees-list`.
- KPIs **solo frontend**, **igual que products**: `statusCounts` desde `response.data` en cada `load()`, UI con `KpiCardComponent` + pipes `userStatus*`.
- **Prohibido**: requests HTTP extra (`forkJoin`, `limit=1`) solo para contadores de estado.

---

## Imports `common` ya usados

### Backend

- `contexto`, `commandBase`, `queryBase`, `passwordPolicy`
- `DolibarrClient`, `QueryRequest` (legacy en employees), `buildSqlFilter`, `dateMapper`
- `requireHttpRightMiddleware` — definido en users, usado globalmente

### Frontend

- `ApiDalService`, `confirm-dialog`, guards `can-manage-users`
- `generic-table-pdf/csv`, `table-export.interface`
- Tras migración: `AppQueryBase`, DALs en `dal/backend/`

---

## Riesgos transversales

| Riesgo | Mitigación |
|--------|------------|
| Romper `commercialModuleHttpPolicies` | No mover en primer change |
| Romper login/me | Auth en change separado |
| `Right*` en FE/BE | Solo renombrar con spec dedicado |
| `GlobalInfoService` | Sigue inyectándose en listados; no duplicar |

---

## Flujo OpenSpec sugerido

| Orden | Change | Estado |
|-------|--------|--------|
| 1 | **`migrate-employees-list`** | Archivado 2026-06-26 |
| 2 | **`migrate-employees-crud`** | Archivado 2026-06-29 |
| 3 | `migrate-employees-selector` | N/A (ya existía `EmployeesSelectorDal`) |
| 4 | **`migrate-users-repository-split`** | Archivado 2026-06-26 |
| 5 | `cleanup-users-rights` | Completado 2026-06-29 |
| 6 | `migrate-auth-router` | Opcional, último |

**Fuera del primer change (confirmado)**: `GET /api/users` raíz, login/logout/me, rights — se tocan en changes dedicados al final del plan.

---

## Decisiones del usuario (2026-06-26)

| Tema | Decisión |
|------|----------|
| **Orden de migración global** | Primero **users/employees**, fichajes después |
| **Paridad products** | General igual; solo cambian datos de dominio ([blueprint §0.1](./products-module-blueprint.md#01-regla-de-paridad-products-general-igual-datos-distintos)) |
| **KPIs listado employees** | Solo **frontend** — `statusCounts` + `kpi-card` como `products-getall` |
| **Primer change employees** | **Solo listado** (opción A) — como `products-getall` antes del CRUD |
| **Alcance endpoint** | **Solo `/employees`** — como products; **no** migrar `GET /api/users` en el primer paso |
| **Renombre carpetas** | **`empleados-*` → `employees-*` en el mismo change** que el listado |
| **Auth / login** | No en el primer change; al final del plan hay que dejarlo todo limpio |
| **Permisos (`Right*`, policies)** | Funcionalidad **igual que ahora**; en un change posterior: actualizar, eliminar código sobrante y dejarlo perfecto (el usuario indica que hoy está bastante bien) |
| **Próximo paso** | `/opsx:archive cleanup-users-rights` o `/opsx:propose migrate-auth-router` |

---
