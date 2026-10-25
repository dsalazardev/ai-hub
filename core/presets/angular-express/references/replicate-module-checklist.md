# Checklist rápido: replicar módulo desde `products`

> Estándar de código: [products-coding-standard.md](./products-coding-standard.md)  
> Referencia completa: [products-module-blueprint.md](./products-module-blueprint.md) — **§0.1 Regla de paridad**: general igual que products; solo cambian entidad, enums, campos y endpoints del módulo.
>
> Usar en cada tarea Spec Kit antes de escribir código.

---

## Antes de empezar

- [ ] Leí `products-coding-standard.md` (`id: number`, enums numéricos, `@Field`, naming, dominio FE≡BE, preguntar si dudas)
- [ ] Leí `products-module-blueprint.md` secciones 0, 2, 3 y 9
- [ ] Leí `backend/doc/swagger.json` para endpoints del módulo
- [ ] Spec Spec Kit aprobada por el usuario
- [ ] Confirmé si el módulo es CRUD estándar o API custom (fichajes)
- [ ] Confirmé permisos (`requireHttpRight` / guards)

## Nomenclatura

- [ ] Carpeta módulo: inglés plural (`users`, `fichajes`)
- [ ] Entidad: PascalCase singular (`Product`, `EmployeeListItem` si es proyección de listado)
- [ ] DTOs: `{Entity}s{Operation}Dto`
- [ ] DALs: `{Entity}s{Operation}Dal`
- [ ] UI español; código inglés camelCase
- [ ] Enums en `domain/enums/{name}.ts`

## Backend

- [ ] `domain/{entity}.ts`
- [ ] DTOs: GetAll, GetById, Create, Update, Delete
- [ ] `@Field` en DTOs de escritura y filtros de listado
- [ ] Solo `id: number` en domain — **prohibido** `id?:` (grep en `domain/`)
- [ ] DolibarrDto snake_case en infrastructure; domain camelCase
- [ ] GetAll: pipeline `pick(request.fields)` si aplica (hereda `QueryListDto`)
- [ ] Mappers en `mappers/` con `toDomain` / `fromDomain`
- [ ] 5 DALs con `run(request)` único (o solo GetAll si el change es slice parcial, como `migrate-employees-list`)
- [ ] GetAll extiende `DolibarrDal` si hay filtros SQL
- [ ] Router: `createRequestScope` + `InjectionTokens`
- [ ] POST/PUT/DELETE: `buildZodSchema(Dto).safeParse()`
- [ ] Registro en `container.ts` (SCOPED)
- [ ] Montaje en `server.ts`
- [ ] `npx tsc --noEmit` sin errores
- [ ] Sin `any`

## Frontend

- [ ] Espejo exacto de `domain/` del backend
- [ ] DALs en `infrastructure/dal/backend/`
- [ ] `QueryBackendDal` (lecturas) / `ServiceBackendDal` (mutaciones)
- [ ] Listado: `extends AppQueryBase` (sin `application/*RetrieveService` salvo spec explícito)
- [ ] Create/Update: `extends AppServiceBase`
- [ ] Componentes en `infrastructure/components/{entity}-{action}/`
- [ ] `standalone: true`, `inject()`, `@if`/`@for`
- [ ] UI: `col-*`, `form-field-*`, `card-*` desde common
- [ ] Pipes para enums visibles (label, color, icon)
- [ ] Rutas en `app.routes.ts` (`create` antes de `:id`)
- [ ] Guards en `common/guards/`
- [ ] `ng build` sin errores
- [ ] Sin `any`

## No hacer

- [ ] No copiar archivos legacy (ver blueprint sección 12)
- [ ] No inventar endpoints ni campos Dolibarr
- [ ] No definir tipos en routers o componentes
- [ ] No heredar de `DolibarrDal` (solo composición)
- [ ] No usar `NgModule`, constructor injection, `*ngIf`

## Si hay duda

**Preguntar al usuario** — no asumir ni implementar placeholders.
