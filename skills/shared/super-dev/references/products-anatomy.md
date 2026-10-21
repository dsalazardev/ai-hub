# Anatomía del módulo `products` — referencia canónica

> Verificado leyendo los 33 ficheros del módulo (FE+BE) el 2026-07-27.
> Products es el módulo de referencia del proyecto. **Copia el esqueleto, no los defectos** (§8).

---

## 1. Mapa de ficheros

### Backend — `backend/src/products/` (23 ficheros)

```
domain/                                   ← contrato puro, cero dependencias de infraestructura
  product.ts                              Product (id obligatorio, resto opcional)
  productsGetAllDto.ts                    extends QueryListDto + status? + filterBy
  productsGetByIdDto.ts                   extends QueryItemDto (vacío)
  productsCreateDto.ts                    16 campos con @Field
  productsUpdateDto.ts                    extends ProductsCreateDto + id
  productsDeleteDto.ts                    solo id
  productsChangePriceDto.ts               caso de uso extra (7 campos de precio)
  enums/{productStatus,productType,productPriceBaseType}.ts

infrastructure/
  dal/dolibarr/
    productDolibarrDto.ts                 shape CRUDO snake_case de Dolibarr
    productsGetAllDal.ts                  extends DolibarrDal  implements IQueryGetListDal
    productsGetByIdDal.ts                 instancia DolibarrClient  implements IQueryGetItemDal
    productsCreateDal.ts                  extends DolibarrDal  implements IServiceDal
    productsUpdateDal.ts                  extends DolibarrDal  implements IServiceDal
    productsDeleteDal.ts                  extends DolibarrDal  implements IServiceDal
    productsChangePriceDal.ts             extends DolibarrDal  implements IServiceDal
    enums/productMode.ts                  enum SOLO de capa DAL (no va en domain/)
    mappers/
      productMapper.ts                    toDomain / fromDomain
      productStatusMapper.ts              un mapper por enum
      productModeMapper.ts
      productPriceBaseTypeMapper.ts
  router/productsRouter.ts                6 endpoints
```

### Frontend — `frontend/src/app/products/` (33 ficheros)

```
domain/                                   ← ESPEJO del backend
  product.ts  + 6 DTOs  + enums/          (product-stats.ts y product-list-filters.ts están 100% comentados)

application/                              ← 100% COMENTADO (muerto). Products NO usa capa application.

infrastructure/
  dal/backend/                            ← patrón vigente (camelCase)
    productsGetAllDal.ts                  extends QueryBackendDal
    productsGetByIdDal.ts                 extends QueryBackendDal
    productsCreate.dal.ts                 extends ServiceBackendDal
    productsUpdate.dal.ts                 extends ServiceBackendDal
    productsChangePriceDal.ts             extends ServiceBackendDal (clase: ProductsUpdatePriceDal)
  dal/                                    ← LEGACY (kebab-case, fuera de backend/)
    products-retrieve.dal.ts              solo delete() — SÍ se usa
    products-update.dal.ts                MUERTO (usa api.read/api.update deprecated)
    products-retrieve.dal.spec.ts         único test del frontend de products
  components/
    products-getall/{ts,html}             extends AppQueryBase
    products-create/{ts,html}             extends AppServiceBase
    products-update/{ts,html}             extends AppServiceBase (+ loadDal)
  pipes/
    product-status-label.pipe.ts          transform() + selector()
    product-status-color.pipe.ts          hex
    product-status-icon.pipe.ts           nombres Lucide
    product-price-base-type-label.pipe.ts transform() + selector()
```

---

## 2. Trazado de una petición (listado)

```
products-getall.html  (submit)
  → ProductsGetAllComponent.load()
      form.getRawValue() + fields:'id,status,ref,label,toSell,price,toBuy,costPrice'
  → ProductsGetAllDal.run(dto)                       [FE, QueryBackendDal]
  → ApiDalService.queryList('products', dto)          filtra null/undefined/'' → query params
  → GET /api/products?...  (withCredentials)
─────────────────────────────────────────────────────────── BFF
  → server.ts  cors → cookieParser → tenantContext → auth (CookiesDal.validate)
  → productsRouter  requireHttpRight(productHttpRightPolicy)
  → new ProductsGetAllDto(query)                      sin Zod (params opcionales)
  → createRequestScope(session.dolikey, session.entity).resolve(productsGetAllDal)
  → ProductsGetAllDal.run()
      sortfield → `t.${sortfield || 'rowid'}`
      combineSqlFilters( mapFiltersFromDomain(filterBy, ['t.label','t.ref']),
                         filtros t.tobuy / t.tosell derivados de status )
      mode = 1 (ProductMode.Products)
  → DolibarrClient.query2('products', paramsSql, request)
      + _t (cache-bust), pagination_data, limit, page, sortorder normalizado
─────────────────────────────────────────────────────────── Dolibarr
  ← ProductDolibarrDto[]  (snake_case, tipos PHP)
  → RxJS: from(data) |> map(productMapper.toDomain) |> pick(fields) |> toArray()
  → { data: Product[], pagination }
─────────────────────────────────────────────────────────── FE
  → items.set(response.data); total.set(response.pagination.total)
  → template: @if(isMobile()) cards @else mat-table + grid-paginator
```

---

## 3. Backend — lo que hay que copiar

**Interfaces DAL** (`common/domain/`): `IQueryGetListDal` (→ `QueryResult<T>`), `IQueryGetItemDal` (→ `QueryItemResult<T>`), `IServiceDal` (→ `T`). Un único método `run(request)`.

**Herencia**: `GetAll/Create/Update/Delete/ChangePrice` → `extends DolibarrDal`. `GetById` → instancia `DolibarrClient` directo (no necesita filtros SQL).

**Mappers como propiedades privadas**, nunca inyectados:
```typescript
private productMapper = new ProductMapper();
private productModeMapper = new ProductModeMapper();
```

**Router**: `GET` sin Zod, `POST/PUT/PATCH/DELETE` con `buildZodSchema(Dto).safeParse()`. El router **enriquece** el payload antes de validar:
```typescript
buildZodSchema(ProductsCreateDto).safeParse({ ...req.body, type: ProductType.Product });
buildZodSchema(ProductsUpdateDto).safeParse({ ...req.body, id, type: ProductType.Product });
```
Siempre `catch { next(error) }`.

**Permisos**: `router.use(requireHttpRight(productHttpRightPolicy, 'mensaje'))` a nivel de router completo. La policy mapea método HTTP → flag (`allowsCrudHttpMethod`) y añade `blockWhenTaxitronic`.

**Endpoints reales**:
| Método | Ruta | DAL |
|--------|------|-----|
| GET | `/api/products` | `productsGetAllDal` |
| GET | `/api/products/:id` | `productsGetByIdDal` |
| POST | `/api/products` | `productsCreateDal` |
| PUT | `/api/products/:id` | `productsUpdateDal` |
| PATCH | `/api/products/:id/price` | `productsChangePriceDal` |
| DELETE | `/api/products/:id` | `productsDeleteDal` |

**Retornos de los DAL de escritura** (inconsistentes entre sí, ver §8):
- Create → `{ id: result.id }` (lee el id real de Dolibarr)
- Update / ChangePrice / Delete → el `request` original

---

## 4. Mapper — la parte con más lógica

`productMapper.toDomain()` no es un renombrado plano: **resuelve el precio según la base imponible**.

```typescript
const priceBaseType = this.priceBaseTypeMapper.toDomain(item.price_base_type);  // 'HT'|'TTC' → enum
const price = priceBaseType === ProductPriceBaseType.ConIVA
  ? (item.price_ttc ?? item.price)     // TTC → price_ttc, con fallback a price
  : item.price;                        // HT  → price
```

`fromDomain()` hace lo inverso y **excluyente**: rellena `price` **o** `price_ttc`, nunca los dos.

Conversiones sistemáticas:
| Tipo | Dolibarr | Dominio | Regla |
|------|----------|---------|-------|
| string | `ref`, `label`, `note_public` | string | `?? ''` — nunca undefined |
| booleano | `status`, `status_buy` (0/1) | `toSell`, `toBuy` | `x != null ? Boolean(Number(x)) : undefined` |
| número | `price`, `tva_tx` | number | `x !== undefined ? Number(x) : undefined` |
| medidas | `weight`, `length` (**string**) | number | `Number(x)` al leer, `String(x)` al escribir |
| enum | `price_base_type` `'HT'\|'TTC'` | `ProductPriceBaseType` | mapper dedicado |

Nunca `if (valor)` para números/booleanos: colapsaría `0` y `false`.

---

## 5. Frontend — lo que hay que copiar

**Listado** (`AppQueryBase`): el `FormGroup` **es** el estado de filtros y paginación. No hay signals de filtros — `page`, `limit`, `status`, `filterBy` viven en `controls[...]`.

```typescript
protected onPageChange(event: PageEvent): void {
  this.form.patchValue({ page: event.pageIndex, limit: event.pageSize });
  this.load();
}
```

Solo hay signals para lo que devuelve el servidor: `items`, `total`, `selectedId`.

**`fields` se inyecta en `load()`, nunca en el DTO**:
```typescript
const dto = { ...this.form.getRawValue(), fields: 'id,status,ref,label,toSell,price,toBuy,costPrice' } as ProductsGetAllDto;
```

**Create/Update** (`AppServiceBase`): el constructor solo asigna `dal` (+ `loadDal` en update). Todo lo demás son overrides de hooks:
```typescript
protected override saveSuccessMessage() { return 'Producto creado correctamente'; }
protected override saveErrorFallback()  { return 'Error al crear el producto'; }
protected override navigateAfterSave()  { navigateAppRoute(this.router, this.globalInfo, 'products'); }
```

**Ver = Editar**: `products-update` hace `this.form.disable({ emitEvent: false })` en `ngOnInit` **antes** de `super.ngOnInit()`. El template alterna cabecera con `@if (form.disabled)` y muestra `form-button-principal` "Modificar" que llama a `form.enable()`.

**Datos auxiliares** (selector de IVA) se cargan aparte, en un signal:
```typescript
readonly ivaRateOptions = signal<SelectorResponse[]>([]);
private loadTaxesSelector(): void {
  this.taxesGetSelectorDal.run(new TaxesGetSelectorDto({})).pipe(toArray())
    .subscribe({ next: (taxes) => this.ivaRateOptions.set(taxes) });
}
```

**Imports Material como directivas individuales**, no módulos completos: `MatCard, MatCardHeader, MatCardContent` (no `MatCardModule`).

**Pipes con `.selector()`** requieren declararse en `providers:` e inyectarse:
```typescript
providers: [ProductPriceBaseTypeLabelPipe],
readonly productPriceBaseTypeLabel = inject(ProductPriceBaseTypeLabelPipe);
readonly priceBaseOptions = this.productPriceBaseTypeLabel.selector();
```
Para usarlo dentro del template como objeto (no como pipe), se instancia a mano:
`protected productStatusLabelPipe = new ProductStatusLabelPipe();`

**Rutas** (`app.routes.ts`): guard en el padre + guard más específico en cada hijo; `create` antes de `:id`; `loadComponent` lazy y `title` siempre.

---

## 6. Diseño — anatomía visual

**Formulario** (create/update): pila de `<mat-card>`, uno por sección, dentro de `flex flex-col gap-4`. Secciones de products: Información básica (`info`) → Ventas (`shopping-cart`) + Compras (`store`) en fila → Características físicas (`ruler-dimension-line`) → Notas (`notebook-pen`) → Error → Acciones.

- Secciones lado a lado: `<div class="flex w-full gap-4">` con dos `<mat-card class="w-full">`.
- Dentro de una tarjeta, dos columnas: `flex flex-col md:flex-row` + `w-full md:w-1/2`.
- Bloque de error: `@if (messageError(); as message)` renderiza otro `mat-card`.
- Acciones: `<div class="flex w-full gap-4 justify-end items-center">` con `form-button` (Cancelar) + `form-submit [disabled]="form.disabled || form.invalid"`.
- **Cero CSS propio**: solo Tailwind + componentes compartidos.

**Listado**: `page-container` → `section > form[formGroup]` → cabecera (`card-header` + botón Crear) → filtros dentro de `mat-card-header` → `@if (isMobile())` cards expandibles `@else` `mat-table` → `grid-paginator`.

- Primera columna `status`: sin cabecera, `class="col-icon1"`, `<col-icon [icon] [color] [tooltip]>` alimentado por los 3 pipes.
- Columnas numéricas: `class="col-number"`, con `@if` que decide `<col-empty />` vs `<col-currency [value]>`.
- Última columna `actions`: `class="col-icon3"`, `col-button` con `(click)="fn(item, $event)"` y `event?.stopPropagation()` en el handler.
- Fila completa clicable: `class="cursor-pointer" (click)="viewProduct(product)"`.
- Estado vacío: `<card-empty>` dentro de `mat-card-content`.

**Colores de estado**: `#3b82f6` azul (venta/compra), `#10b981` verde (ambos), `#ef4444` rojo (inactivo), `#94a3b8` gris (total/undefined).

---

## 7. Testing

**Backend** (`backend/tests/products/`):
- `productsDal.test.ts` — `vi.mock` del módulo `dolibarrClient`, luego se accede al cliente mockeado a través del propio DAL:
  ```typescript
  dal = new ProductsGetAllDal("test-key", 1);
  mockDolibarrClient = (dal as unknown as { dolibarr: Mocked<DolibarrClient> }).dolibarr;
  ```
  Se asertan los `sqlfilters` generados **literalmente** y el mapeo a dominio.
- `productsRouter.test.ts` — Supertest + `vi.mock` de `../../src/container` y del middleware de permisos; se stubea `createRequestScope` para devolver `{ resolve: () => ({ run: runMock }) }`.

**Frontend**: `products-retrieve.dal.spec.ts` — `TestBed` con `HttpClient` mockeado, se comprueba la URL llamada. Es el único test de products en el frontend.

---

## 8. Defectos del módulo — NO los copies

| # | Defecto | Evidencia | Impacto |
|---|---------|-----------|---------|
| **1** | **`ProductStatusMapper.toDomain` tiene los parámetros invertidos** | `productStatusMapper.ts`: `if (status) return ToBuy; if (buyStatus) return ToSell;` — pero `productMapper.ts:20` lo llama con `(tosell, tobuy)` | **Bug visible**: un producto solo de venta se muestra "En Compra" con icono de carrito. El filtro sí es correcto → filtrar "En Venta" devuelve filas etiquetadas "En Compra". **Replicado ya en `services/serviceMapper.ts:20`** |
| 2 | El test **fija el bug**: `status:"1", status_buy:"0"` → espera `ProductStatus.ToBuy` | `productsDal.test.ts` | Al corregir el mapper hay que corregir el test |
| 3 | `ProductStatusMapper.fromDomain` es una función identidad y **nunca se llama** | grep: 0 usos | Código muerto |
| 4 | `productsGetAllDal` declara `private productStatusMapper` y no lo usa | `productsGetAllDal.ts:19` | Campo muerto |
| 5 | `paramsSql.status = undefined` siempre | `productsGetAllDal.ts` | Parámetro muerto |
| 6 | `application/` con los 2 services **100% comentados**; `product-stats.ts` y `product-list-filters.ts` también | 4 ficheros | Products **no usa** capa application — no la crees "por simetría" |
| 7 | `products-update.dal.ts` (`ProductsUpdateDAL`) está **muerto** y usa `api.read()`/`api.update()` deprecated | 0 importadores activos | No lo repliques |
| 8 | El **delete** va por el DAL legacy `ProductsRetrieveDAL`, no hay `ProductsDeleteDal` en `dal/backend/` | `products-getall.ts:83` | Asimetría con el resto de operaciones |
| 9 | Fichero `productsChangePriceDal.ts` exporta la clase `ProductsUpdatePriceDal` (nombres distintos) y **no tiene consumidores** | grep: 1 sola ocurrencia | Nombre incoherente + código muerto en FE |
| 10 | **Dominio FE ≠ BE**: `Product.type?` solo existe en FE; `ProductsGetAllDto.status` tiene `defaultValue: ToSell` solo en FE; `label` tiene `defaultValue:''` solo en FE | diff FE/BE | Viola la regla de sincronía |
| 11 | `ref` es `required: true` **sin** `defaultValue: ''` (los demás strings sí lo tienen) | ambos `productsCreateDto.ts` | Incoherente con la regla de `@Field` |
| 12 | Columna `price` con condición ilógica: `@if (!product.toSell && product.price != null) { <col-empty/> }` | `products-getall.html` | Debería ser `\|\|` y `== null`, como la columna `costPrice` de al lado |
| 13 | `products-create.html` usa `<card-section>` y `products-update.html` usa `<card-header-small>` para lo mismo | ambos templates | Inconveniencia visual entre crear y editar |
| 14 | Update oculta `costPrice` (Compras solo tiene el toggle) mientras Create sí lo muestra | `products-update.html` | Asimetría funcional |
| 15 | `error: (err) => {...}` con `err` sin usar | `products-getall.ts:143` | Ruido |
| 16 | `Product.priceBaseType` con comentario "Creo que sobra pq es un valor de las ventanas no del dominio" | `product.ts` | Duda arquitectónica sin resolver, propagada al FE |

---

## 9. Checklist para replicar

**Backend**
- [ ] `domain/`: entidad + 5 DTOs + enums en `domain/enums/`
- [ ] `@Field` en **todos** los campos de DTOs de escritura y filtros
- [ ] `<entidad>DolibarrDto.ts` con el shape crudo real (mirar `backend/doc/swagger.json`)
- [ ] Mapper principal + un mapper por enum, como propiedades privadas
- [ ] 5 DALs: GetAll/Create/Update/Delete `extends DolibarrDal`; GetById instancia `DolibarrClient`
- [ ] Router: `requireHttpRight` global + Zod en escrituras + `next(error)`
- [ ] `container.ts` (SCOPED) + `server.ts`
- [ ] Tests: DAL con `vi.mock` de dolibarrClient + router con Supertest
- [ ] `npx tsc --noEmit`

**Frontend**
- [ ] `domain/` copiado **literal** del backend (comprobar con `diff`)
- [ ] DALs en `dal/backend/` con `basePath` hardcoded, **incluido el Delete**
- [ ] Listado `extends AppQueryBase`; create/update `extends AppServiceBase`
- [ ] **No** crear capa `application/` salvo spec explícita
- [ ] 3 pipes por enum visible (label con `selector()`, color, icon Lucide)
- [ ] Templates: `mat-card` por sección, cero CSS propio, `col-*` en tabla
- [ ] Rutas con guards, `create` antes de `:id`, `loadComponent` + `title`
- [ ] `ng build`
