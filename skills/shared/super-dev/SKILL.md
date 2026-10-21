---
name: super-dev
description: Contexto maestro de Doligestion — arquitectura real verificada contra el código (Angular 22 zoneless + BFF Express + Dolibarr), patrón DAL end-to-end, convenciones, contradicciones resueltas entre docs y código, y checklists de verificación. Activa este skill SIEMPRE antes de escribir o revisar cualquier línea de código del repo (frontend, backend o dominio compartido), y ante cualquier duda de patrón, naming, DAL, DTO, mapper, formulario o listado.
license: private
---

# Super-Dev — Contexto maestro de Doligestion

> **Estado**: verificado leyendo el código real el 2026-07-27 (rama `main`, commit `f42109f3e`).
> **Regla de oro de este documento**: cuando la documentación del repo y el código se contradigan, **manda el código**. La §10 lista las contradicciones concretas ya detectadas y cuál es la verdad.

---

## 0. Cómo usar este skill

1. Lee la §1 (mapa mental) y la §10 (trampas) **siempre**.
2. Salta a la sección del área que vas a tocar: §4 backend, §5 frontend, §6 dominio compartido, §7 diseño.
3. Antes de dar por terminado, ejecuta la §11 (verificación).
4. Si vas a replicar un módulo entero, sigue la §9 (receta completa) — no improvises.

> 📌 **Products/services son el módulo de referencia oficial del proyecto.**
> - Estándar de código obligatorio (id, enums, `@Field`, naming, FE≡BE, preguntar si dudas):
>   `.ai-hub/references/products-coding-standard.md` (también regla Cursor always-on).
> - Disección completa y **defectos que NO hay que copiar**: `references/products-anatomy.md` en esta carpeta.
> - Blueprint de módulo: `.ai-hub/references/products-module-blueprint.md`.

**Referencia canónica de código** (si dudas, abre estos ficheros, no otros):

| Capa | Fichero canónico |
|------|------------------|
| Listado FE | `frontend/src/app/products/infrastructure/components/products-getall/products-getall.ts` + `.html` |
| Crear FE | `frontend/src/app/products/infrastructure/components/products-create/products-create.ts` |
| Ver/Editar FE | `frontend/src/app/products/infrastructure/components/products-update/products-update.ts` |
| DAL FE | `frontend/src/app/products/infrastructure/dal/backend/productsGetAllDal.ts` |
| Base FE | `frontend/src/app/common/infrastructure/app-query-base.ts`, `app-service-base.ts`, `app-base.ts` |
| DAL BE listado | `backend/src/products/infrastructure/dal/dolibarr/productsGetAllDal.ts` |
| DAL BE item | `backend/src/products/infrastructure/dal/dolibarr/productsGetByIdDal.ts` |
| Router BE | `backend/src/products/infrastructure/router/productsRouter.ts` |
| Mapper BE | `backend/src/products/infrastructure/dal/dolibarr/mappers/productMapper.ts` |
| Cliente Dolibarr | `backend/src/common/infrastructure/dolibarr/dolibarrClient.ts` |
| DTO compartido | `frontend/src/app/products/domain/productsGetAllDto.ts` ≡ `backend/src/products/domain/productsGetAllDto.ts` |

---

## 1. Qué es Doligestion (mapa mental)

ERP web multi-tenant construido **encima de Dolibarr 21.0.4**. Tres piezas:

```
Angular 22 (zoneless, standalone, Signals, Tailwind 4, Material)
        │  HTTP + cookies httpOnly (withCredentials: true)
        ▼
BFF Node.js + Express 5  ← ÚNICO punto de salida del frontend
        │  REST + header DOLAPIKEY / DOLENTITY (axios)
        ▼
Dolibarr 21.0.4 REST API  (+ MySQL directo en casos puntuales, + Kubernetes API)
```

**Invariantes no negociables del sistema**:
- El frontend **jamás** llama a Dolibarr directamente. No conoce ni la URL ni la API key.
- El BFF inyecta `dolikey` + `entityId` (multi-tenant) en cada llamada saliente. Vienen de la cookie de sesión, resuelta por `CookiesDal`.
- Dolibarr habla PHP/snake_case con tipos sucios (números donde hay booleanos, strings donde hay enums). **El mapper es la frontera**: fuera del mapper nunca ves snake_case.

**Escala real del repo** (medida):
- Frontend: 875 `.ts`, 151 `.html`, 37 dominios, 62 `.spec.ts`
- Backend: 720 `.ts`, 28 dominios, **216 DALs**, 104 `.test.ts`
- OpenSpec: 180 capabilities en `openspec/specs/`, 54 changes registrados

### Dominios existentes

**Frontend** (`frontend/src/app/`): banks, boms, clients, common, contracts, core, documentation, documents, entities, hacienda, invoices, layouts, orders, products, projects, proposals, punches, purchase-invoices, purchase-prices-products, purchase-prices-services, services, setup, setup-company, suppliers, tasks, taxes, thirdparties, users, warehouses, workdays.

**Backend** (`backend/src/`): banks, boms, branding, catalogs, common, company, contracts, dictionaries, documentation, entities, errors, hacienda, invoices, manufacturing, orders, products, projects, proposals, punches, purchase-invoices, purchase-prices, services, tasks, thirdparties, users, warehouses, workdays.

> Nota: `manufacturing` está completo en backend y **sin frontend**. `branding`/`dictionaries` son backend-only por diseño.

---

## 2. Prohibiciones absolutas (rompes una = el código se rechaza)

Las 5 primeras están **automatizadas** en `.ai-hub/harness/rules/` y hacen fallar el harness:

| # | Regla | Comprobación | Severidad real |
|---|-------|--------------|----------------|
| 1 | Sin `: any` | `01-zero-any.sh` | **WARN** (exit 0) — hay 24 ocurrencias legacy toleradas; no añadas ninguna nueva |
| 2 | Sin `@NgModule` | `02-no-ng-module.sh` | **FAIL** |
| 3 | Sin inyección por constructor (solo `inject()`) | `03-no-constructor-injection.sh` | **FAIL** |
| 4 | Sin `*ngIf` / `*ngFor` / `*ngSwitch` (solo `@if`/`@for`/`@switch`) | `04-no-legacy-directives.sh` | **FAIL** — hoy hay 0 violaciones, mantenlo así |
| 5 | `extends DolibarrDal` **solo** dentro de `infrastructure/dal/dolibarr/` | `05-no-dolibarrdal-inheritance.sh` | **FAIL** |
| 6 | Sin `TODO` en producción (salvo `TODO(test)`) | `06-no-todos.sh` | **FAIL** |

Ejecutar todo: `bash .ai-hub/harness/run-all.sh`

Además, no automatizadas pero igual de firmes:

7. **Aislamiento de tipos**: interfaces/tipos/DTOs viven **exclusivamente** en `domain/`. Un router, un componente o un service **importa**, nunca declara.
8. **Sin emojis en código** (ni logs de backend ni UI). Excepción: `server.ts` legacy los tiene; no propagues el patrón.
9. **Sin JSDoc redundante**. Comenta el *porqué* no obvio, nunca el nombre de la propiedad.
10. **Sin `.then()/.catch()` encadenados** en backend: `async/await` exclusivo.
11. **Nada de español en identificadores**. Español solo en: `@Field({ label: '...' })` y texto visible en HTML.
12. **Sin implementar sin spec**: `/opsx:propose` → aprobación humana → `/opsx:apply` → `/opsx:archive`.

---

## 3. Convenciones de nombres (memorízalas)

| Artefacto | Idioma | Forma | Ejemplo |
|-----------|--------|-------|---------|
| Carpeta de dominio | Inglés | plural | `products/`, `purchase-invoices/` |
| Ruta URL | Inglés | plural | `/products`, `/products/create`, `/products/:id` |
| Fichero `.ts` | Inglés | **camelCase** | `productsGetAllDto.ts`, `productMapper.ts` |
| Interfaz / clase de dominio | Inglés | PascalCase **singular** | `Product`, `BomLine` |
| Enum | Inglés | PascalCase singular | `ProductStatus`, `SortOrder` |
| Valor de enum | Inglés | PascalCase | `ProductStatus.ToSell` |
| DTO | Inglés | `{Entity}s{Operation}Dto` | `ProductsGetAllDto`, `ProductsCreateDto` |
| DAL | Inglés | `{Entity}s{Operation}Dal` | `ProductsGetAllDal`, `ProductsUpdateDal` |
| Componente (carpeta+selector) | Inglés | `{entity}s-{operation}` | `products-getall`, `products-create`, `products-update` |
| Pipe | Inglés | camelCase | `productStatusLabel`, `productStatusColor`, `productStatusIcon` |
| Texto de UI | **Español** | — | `Crear`, `Guardar`, `Cancelar`, `Modificar` |

**Siglas como palabras**: `Dto` no `DTO`, `Dal` no `DAL`, `Bff` no `BFF`, `Asc` no `ASC`.

**Operaciones canónicas** (usa exactamente estos verbos): `GetAll`, `GetById`, `Create`, `Update`, `Delete`. Extras específicos van con nombre propio (`ChangePrice`, `Validate`, `AddLine`).

> ⚠️ **Deriva conocida**: parte de la documentación y de la memoria del agente `architect` habla de `products-list`. El componente real es **`products-getall`**. Hay ficheros legacy con guiones (`products-retrieve.dal.ts`, `products-update.service.ts`) conviviendo con los nuevos camelCase — el patrón nuevo es camelCase en `dal/backend/`.

---

## 4. Backend (BFF) — maestría

### 4.1 Estructura obligatoria por dominio

```
backend/src/<dominio>/
  domain/
    <entidad>.ts                    → interface de dominio (id obligatorio, resto opcional)
    <entidad>sGetAllDto.ts          → extends QueryListDto
    <entidad>sGetByIdDto.ts         → extends QueryItemDto
    <entidad>sCreateDto.ts
    <entidad>sUpdateDto.ts
    <entidad>sDeleteDto.ts
    enums/<entidad>Status.ts
  infrastructure/
    dal/dolibarr/
      <entidad>DolibarrDto.ts       → shape CRUDO de Dolibarr (snake_case, tipos PHP)
      <entidad>sGetAllDal.ts        → extends DolibarrDal, implements IQueryGetListDal
      <entidad>sGetByIdDal.ts       → instancia DolibarrClient, implements IQueryGetItemDal
      <entidad>sCreateDal.ts        → extends DolibarrDal, implements IServiceDal
      <entidad>sUpdateDal.ts        → extends DolibarrDal, implements IServiceDal
      <entidad>sDeleteDal.ts        → extends DolibarrDal, implements IServiceDal
      enums/                        → enums SOLO de la capa DAL (ej. ProductMode)
      mappers/
        <entidad>Mapper.ts          → toDomain() + fromDomain()
        <entidad>StatusMapper.ts    → un mapper por enum
    router/<entidad>sRouter.ts      → todos los endpoints del dominio
```

### 4.2 La regla de herencia de `DolibarrDal` (la más malentendida)

`backend/src/common/infrastructure/dolibarr/dolibarrDal.ts` es una **clase abstracta** que aporta:
- `protected dolibarr: DolibarrClient` (composición interna del cliente HTTP)
- `mapFiltersFromDomain(value, columns)` → string → `LIKE '%v%'`, número → `:=:v`, con escape de comillas
- `mapStatusFilterFrom(status, column)`
- `combineSqlFilters(...filters)` → une con ` and `, ignorando vacíos

**La verdad operativa** (harness rule 05 + AGENTS.md regla 4):
- ✅ Los DALs segregados dentro de `infrastructure/dal/dolibarr/` **DEBEN** hacer `extends DolibarrDal` para acceder a esos helpers protegidos.
- ❌ Heredar de `DolibarrDal` fuera de esa carpeta (services, routers, use cases) está **prohibido**.
- ❌ **DAL que hereda de otro DAL** está prohibido siempre. Si un DAL necesita otro, lo **compone**: guarda `dolikey`/`entityId` como propiedades y construye el colaborador en el constructor (patrón real en `purchaseInvoicesValidateDal.ts`).

`GetById` es la excepción: **no** extiende `DolibarrDal` porque no necesita filtros SQL — instancia `DolibarrClient` directamente.

### 4.3 Patrón GetAll (el más complejo)

```typescript
export class ProductsGetAllDal extends DolibarrDal implements IQueryGetListDal<ProductsGetAllDto, Product> {
  private endpoint = "products";
  private productMapper = new ProductMapper();          // mappers = propiedades privadas, NO inyectados
  private productModeMapper = new ProductModeMapper();

  constructor(dolikey: string, entityId: number = 1) { super(dolikey, entityId); }

  async run(request: ProductsGetAllDto): Promise<QueryListResult<Product>> {
    request.sortfield = `t.${request.sortfield || "rowid"}`;   // prefijo de tabla obligatorio

    const paramsSql = {
      sqlfilters: this.combineSqlFilters(
        this.mapFiltersFromDomain(request.filterBy.trim(), ["t.label", "t.ref"]),
        this.mapFiltersFromDomain(request.status, ["t.tosell"]),
      ),
      mode: this.productModeMapper.fromDomain(ProductMode.Products),
    };

    const responseRaw = await this.dolibarr.query2<ProductDolibarrDto>(this.endpoint, paramsSql, request);

    const response = await lastValueFrom(
      from(responseRaw.data).pipe(
        map(item => this.productMapper.toDomain(item)),
        pick(request.fields?.split(",") ?? []),   // proyección en memoria
        toArray(),
      ),
    );

    return { data: response, pagination: responseRaw.pagination };
  }
}
```

Claves:
- `query2()` es el método vigente (`query()` está DEPRECATED).
- `pick()` (`backend/src/common/utils/rxjs-utils.ts`) hace la proyección de `fields` **en memoria**, no en SQL.
- `filterBy` siempre se mapea contra **todas** las columnas string relevantes con prefijo `t.`.
- El pipeline RxJS con `from/map/pick/toArray/lastValueFrom` es el idioma del proyecto — respétalo.

### 4.4 Patrón Create / Update / Delete

Los tres reciben el DTO de dominio, lo pasan por `fromDomain`, llaman al cliente y **devuelven el request original** (la respuesta de Dolibarr no aporta nada nuevo). `Delete` no necesita mapper.

```typescript
async run(request: ProductsUpdateDto): Promise<Product> {
  const dto = this.productMapper.fromDomain(request);
  await this.dolibarr.update<ProductDolibarrDto>(this.endpoint, request.id, dto);
  return request;
}
```

### 4.5 Mapper — la frontera

```typescript
export class ProductMapper extends DolibarrMapper {
  private productStatusMapper = new ProductStatusMapper();

  toDomain(item: ProductDolibarrDto): Product {
    return {
      id: Number(item.id),
      ref: item.ref ?? '',                                                   // string → SIEMPRE ''
      status: this.productStatusMapper.toDomain(item.status),
      toSell: item.status !== undefined ? Boolean(item.status) : undefined,  // NUNCA if (valor)
      price: item.price !== undefined ? Number(item.price) : undefined,
    };
  }

  fromDomain(item: Partial<Product>): ProductDolibarrDto { /* inverso */ }
}
```

**Reglas del mapper, sin excepción**:
- `toDomain`: strings siempre `?? ''`. Nunca `undefined` en un string de dominio.
- `toDomain`: números y booleanos con `x !== undefined ? Number(x) : undefined`. **Nunca `if (x)`** — colapsaría `0` y `false`.
- `fromDomain` recibe `Partial<Entity>` para servir a Create y Update con un solo mapper.
- Cada enum tiene su **clase mapper independiente**, instanciada como propiedad privada del mapper principal.

### 4.6 Router Express

Un fichero por dominio, montado en `backend/server.ts` bajo `/api/<recurso>`.

```typescript
const router = Router();
router.use(requireHttpRight(productHttpRightPolicy, "No tienes permiso para gestionar productos"));

router.get("/", async (req, res, next) => {
  try {
    const { session, query } = req as AuthenticatedRequest;
    const queryRequest = new ProductsGetAllDto(query);              // sin Zod: query params opcionales
    const scope = createRequestScope(session.dolikey, session.entity);
    const dal = scope.resolve(InjectionTokens.productsGetAllDal);
    res.json(await dal.run(queryRequest));
  } catch (error) { next(error); }                                  // SIEMPRE next(error)
});

router.put("/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const parsed = buildZodSchema(ProductsUpdateDto).safeParse({ ...req.body, id });
    if (!parsed.success) {
      return res.status(400).json({ error: "Payload invalido", statusCode: 400, details: z.flattenError(parsed.error) });
    }
    /* ... resolve + run ... */
  } catch (error) { next(error); }
});
```

Reglas:
- `GET /` y `GET /:id`: construir DTO directamente, **sin Zod**.
- `POST` y `PUT`/`PATCH`: **siempre** `buildZodSchema(Dto).safeParse(...)`. El `id` en PUT se inyecta desde `req.params`.
- `DELETE /:id`: en products sí usa Zod (con `id` inyectado); es aceptable en ambos sentidos, sigue el módulo vecino.
- **Nunca** escribas un esquema Zod a mano: `buildZodSchema` lo deriva de los `@Field` del DTO.
- El catch siempre `next(error)`; el middleware global de `server.ts` formatea `BaseError` → `{ error, statusCode }`.

### 4.7 IoC — Awilix

`backend/src/container.ts` (~210 registros `asClass`). Al añadir un DAL:
1. Impórtalo en `container.ts` (bajo el bloque `// ==== <DOMINIO> ====`).
2. Añádelo a `registrations` con `{ lifetime: Lifetime.SCOPED }`.
3. `InjectionTokens` se genera solo (`Object.fromEntries(Object.keys(registrations)...)`).

El modo es `InjectionMode.CLASSIC`: los DALs reciben `(dolikey, entityId)` **por nombre de parámetro**. No renombres esos parámetros.

### 4.8 Errores

`backend/src/errors/domain/` + `BaseError` (abstracta, `statusCode` + `message`):

| Clase | statusCode | Uso |
|-------|------------|-----|
| `ArgumentError` | 400 | Parámetro/payload inválido |
| `NotAuthenticatedError` | 401 | Sin sesión / expirada |
| `ForbiddenError` | 403 | Sin permisos |
| `NotFoundError` | 404 | No encontrado |
| `IllegalOperationError` | 422 | Operación no permitida (y 409/304 de Dolibarr) |
| `InternalError` | 500 | No controlado |

`DolibarrClient.checkError()` ya traduce los status de Dolibarr a estas clases. No dupliques esa traducción en tus DALs.

### 4.9 `DolibarrClient` — detalles que muerden

- Responde con `responseType: 'arraybuffer'` + `decompress: false` porque **Dolibarr manda `Content-Encoding: gzip` con cuerpo sin comprimir**. `parseDolibarrResponse()` detecta los magic bytes y descomprime si toca.
- `Connection: close` forzado: Dolibarr/Apache cierra sockets keep-alive bajo concurrencia (ECONNRESET).
- `timeout: 10000` — sin él, un módulo desactivado en Dolibarr cuelga la petición para siempre.
- `_t: Date.now()` en cada query: cache-busting obligatorio.
- `sortorder` llega como string por HTTP; `resolveSortOrder()` normaliza. No compares `=== SortOrder.DESC` a pelo.

---

## 5. Frontend (Angular 22) — maestría

### 5.1 Configuración que condiciona todo lo que escribas

`frontend/src/app/app.config.ts`:
- **`provideZonelessChangeDetection()`** → **NO hay zone.js**. Todo estado que la UI deba reflejar tiene que ser un `signal`/`computed` o pasar por el ciclo de formularios/router. Mutar una propiedad plana **no repinta**.
- `withComponentInputBinding()` → params de ruta y `data` se enlazan a inputs.
- `provideHttpClient(withFetch(), withInterceptors([authInterceptor, loadingInterceptor]))`.
- `LOCALE_ID: 'es'`, `MAT_DATE_LOCALE: 'es-ES'`.
- Paginador global: `pageSize: 50`, `pageSizeOptions: [10, 25, 50, 100, 250, 500, 1000]`.
- Form fields Material: `appearance: 'outline'`, `floatLabel: 'always'`.
- Iconos: **Lucide** (`@lucide/angular`, `strokeWidth: 1.5`). Material Icons solo en restos legacy.

`tsconfig.json`: `strict`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `strictTemplates`, `experimentalDecorators` (necesario para `@Field`). Alias: `@app/*` → `./src/app/*`.

### 5.2 Estructura por dominio

```
frontend/src/app/<dominio>/
  domain/                          → ESPEJO EXACTO del backend + tipos auxiliares de UI
    enums/
  application/                     → services delgados (solo orquestación DAL + feedback)
                                     lógica pura en *.mapper.ts / *.validator.ts / *.formatter.ts
  infrastructure/
    dal/backend/<entidad>sGetAllDal.ts   → única capa que habla con el BFF
    components/<entidad>s-getall/        → un componente por carpeta, nunca en la raíz
    pipes/<entidad>-status-label.pipe.ts
```

Separación estricta: en `dal/` cero UI; en `components/` cero llamadas HTTP.

### 5.3 Las tres clases base (`common/infrastructure/`)

**`AppBase`** — `router`, `navigate()`, `navigateBack()`, `messageError` (signal), `showSnackBar()`, `reportSaveError()`, `reportLoadError()`, `isMobile()` (via `BreakpointObserver` + `toSignal`).

**`AppQueryBase<DTO, T>`** (listados) — extiende `AppBase`, añade:
- `form: FormGroup` construido automáticamente con `formGroupFromDto(dtoClass)`
- `controls` tipado: `Record<keyof DTO, FormControl>`
- `dal: QueryBackendDal<DTO, T>` (se asigna en el constructor)
- `onSave()` genérico, `getId()`

**`AppServiceBase<DTO, T>`** (create/update) — extiende `AppBase`, añade:
- `form` + `controls` igual
- `dal: ServiceBackendDal` (mutación) y `loadDal: QueryBackendDal` (carga en update)
- `isContentReady` signal
- `load()` en `ngOnInit`: resuelve `id` subiendo por `route.snapshot.parent`, llama `loadDal`, extrae el item con `extractLoadedItem()` (acepta `{item}` **o** `{data:[...]}`), `patchValue`, hook `afterLoad()`
- `onSave()`: valida, `buildSavePayload()` (mete `id` del route), `dal.run(...)`, snackbar + `navigateAfterSave()`
- Hooks a sobreescribir: `saveSuccessMessage()`, `saveErrorFallback()`, `navigateAfterSave()`, `mapLoadedItem()`, `configureFormControls()`, `afterLoad()`

### 5.4 Componente de listado — esqueleto real

```typescript
@Component({
  selector: 'products-getall',
  standalone: true,
  imports: [ /* ...directivas Material individuales, col-*, form-field-*, pipes... */ ],
  templateUrl: './products-getall.html',
})
export class ProductsGetAllComponent extends AppQueryBase<ProductsGetAllDto, QueryResult<Product>> {
  // Services
  protected readonly globalInfo = inject(GlobalInfoService);
  // Enums (para el template)
  protected readonly productStatus = ProductStatus;
  // DALs
  private productsGetAllDal = inject(ProductsGetAllDal);
  // Security
  protected readonly canCreate = computed(() => !!this.globalInfo.right().products?.canCreateProducts);
  protected readonly canEdit   = computed(() => !!this.globalInfo.right().products?.canUpdateProducts);
  protected readonly canDelete = computed(() => !!this.globalInfo.right().products?.canDeleteProducts);
  // Domain
  protected items = signal<Product[]>([]);
  protected readonly total = signal<number | undefined>(undefined);
  // Table
  protected readonly displayedColumns: string[] = ['status','ref','label','costPrice','price','actions'];
  protected readonly selectedId = signal<number | null>(null);

  constructor() {
    super(ProductsGetAllDto);
    this.dal = this.productsGetAllDal;
  }

  override ngOnInit(): void { super.ngOnInit(); this.load(); }

  protected load(): void {
    this.clearMessageError();
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }

    const dto = {
      ...this.form.getRawValue(),
      fields: 'id,status,ref,label,toSell,price,toBuy,costPrice',   // proyección mínima SIEMPRE
    } as ProductsGetAllDto;

    this.productsGetAllDal.run(dto).subscribe({
      next: (response) => { this.items.set(response.data); this.total.set(response.pagination.total); },
      error: () => this.showSnackBar('Error al cargar productos', 'Cerrar'),
    });
  }

  protected onPageChange(event: PageEvent): void {
    this.form.patchValue({ page: event.pageIndex, limit: event.pageSize });
    this.load();
  }
}
```

Orden de bloques dentro de la clase (respétalo, es la convención visual del repo): `// Services` → `// Enums` → `// DALs` → `// Security` → `// Domain` → `// Table` → `// Auxiliars` → `// Results`.

### 5.5 Componentes create / update

```typescript
// CREATE — sin loadDal
export class ProductsCreateComponent extends AppServiceBase<ProductsCreateDto, Product> {
  private productsCreateDal = inject(ProductsCreateDal);
  constructor() { super(ProductsCreateDto); this.dal = this.productsCreateDal; }

  protected override saveSuccessMessage() { return 'Producto creado correctamente'; }
  protected override saveErrorFallback()  { return 'Error al crear el producto'; }
  protected override navigateAfterSave()  { navigateAppRoute(this.router, this.globalInfo, 'products'); }
}

// UPDATE — con loadDal, entra en modo solo lectura
export class ProductsUpdateComponent extends AppServiceBase<ProductsUpdateDto, Product> {
  private readonly productsUpdateDal  = inject(ProductsUpdateDal);
  private readonly productsGetByIdDal = inject(ProductsGetByIdDal);
  protected readonly canEdit = computed(() => !!this.globalInfo.right()?.products?.canCreateProducts);

  constructor() {
    super(ProductsUpdateDto);
    this.dal     = this.productsUpdateDal;
    this.loadDal = this.productsGetByIdDal;
  }

  override ngOnInit(): void {
    this.form.disable({ emitEvent: false });   // ver y editar son la MISMA ventana
    super.ngOnInit();
  }
}
```

**"Ver" y "Editar" no son dos pantallas**: se entra con `form.disable()`; un botón "Modificar" (`form-button-principal`) llama a `form.enable()`.

### 5.6 DAL de frontend

Dos bases abstractas triviales en `common/infrastructure/dal/backend/`: `QueryBackendDal<DTO,R>` (lecturas) y `ServiceBackendDal<DTO,R>` (mutaciones). Ambas declaran un único `abstract run(request): Observable<R>`.

```typescript
@Injectable({ providedIn: 'root' })
export class ProductsGetAllDal extends QueryBackendDal<ProductsGetAllDto, QueryResult<Product>> {
  private api = inject(ApiDalService);
  private basePath = 'products';                         // hardcoded SIEMPRE, nunca parametrizado

  run(request: ProductsGetAllDto): Observable<QueryResult<Product>> {
    return this.api.queryList<QueryResult<Product>>(this.basePath, request);
  }
}
```

`ApiDalService` (`common/infrastructure/api.dal.service.ts`) — usa solo estos:
`queryList`, `queryItem`, `post`, `put`, `putPath`, `patch`, `get`, `delete`.
**DEPRECATED, no usar**: `create()`, `read()`, `readAll()`.

Todas las llamadas van con `withCredentials: true` y traducen el error del BFF a un `Error` con mensaje en español (`handleError`). `queryList` filtra automáticamente los params `null`/`undefined`/`''`.

### 5.7 Signals — reglas prácticas en zoneless

- Estado de vista: `signal<T>(...)` con tipo explícito. Derivados: `computed()`.
- Permisos: siempre `computed(() => !!this.globalInfo.right().<modulo>?.<flag>)`.
- Actualiza con `.set()` / `.update()`. **Nunca** mutes el array/objeto interno.
- `toSignal()` para puentear Observables (patrón `isMobile` en `AppBase`).
- Los `subscribe()` de DAL escriben en signals; no devuelvas Observables a la vista sin `async` pipe o signal.

### 5.8 Navegación multi-tenant

**No uses `router.navigate([...])` a pelo** en rutas de la app. Usa:

```typescript
navigateAppRoute(this.router, this.globalInfo, ['products', product.id]);
```

`navigateAppRoute` (`common/infrastructure/navigate-app-route.ts`) delega en `globalInfo.routeLink(...)`, que antepone el slug de empresa cuando el despliegue es multi-tenant. En templates, `[routerLink]="['/products','create']"` sigue siendo válido dentro del shell ya tenantizado.

---

## 6. Dominio compartido — el contrato

### 6.1 Sincronía FE ↔ BE

`frontend/src/app/<dom>/domain/` y `backend/src/<dom>/domain/` deben ser **idénticos** para: interfaces de entidad, enums, DTOs, `ErrorResult`. Tocas uno → tocas el otro en el mismo cambio.

Excepción permitida solo en frontend: tipos auxiliares de UI sin equivalente backend (`*Stats`, `*ListFilters`, payloads de diálogo).

### 6.2 Interfaz de entidad

```typescript
export interface Product {
  id: number;           // ÚNICO campo obligatorio
  ref?: string;
  label?: string;
  status?: ProductStatus;
  price?: number;
  // ...
}
```

- Solo `id` obligatorio; todo lo demás `?`.
- **Prohibidas las uniones** en campos (`string | number`, `number | null`).
- **Prohibidos los `fk_*: number`**: las referencias a otras entidades van como **objeto tipado** (`thirdparty?: Thirdparty`). Decisión arquitectónica 2026-05-12 (Rich Domain Models + `EntityResolver` con caché por request para evitar N+1).
- Un fichero por artefacto. Nunca dos tipos en el mismo `.ts`.

### 6.3 `@Field` — la pieza más potente del proyecto

Un solo decorador (`common/domain/field-meta.ts`, idéntico en FE y BE) alimenta **tres** consumidores:

| Consumidor | Dónde | Qué hace |
|------------|-------|----------|
| `buildZodSchema(Dto)` | backend `common/infrastructure/zodSchemas.ts` | genera el esquema Zod de validación |
| `formGroupFromDto(Dto)` | frontend `common/infrastructure/formField.ts` | genera el `FormGroup` con validadores, label y `required` |
| componentes `form-field-*` | frontend | leen `label`/`required` del propio control, no del template |

```typescript
export class ProductsCreateDto {
  @Field({ label: 'Referencia', genere: FieldGenere.female, type: FieldType.String,
           required: true, defaultValue: '', max: 128 })
  ref?: string;

  @Field({ label: 'Precio de venta', genere: FieldGenere.male, type: FieldType.Number,
           subType: FieldSubType.Price, min: 0 })
  price?: number;

  @Field({ label: 'Disponible para venta', genere: FieldGenere.male, type: FieldType.Boolean,
           required: true, defaultValue: true })
  toSell?: boolean;

  @Field({ label: 'Tipo de precio base', genere: FieldGenere.male, type: FieldType.Enum,
           enumType: ProductPriceBaseType, defaultValue: ProductPriceBaseType.ConIVA })
  priceBaseType?: ProductPriceBaseType;
}
```

**Reglas de `@Field`, sin excepción**:
- **Todos** los campos llevan `@Field`, incluidos los filtros de listado.
- `String` → **siempre** `defaultValue: ''`. Nunca `undefined`/`null`; `''` es "sin valor".
- `Number`/`Boolean`/`Enum` **opcionales** → sin `defaultValue` (`undefined` = sin valor).
- `Boolean`/`Enum` con `required: true` → **sí** llevan `defaultValue` (el formulario necesita estado inicial).
- Filtros de enum opcionales (`status?`) → sin `required` ni `defaultValue` = "sin filtro, devuelve todos".
- `genere` (male/female) existe para la concordancia de género en los mensajes de error en español.
- `fields` **nunca** se inicializa en el DTO — se asigna en el componente con la proyección mínima.
- Si el DTO extiende otro: `super(init)` primero, luego asignar los campos propios.

`getFieldMeta()` recorre la cadena de prototipos, así que **la herencia de DTOs funciona** (`ProductsUpdateDto extends ProductsCreateDto` hereda todos los `@Field`).

### 6.4 DTOs base

```typescript
// QueryListDto (común FE/BE)
export enum SortOrder { ASC = 1, DESC = 2 }   // backend
export enum SortOrder { Asc = 1, Desc = 2 }   // frontend (misma semántica, casing distinto)

export class QueryListDto extends QueryDto {
  page: number = 0;
  limit: number = 100;      // ojo: el default de UI es 50 (MAT_PAGINATOR_DEFAULT_OPTIONS)
  page_count?: number;
  total?: number;
  sortfield: string = "";
  sortorder: SortOrder = SortOrder.ASC;
  fields?: string;          // proyección CSV
}
```

Todo `GetAllDto` de entidad añade obligatoriamente `filterBy: string` (búsqueda libre) + un campo por dimensión de filtro.

### 6.5 Resultados

- Backend listado: `QueryListResult<T>` = `{ data: T[]; pagination: QueryResultPagination }`
- Backend item: `QueryItemResult<T>` — **en el código real `ProductsGetByIdDal` devuelve `{ data: [item] }`**, no `{ item }`. `AppServiceBase.extractLoadedItem()` acepta ambas formas. Al crear un módulo nuevo, sigue la forma del módulo vecino y confía en `extractLoadedItem`.
- Error del BFF: `{ error: string; statusCode: number; details?: unknown }`

---

## 7. Diseño y UI

### 7.1 Sistema de estilos

`frontend/src/styles.css` importa, en orden: Tailwind 4 → `variables.css` → `tables.css` → `panels.css` → `snackbar.css` → `components.css` → `design-system.css` → `forms.css` → `form-window.css`.

**Branding dinámico**: las variables `--branding-*` se cargan en runtime desde `GET /api/public/branding` (Dolibarr) y sobrescriben el tema. Nunca hardcodees colores de marca; usa `var(--branding-...)` o las clases existentes.

**Sin CSS propio para grids**: usa Tailwind (`flex flex-col gap-4`, `w-full`, `justify-between`) y los componentes compartidos.

### 7.2 Dos sistemas de formulario conviven (conócelos)

1. **`mat-card` apilado** — módulos "Simples" con `AppServiceBase`. Products es la referencia canónica. Cada sección es un `<mat-card>` independiente con elevación nativa.
2. **`form-window`** (`assets/styles/form-window.css`, ~940 líneas) — módulos "Complejos": Orders, Invoices, Purchase-invoices, Proposals. Una `.premium-card` exterior con `.form-section-card` internas.

Hay un cambio OpenSpec en curso (`forms-migrate-to-mat-card` / `remaining-views-missing-mat-card`) para unificar visualmente hacia (1) **sin tocar la arquitectura** de los complejos (siguen con `FormBuilder`/`form()` manual, **no** migran a `AppServiceBase`).

⚠️ **Nunca borres bloques de `form-window.css` sin un grep exhaustivo previo.** Hay ~130 líneas ya confirmadas como muertas y otras que sí se usan.

### 7.3 Catálogo de componentes compartidos (`common/infrastructure/components/`)

**Campos de formulario** (todos leen `label`/`required` del control; **no repitas el label en el template**):
`form-field-text`, `form-field-area`, `form-field-number`, `form-field-euro`, `form-field-boolean`, `form-field-enum` (+`[options]`), `form-field-date`, `form-field-time`, `form-field-password`, `time-hm-input`

**Botones**: `form-button` (secundario), `form-button-principal` (acción principal), `form-submit`

**Cabeceras y tarjetas**: `card-header`, `card-header-small`, `card-section`, `card-empty`, `kpi-card`

**Columnas de tabla**: `col-icon`, `col-text`, `col-currency`, `col-empty`, `col-button`
Anchos: `col-icon1` (primera columna de estado), `col-icon3` (última columna, 3 acciones)

**Otros**: `grid-paginator`, `confirm-dialog`, `warning-dialog`, `input-dialog`, `dashboard`, `punch-card`

### 7.4 Anatomía de un listado

```
page-container
 └ section > form[formGroup] (submit → load())
    ├ cabecera: card-header (icono+título+subtítulo) + form-button "Crear" (si canCreate())
    ├ filtros: form-field-enum (estado) + form-field-text (filterBy) + form-submit "Buscar"
    ├ @if (items().length === 0) → mat-card > card-empty
    ├ @if (isMobile())  → @for → mat-card expandible (click → selectedId) + mat-card-actions
    │  @else            → mat-card > table[mat-table]
    └ grid-paginator [length]=total() [pageIndex]/[pageSize] desde controls (page)="onPageChange($event)"
```

**Mobile first**: móvil = cards individuales; escritorio = `mat-table`. Se alterna con `@if (isMobile())` en el **mismo** componente.

**Primera columna** = estado/tipo, **sin cabecera**, con `col-icon` alimentado por tres pipes:
```html
<col-icon [icon]="item.status | productStatusIcon"
          [color]="item.status | productStatusColor"
          [tooltip]="item.status | productStatusLabel" />
```

**Última columna** = acciones, solo iconos ghost con `matTooltip`, envueltas en `@if (canX())`.

**Iconos Lucide estándar**: `eye` (ver), `pencil` (editar), `plus` (crear), `trash-2` (eliminar, `color="#ef4444"` / `class="text-red-500!"`), `search` (buscar), `euro` (precio).

### 7.5 Pipes de enum — patrón obligatorio

Un pipe por transformación visual, todos `standalone: true`:

```typescript
@Pipe({ name: 'productStatusLabel', standalone: true })
export class ProductStatusLabelPipe implements PipeTransform {
  transform(status?: ProductStatus): string {
    if (status === ProductStatus.ToSell) return 'Para venta';
    // ...
    return 'Total';                         // undefined → "todos"
  }
  selector(): { value: ProductStatus; label: string }[] { /* opciones para form-field-enum */ }
}
```

- `...LabelPipe` → texto (con `.selector()` si alimenta un `form-field-enum`)
- `...ColorPipe` → hex (`#10b981` ok, `#ef4444` error, `#94a3b8` neutro)
- `...IconPipe` → `LucideCircleCheck.icon.name`

Para usar `.selector()` hay que declarar el pipe en `providers:` del componente e `inject()`-arlo.

### 7.6 Diálogos

```typescript
this.dialog.open(ConfirmDialogComponent, {
  width: '450px',
  data: { title: 'Eliminar Producto', message: `¿Eliminar ${nombre}? Esta acción no se puede deshacer.` },
}).afterClosed().subscribe((confirmed: boolean) => {
  if (!confirmed) return;
  /* ejecutar DAL de borrado + this.load() */
});
```

Patrón de líneas (Invoices/Proposals): el **diálogo es agnóstico de persistencia**. El padre decide en `afterClosed()` si persiste inmediatamente (edición de entidad ya guardada) o solo actualiza un signal en memoria (creación batch).

### 7.7 Rutas y permisos

| Acción | Ruta |
|--------|------|
| Listado | `/products` |
| Crear | `/products/create` |
| Ver/Editar | `/products/:id` |

En `app.routes.ts`: `loadComponent` (lazy) siempre, `title` siempre, `canActivate` con el guard del módulo. **`create` va declarado ANTES de `:id`.**

Permisos en 3 capas: guard de ruta (`common/infrastructure/guards/`) → `computed()` de `GlobalInfoService.right()` en el componente → `requireHttpRight(policy)` en el router del BFF. Las tres son obligatorias.

---

## 8. Flujo de trabajo (OpenSpec + AI Hub)

```
/opsx:explore  →  /opsx:propose  →  ⛔ APROBACIÓN HUMANA  →  /opsx:apply  →  /opsx:archive
```

- Artefactos en `openspec/changes/<nombre>/{proposal.md, design.md, specs/**, tasks.md}`.
- `openspec/specs/` = estado **fusionado** actual (180 capabilities). `openspec/changes/*/specs/` = **deltas**.
- Capability nueva → `## ADDED Requirements`. Capability existente que cambia → copia el bloque completo desde `openspec/specs/<cap>/spec.md` y usa `## MODIFIED Requirements`.
- Cada requisito necesita `### Requirement: <n>` + al menos un `#### Scenario: <n>` (**exactamente 4 almohadillas** — 3 falla en silencio).
- **Grep `openspec/specs/` antes de inventar un nombre de capability.**
- CLI: `openspec status --change "<n>" --json` → `openspec instructions <artifact> --change "<n>" --json` → escribir en `resolvedOutputPath` → re-verificar. Orden de dependencias: proposal → {design, specs} → tasks.
- Estado de sesión: `.planning/.active_plan`, `.planning/current.md`, `.planning/context-next.md` (generado por `node .ai-hub/core/dist/bin/ai-hub.js context`).
- Evidencia de exploración: `.planning/findings-*.md`. **Léela antes de re-explorar** — hay ~60 documentos de hallazgos ya escritos.

**Modo orquestador**: para cambios que tocan código nuevo, el orquestador delega en subagentes (`spec-author`, `implementer-frontend`, `implementer-backend`, `reviewer-architecture`, `reviewer-tests`, `explorer-domain`) definidos en `.ai-hub/agents/`. Los subagentes se comunican **por fichero** (`.planning/impl_*.md`, `.planning/review_*.md`), nunca por chat. Excepción: fixes de 1-2 ficheros sin cambio de patrón se hacen directos.

---

## 9. Receta: replicar un módulo desde `products`

**Regla de paridad**: todo igual que products; solo cambian entidad, enums, campos y endpoints.

### Antes
- [ ] Leer `.ai-hub/references/products-module-blueprint.md` (§0, 2, 3, 9)
- [ ] Leer `backend/doc/swagger.json` — **fuente de verdad de endpoints/campos de Dolibarr**. Nunca inventes un endpoint ni un campo.
- [ ] Spec OpenSpec aprobada
- [ ] Confirmar permisos (`requireHttpRight` + guards)

### Orden de implementación (dominio → backend → frontend)

**1. Dominio (backend)** — `<entidad>.ts`, 5 DTOs, enums en `domain/enums/`, `@Field` en DTOs de escritura y en filtros de listado.

**2. Backend infraestructura**
- [ ] `<entidad>DolibarrDto.ts` (snake_case, tipos PHP)
- [ ] Mappers (`toDomain`/`fromDomain` + un mapper por enum)
- [ ] 5 DALs con `run(request)` único
- [ ] Router con `createRequestScope` + `InjectionTokens` + Zod en POST/PUT
- [ ] Registro en `container.ts` (SCOPED) + montaje en `server.ts`
- [ ] `cd backend && npx tsc --noEmit`

**3. Frontend**
- [ ] Copiar `domain/` **exacto** del backend
- [ ] DALs en `infrastructure/dal/backend/` (`QueryBackendDal` lecturas / `ServiceBackendDal` mutaciones), `basePath` hardcoded
- [ ] Listado `extends AppQueryBase`; create/update `extends AppServiceBase`
- [ ] Pipes label/color/icon para cada enum visible
- [ ] Componentes en `infrastructure/components/<entidad>s-{getall,create,update}/`
- [ ] Rutas en `app.routes.ts` (`create` antes de `:id`) + guards
- [ ] `cd frontend && ng build`

### Nunca
- Copiar ficheros legacy
- Inventar endpoints o campos de Dolibarr
- Definir tipos en routers o componentes
- Heredar `DolibarrDal` fuera de `infrastructure/dal/dolibarr/`
- Usar `NgModule`, inyección por constructor o `*ngIf`

### Si hay duda
**Pregunta al usuario.** No asumas ni dejes placeholders.

---

## 10. Contradicciones doc↔código y trampas conocidas

Estas son las que ya han hecho perder tiempo. La columna "verdad" está verificada contra el código.

| Tema | Lo que dice alguna doc | **Verdad (código)** |
|------|------------------------|---------------------|
| Herencia `DolibarrDal` | `CLAUDE.md` y `replicate-module-checklist.md`: "solo composición, nunca herencia" | Los DALs en `infrastructure/dal/dolibarr/` **DEBEN** hacer `extends DolibarrDal`. Prohibido fuera de esa carpeta y prohibido DAL→DAL. (`AGENTS.md` regla 4 + harness 05) |
| Iconos | `onna-architecture-angular` muestra `mat-icon` + Material Icons | **Lucide** (`@lucide/angular`) en todo lo nuevo. Material Icons solo en legacy |
| Nombre del listado | Docs/memoria: `products-list` | El componente real es **`products-getall`** |
| Resultado de GetById | Skill BFF: `return { item: ... }` | `ProductsGetByIdDal` devuelve `{ data: [item] }`. `extractLoadedItem()` soporta ambos |
| `ProductStatus` | Skill common: `Inactive=0, Active=1` | Real: `Inactive=0, ToBuy=1, ToSell=2, ToBuyToSell=3` |
| `ProductsUpdateDto` | Skill common: "no incluye `id`" | Real: `ProductsUpdateDto extends ProductsCreateDto` **y añade `id: number`**; el DAL usa `request.id` |
| `limit` por defecto | `QueryListDto.limit = 100` | La UI usa **50** (`MAT_PAGINATOR_DEFAULT_OPTIONS`). Ambos coexisten a propósito |
| Zero-any | "prohibición absoluta" | La regla del harness es **WARN**, no FAIL. Quedan 24 ocurrencias legacy. No añadas ninguna nueva |
| Agente `architect` | Su prompt manda leer `ai-architect-instructions.md` y escribir `.kiro/specs/` | **Ese fichero y `.kiro/` NO existen.** El workflow real es OpenSpec |
| Composición vs duplicación | Instinto de "extraer componente compartido" | En `purchase-invoices` el usuario **rechazó composición dos veces** y exigió duplicar. No vuelvas a proponer composición en esa línea de trabajo |
| Endpoints `supplierinvoices` | "se comporta como `invoices`" | **Falso repetidamente** (3 casos confirmados): campos y endpoints difieren. Verifica en vivo antes de asumir |

**Trampas técnicas adicionales**:
- **Zoneless**: mutar una propiedad plana no repinta. Todo estado de vista va en signals.
- `noPropertyAccessFromIndexSignature` está activo: `controls['ref']`, no `controls.ref`.
- Dolibarr serializa la PK como `id`, no `rowid`, en JSON — pero los `sqlfilters` sí usan `t.rowid`.
- `sortfield` necesita el prefijo de tabla `t.`.
- El pipeline `pick(fields)` filtra **en memoria**, no reduce la carga de Dolibarr.
- `responseType: 'blob'` en descargas hace que `err.error` sea un `Blob`, no JSON — el patrón `err.error?.error` no encuentra el mensaje del BFF.
- Paginación hasta 1000 por página: cuidado con cualquier enriquecimiento por fila (N+1 real).

---

## 11. Verificación obligatoria

```bash
# Backend — tipado
cd backend && npx tsc --noEmit

# Backend — tests (Vitest, node, globals:false, cobertura mínima 70%)
cd backend && npm test
cd backend && npm run test:coverage

# Backend — aplicar cambios en Docker (OBLIGATORIO tras tocar backend)
docker compose down && docker compose build --no-cache backend && docker compose up -d backend

# Frontend — build de verificación
cd frontend && ng build

# Frontend — desarrollo
cd frontend && ng serve

# Frontend — tests (Vitest vía @angular/build:unit-test, cobertura mínima 60%)
cd frontend && npm test

# Reglas arquitectónicas automatizadas
bash .ai-hub/harness/run-all.sh

# Entorno completo
bash .ai-hub/bootstrap/verify.sh
```

**Testing**:
- Ambos lados: **Vitest** con `globals: false` → imports explícitos (`import { describe, it, expect, vi } from 'vitest'`).
- Backend: tests en `backend/tests/**/*.test.ts`. Mockear `DolibarrClient` (hay `__mocks__/dolibarrClient.ts`). Supertest para routers. `fast-check` para property-based en lógica compleja.
- Frontend: `*.spec.ts` junto al código. Mockear **DALs**, no services. Preferir tests de lógica pura sin `TestBed`.

**Stack Docker completo**: `db` (MariaDB 11.4.5) + `phpmyadmin` (:8080) + `dolibarr` (:83) + `backend` (:3000) + `frontend` (:80).

---

## 12. Índice de documentación del repo

| Documento | Qué aporta | Fiabilidad |
|-----------|-----------|------------|
| `AGENTS.md` (267 KB) | Constitución global, ADRs, ejemplos completos, anti-patrones | Alta, pero verifica contra código |
| `CLAUDE.md` | Config de Claude Code + resumen de reglas | Media (ver §10) |
| `.ai-hub/manifest.yaml` | Registro de agentes, skills, MCPs, rule sources | Alta |
| `.ai-hub/orchestrator/{PROMPT,workflow,delegation-rules}.md` | Identidad y flujo del orquestador | Alta |
| `.ai-hub/references/products-module-blueprint.md` | Blueprint completo del módulo canónico | **Muy alta** |
| `.ai-hub/references/replicate-module-checklist.md` | Checklist pre-vuelo | Alta (salvo la línea de herencia DAL) |
| `.ai-hub/references/common-imports-catalog.md` | Qué reutilizar de `common/` | Alta |
| `.ai-hub/skills/shared/onna-architecture-{common,angular,bff}/SKILL.md` | Reglas por capa | Alta con matices (§10) |
| `.ai-hub/skills/shared/onna-design-system/SKILL.md` | Diseño de ventanas y formularios | Alta |
| `frontend/dessign.md` | Listados, KPI cards, modales, variables CSS | Alta (no cubre formularios de página completa) |
| `.ai-hub/rules/frontend.md` | Iconos de sidebar, convención de `application/` | Alta |
| `backend/doc/swagger.json` | **Fuente de verdad de la API Dolibarr** | Máxima |
| `guia-migracion-{monorepo,frontend,backend}.md` | Paso a paso técnico de migración | Alta |
| `.claude/agent-memory/architect/` | Decisiones y riesgos por change (purchase-invoices, proposals, formularios) | **Muy alta** — léela antes de tocar esos módulos |
| `.planning/findings-*.md` (~60) | Evidencia de exploraciones previas | Alta — evita re-explorar |
| `openspec/specs/` (180) | Estado fusionado de capabilities | Alta |

---

## 13. Mantenimiento de este skill

Cuando descubras que algo aquí ya no es cierto:
1. Corrígelo **con la referencia al fichero de código** que lo demuestra.
2. Si es una contradicción doc↔código nueva, añádela a la tabla de §10.
3. Este fichero está en `.gitignore` — es contexto local, no artefacto del repo. No lo commitees.
