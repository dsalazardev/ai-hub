# Estándar de código — paridad products / services

> **Audiencia**: todo agente que escriba o revise código en Doligestion.
> **Fuente de verdad**: el código de `products` y `services` (mismo esqueleto). Si este doc y el código canónico divergen, **manda el código de products/services** y luego actualiza este archivo.
> **Complementa**: [products-module-blueprint.md](./products-module-blueprint.md) (esqueleto de módulo), [replicate-module-checklist.md](./replicate-module-checklist.md).
> **Última revisión**: 2026-09-17

---

## 0. Regla de oro

1. **Copiar el patrón general de products/services.** Solo cambian entidad, campos, enums, endpoints y reglas de negocio del módulo.
2. **Si no sabes el tipo, valor o forma de un dato: pregunta al usuario.** Prohibido inventar uniones (`string | number`), opcionales “por si acaso”, o magic strings.
3. **Módulos custom** (p. ej. `projectsonna`, fichajes API propia) pueden tener endpoints y DALs distintos, pero **naming, carpetas, `id`, enums, `@Field`, dominio FE≡BE y Zero-Any** siguen este estándar.

---

## 1. `id` — invariante

| Capa | Regla |
|------|--------|
| `domain/` (FE y BE) | `id: number` **siempre**. **Sin** `?`. Es el **único** campo obligatorio de la entidad; el resto con `?`. |
| `*DolibarrDto` (infra) | Igual que products/services: `id: number` **sin** `?`. Dolibarr a veces envía `"1"` como string en JSON: el **mapper** hace `Number(item.id)`. |
| Prohibido | `id?: …`, `id: number \| string`, `id: string` en dominio limpio, `id: string \| number`. |

```typescript
// Correcto (domain + DolibarrDto)
id: number;

// Incorrecto
id?: number;
id: number | string;
id: string; // en domain limpio
```

---

## 2. Tipos: no adivinar

- **Prohibido** uniones “por incertidumbre” (`string | number`, `A | B` en un campo de dominio) salvo que el contrato de negocio lo exija y esté en el spec.
- Si la API real no está clara → **preguntar** o mirar respuesta real / swagger; no tipar a ciegas.
- Zero-Any: usar `unknown` + type guard solo en fronteras externas cuando haga falta.
- Campos opcionales: solo si el dominio/API realmente los omiten → `campo?: Tipo` (nunca mezclar con uniones inventadas).

---

## 3. Enums y magic strings

- Estados / tipos de negocio **numéricos** (como Dolibarr): `enum` **numérico** en `domain/enums/` (ej. `ProductStatus { Inactive = 0, … }`).
- **Prohibido** magic strings sueltos en filtros SQL, comparaciones de estado, query params de negocio (`'open'`, `'1'` hardcodeado) → usar el enum.
- Enum **string** solo cuando el contrato real es código string estable (ej. roles de contacto `BILLING`) y products/el módulo de referencia ya lo hace así; documentarlo en el spec.
- Constantes nombradas para límites, paths de segmento fijo (`'selector'`), etc., cuando se reutilicen.

---

## 4. Classes con `@Field` vs interfaces

| Artefacto | Forma | Dónde |
|-----------|--------|--------|
| Entidad de dominio (`Product`, `Project`) | `interface` | `domain/{entity}.ts` |
| DTO de query/comando (GetAll, Create, Update…) | `class` + `@Field({…})` | `domain/{resource}{Op}Dto.ts` |
| Shape cruda Dolibarr | `interface` | `infrastructure/dal/dolibarr/{entity}DolibarrDto.ts` |
| Shape cruda liviana (selector) | `interface` | `…/{entity}SelectorDolibarrDto.ts` (mismo estilo que `productDolibarrDto`) |
| Selector de UI BFF | `SelectorDto` (`id` + `description`) | `common/domain/selectorDto` — no inventar otro shape |

- `@Field` lleva `label` en **español** (UI); identificadores en **inglés**.
- DTOs FE y BE **idénticos** (mismas propiedades y `@Field`); solo cambian imports (`@app/…` vs relativos).

---

## 5. Naming y ubicación de archivos

### Backend (`backend/src/{module}/`)

```
domain/
  {entity}.ts                 # interface
  enums/{Entity}Status.ts
  {resources}GetAllDto.ts     # class + @Field
  {resources}CreateDto.ts
infrastructure/
  dal/dolibarr/
    {entity}DolibarrDto.ts
    {entity}SelectorDolibarrDto.ts   # si hay selector liviano
    {resources}GetAllDal.ts
    {resources}SelectorDal.ts        # GET …/selector
    mappers/{entity}Mapper.ts
  router/{resources}Router.ts
```

- Recurso plural en DALs/rutas: `productsGetAllDal`, `projectsSelectorDal`.
- Entidad singular en DTO Dolibarr: `productDolibarrDto`, `projectSelectorDolibarrDto`.
- Selectores: ruta estática `GET /selector` **antes** de `/:id`; respuesta `SelectorDto[]`; **sin** N+1 ni stats de listado.

### Frontend (`frontend/src/app/{module}/`)

```
domain/          # espejo del backend
infrastructure/
  dal/backend/{resources}GetAllDal.ts
  dal/backend/{resources}SelectorDal.ts
  components/{resources}-getall/
```

- Dominio FE ≡ BE (paridad de ficheros y tipos).
- Español solo en labels `@Field` y texto de plantillas.

---

## 6. Capas (Clean Architecture)

- Tipos **solo** en `domain/` (o DTO Dolibarr en `dal/dolibarr/`). Routes/components **importan**, no declaran interfaces de negocio.
- DALs G2: un caso de uso ≈ un DAL + `run()`.
- Listado rico (`GetAll` + stats/paginación) **≠** selector (`SelectorDal`). No un boolean “includeX” que mezcle responsabilidades caras.
- Mapper: frontera snake_case → camelCase; `Number(id)`; sin lógica de UI.

---

## 7. Checklist rápido (antes de marcar hecho)

- [ ] ¿Existe el mismo patrón en `products` o `services`? Si sí, ¿lo copié?
- [ ] ¿`id: number` sin `?` en domain y DolibarrDto?
- [ ] ¿Sin `number | string` / uniones inventadas?
- [ ] ¿Enums numéricos para estados; sin magic strings de negocio?
- [ ] ¿DTOs = `class` + `@Field`; entidades = `interface`?
- [ ] ¿Dominio FE alineado byte-a-byte con BE?
- [ ] ¿Naming/ubicación como la tabla de la §5?
- [ ] ¿Si dudé de un tipo/campo, pregunté en lugar de inventar?

---

## 8. Referencias canónicas (abrir el código)

| Qué | Dónde |
|-----|--------|
| Entidad + id | `backend/src/products/domain/product.ts` |
| DTO `@Field` | `backend/src/products/domain/productsGetAllDto.ts` ≡ FE |
| Enum numérico | `backend/src/products/domain/enums/productStatus.ts` |
| DolibarrDto | `backend/src/products/infrastructure/dal/dolibarr/productDolibarrDto.ts` |
| DAL listado | `…/productsGetAllDal.ts` |
| Services (paridad) | `backend/src/services/`, `frontend/src/app/services/` |
| Selector (terceros/users) | `thirdpartiesSelectorDal`, `usersSelectorDal`, `GET /selector` |
| Blueprint módulo | [products-module-blueprint.md](./products-module-blueprint.md) |
