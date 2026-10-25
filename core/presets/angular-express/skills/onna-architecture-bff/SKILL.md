---
name: onna-architecture-bff
description: Define la arquitectura específica del BFF (Node.js + Express) de Onna/Doligestion. Activa este skill al crear o modificar rutas, middleware, DALs o cualquier fichero TypeScript del backend. Complementa onna-architecture-common con las decisiones propias del BFF.
license: MIT
---

# Onna BFF Architecture Guidelines

Decisiones arquitectónicas propias del BFF (Node.js + Express). Para el contrato compartido con el frontend (dominio, DTOs, errores): ver `onna-architecture-common`.

## Rol del BFF

Orquestador entre Angular y Dolibarr/Kubernetes. Es el único punto de entrada desde el frontend:
- Inyecta el `dolikey` (API key de Dolibarr) en todas las peticiones salientes — nunca expuesto al frontend.
- Gestiona autenticación mediante cookies `httpOnly`, `secure`, `SameSite: Strict`.
- Tiene dos funciones muy imporntes:
  - Recibe la llamada con el router de Nodejs + Express desde el frontend
  - Transforma respuestas crudas de Dolibarr (PHP snake_case) en interfaces de dominio tipadas y envia las llamadas a los métodos de dolibarr a través de sus DTOs.

## Estructura de carpetas

```
src/
  <dominio>/
    domain/                        → Interfaces, enums, DTOs (= frontend, ver onna-architecture-common)
    infrastructure/
      dal/dolibarr/
        <entidad>DolibarrDto.ts    → Shape crudo de la respuesta de Dolibarr
        <Entidad>GetAllDal.ts      → extends DolibarrDal, implements IQueryGetListDal
        <Entidad>GetByIdDal.ts     → instancia DolibarrClient directamente, implements IQueryGetItemDal
        <Entidad>CreateDal.ts      → extends DolibarrDal, implements IServiceDal
        <Entidad>UpdateDal.ts      → extends DolibarrDal, implements IServiceDal
        <Entidad>DeleteDal.ts      → extends DolibarrDal, implements IServiceDal
        enums/                     → Enums exclusivos de la capa DAL (ej. ProductMode para filtros)
        mappers/
          <entidad>Mapper.ts       → toDomain() + fromDomain()
          <entidad>StatusMapper.ts → fromDomain/toDomain para cada enum
      router/
        <entidad>Router.ts         → Endpoints Express para este dominio
  common/
    infrastructure/dolibarr/
      dolibarrClient.ts            → Cliente HTTP a Dolibarr (create/read/update/delete/query2)
      dolibarrDal.ts               → Clase base abstracta con helpers de filtros SQL
      dolibarrMapper.ts            → Clase base vacía para mappers
  container.ts                     → Registro Awilix (IoC) + createRequestScope
```

## Patrón DAL — Clases base

El patrón DAL (Data Access Layer) es una capa de adaptador para transformar las entidades de dominio en las del dominio subyacente (en nuestro caso principalmente Dolibrr) o realizar las llamadas a los métodos del sistema donde están los datos (principalmente Dolibarr).

### DolibarrDal (abstract)

Clase base para DALs que necesitan filtros SQL o acceso múltiple a Dolibarr:

```typescript
export abstract class DolibarrDal {
  protected dolibarr: DolibarrClient;

  constructor(dolikey: string, entityId: number = 1) {
    this.dolibarr = new DolibarrClient(dolikey, entityId);
  }

  // Construye filtro SQL: strings → LIKE '%valor%', números → :=:valor
  protected mapFiltersFromDomain(value: string | number | undefined | null, columns: string[]): string

  // Combina múltiples filtros con AND (ignora los vacíos)
  protected combineSqlFilters(...filters: string[]): string
}
```

### Cuándo extender DolibarrDal vs instanciar DolibarrClient directamente

- **Extender `DolibarrDal`**: GetAll, Create, Update, Delete — necesitan `combineSqlFilters` o varias llamadas.
- **Instanciar `DolibarrClient` directamente**: GetById — operación puntual sin filtros SQL.

## Patrón DAL — GetAll

Obtiene una colección paginada. Construye los filtros SQL a partir del DTO, llama a `query2` en Dolibarr, y transforma cada elemento crudo a dominio con el mapper. La proyección de campos (`fields`) se aplica en memoria mediante el operador `pick` de RxJS antes de devolver la lista.

```typescript
export class ProductsGetAllDal extends DolibarrDal implements IQueryGetListDal<ProductsGetAllDto, Product> {
  private endpoint = 'products';
  private productMapper = new ProductMapper();
  private productModeMapper = new ProductModeMapper();
  private productStatusMapper = new ProductStatusMapper();

  constructor(dolikey: string, entityId: number = 1) {
    super(dolikey, entityId);
  }

  async run(request: ProductsGetAllDto): Promise<QueryListResult<Product>> {
    request.sortfield = `t.${request.sortfield || 'rowid'}`;

    const paramsSql = {
      sqlfilters: this.combineSqlFilters(
        this.mapFiltersFromDomain(request.filterBy.trim(), ['t.label', 't.ref']),
        this.mapFiltersFromDomain(request.status, ['t.tosell'])
      ),
      mode: this.productModeMapper.fromDomain(ProductMode.Products),
      status: this.productStatusMapper.fromDomain(request.status),
    };

    const responseRaw = await this.dolibarr.query2<ProductDolibarrDto>(this.endpoint, paramsSql, request);
    const response = await lastValueFrom(
      from(responseRaw.data).pipe(
        map(item => this.productMapper.toDomain(item)),
        pick(request.fields?.split(',') ?? []),
        toArray()
      )
    );

    return { data: response, pagination: responseRaw.pagination };
  }
}
```

## Patrón DAL — GetById

Obtiene un único registro por su `id`. No extiende `DolibarrDal` porque no necesita filtros SQL — instancia `DolibarrClient` directamente. Llama a `read` y transforma el resultado con el mapper.

```typescript
export class ProductsGetByIdDal implements IQueryGetItemDal<ProductsGetByIdDto, Product> {
  private dolibarr: DolibarrClient;
  private productMapper = new ProductMapper();

  constructor(dolikey: string, entityId: number = 1) {
    this.dolibarr = new DolibarrClient(dolikey, entityId);
  }

  async run(request: ProductsGetByIdDto): Promise<QueryItemResult<Product>> {
    const item = await this.dolibarr.read<ProductDolibarrDto>('products', request.id);
    return { item: this.productMapper.toDomain(item) };
  }
}
```

## Patrón DAL — Create / Update / Delete

Las tres operaciones siguen el mismo flujo: reciben el DTO de dominio, lo transforman al shape de Dolibarr con `fromDomain`, llaman al método correspondiente del cliente, y devuelven el request original (no la respuesta de Dolibarr, que en estos casos no aporta más información que la ya conocida). Delete es la excepción: no necesita mapper porque solo requiere el `id`.

```typescript
// Create: mapea dominio → DTO Dolibarr y devuelve el request original
export class ProductsCreateDal extends DolibarrDal implements IServiceDal<ProductsCreateDto, Product> {
  private productMapper = new ProductMapper();

  constructor(dolikey: string, entityId: number = 1) {
    super(dolikey, entityId);
  }

  async run(request: ProductsCreateDto): Promise<Product> {
    const dto = this.productMapper.fromDomain(request);
    await this.dolibarr.create<unknown>('products', dto);
    return request;
  }
}

// Update: el id llega inyectado desde req.params junto al DTO — no forma parte del UpdateDto
export class ProductsUpdateDal extends DolibarrDal implements IServiceDal<{ id: number; dto: ProductsUpdateDto }, Product> {
  private productMapper = new ProductMapper();

  constructor(dolikey: string, entityId: number = 1) {
    super(dolikey, entityId);
  }

  async run({ id, dto }: { id: number; dto: ProductsUpdateDto }): Promise<Product> {
    const dolibarrDto = this.productMapper.fromDomain(dto);
    await this.dolibarr.update<unknown>('products', id, dolibarrDto);
    return { id, ...dto };
  }
}

// Delete: solo necesita el id — no requiere mapper
export class ProductsDeleteDal extends DolibarrDal implements IServiceDal<ProductsDeleteDto, Product> {
  constructor(dolikey: string, entityId: number = 1) {
    super(dolikey, entityId);
  }

  async run(request: ProductsDeleteDto): Promise<ProductsDeleteDto> {
    await this.dolibarr.delete('products', request.id);
    return request;
  }
}
```

## Patrón Mapper

El mapper es la frontera entre la capa subyacente (Dolibarr) y el dominio de la aplicación. Contiene dos métodos:
- **`toDomain`**: transforma el DTO crudo de Dolibarr (`<Entidad>DolibarrDto`) en la entidad de dominio (`Product`, `Invoice`...). Convierte snake_case a camelCase, números a booleanos o enums, y garantiza que los strings nunca sean `undefined` (`?? ''`).
- **`fromDomain`**: transforma la entidad de dominio (o un DTO de Update/Create) en el shape que espera Dolibarr. El proceso inverso.

El `<Entidad>DolibarrDto` es el shape crudo tal como llega de Dolibarr: snake_case, tipos PHP mezclados (números donde el dominio usa booleanos, strings donde usa enums, etc.).

```typescript
// Shape crudo de Dolibarr
export interface ProductDolibarrDto {
  id: number;
  ref?: string;
  label?: string;
  status?: number;          // tosell: 1 = activo, 0 = inactivo
  status_buy?: number;      // tobuy
  price?: number;
  tva_tx?: number;          // ivaRate
  price_base_type?: string; // 'HT' | 'TTC'
  cost_price?: number;
}

export class ProductMapper extends DolibarrMapper {
  private productStatusMapper = new ProductStatusMapper();
  private priceBaseTypeMapper = new ProductPriceBaseTypeMapper();

  toDomain(item: ProductDolibarrDto): Product {
    return {
      id: Number(item.id),
      ref: item.ref ?? '',                                              // string → siempre ''
      label: item.label ?? '',                                          // string → siempre ''
      status: this.productStatusMapper.toDomain(item.status),
      toSell: item.status !== undefined ? Boolean(item.status) : undefined,
      price: item.price !== undefined ? Number(item.price) : undefined,
      ivaRate: item.tva_tx !== undefined ? Number(item.tva_tx) : undefined,
      priceBaseType: this.priceBaseTypeMapper.toDomain(item.price_base_type),
      toBuy: item.status_buy !== undefined ? Boolean(item.status_buy) : undefined,
      costPrice: item.cost_price !== undefined ? Number(item.cost_price) : undefined,
    };
  }

  fromDomain(item: Partial<Product>): ProductDolibarrDto {
    return {
      id: item.id ?? 0,
      ref: item.ref ?? '',                                              // string → siempre ''
      label: item.label ?? '',                                          // string → siempre ''
      status: item.toSell !== undefined ? Number(item.toSell) : undefined,
      price: item.price ?? undefined,
      tva_tx: item.ivaRate ?? undefined,
      price_base_type: this.priceBaseTypeMapper.fromDomain(item.priceBaseType),
      status_buy: item.toBuy !== undefined ? Number(item.toBuy) : undefined,
      cost_price: item.costPrice ?? undefined,
    };
  }
}

// Mapper de enum
export class ProductStatusMapper {
  toDomain(value?: number): ProductStatus | undefined {
    if (value === undefined) return undefined;
    return value === 1 ? ProductStatus.Active : ProductStatus.Inactive;
  }

  fromDomain(status?: ProductStatus): number | undefined {
    if (status === undefined) return undefined;
    return status === ProductStatus.Active ? 1 : 0;
  }
}
```

### Reglas del Mapper

- `toDomain`: strings siempre con `?? ''` — nunca `undefined` para campos string en dominio.
- `toDomain`: números y booleanos con `!== undefined ? Number/Boolean(...) : undefined` — nunca colapsar el `0` o `false` con un `if (valor)`.
- `fromDomain`: recibe `Partial<Product>` para admitir tanto Create como Update sin duplicar el mapper.
- Los mappers de enum son clases separadas (`ProductStatusMapper`, `ProductPriceBaseTypeMapper`, etc.), instanciadas como atributos privados del mapper principal.

## Patrón Router (Express)

Un fichero por dominio. Incluye todos los endpoints CRUD del dominio.

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { buildZodSchema } from '../../common/infrastructure/buildZodSchema';
import { requireHttpRight } from '../../common/infrastructure/requireHttpRight';
import { AuthenticatedRequest, createRequestScope } from '../../container';
import { InjectionTokens } from '../../container';
import { productHttpRightPolicy } from './productHttpRightPolicy';
import { ProductsGetAllDto } from '../domain/productsGetAllDto';
import { ProductsGetByIdDto } from '../domain/productsGetByIdDto';
import { ProductsCreateDto } from '../domain/productsCreateDto';
import { ProductsUpdateDto } from '../domain/productsUpdateDto';
import { ProductsDeleteDto } from '../domain/productsDeleteDto';

const router = Router();

router.use(requireHttpRight(productHttpRightPolicy, 'No tienes permiso para gestionar productos'));

// GET /products — listado paginado
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session, query } = req as AuthenticatedRequest;
    const request = new ProductsGetAllDto(query);

    const scope = createRequestScope(session.dolikey, session.entity);
    const dal = scope.resolve(InjectionTokens.productsGetAllDal);
    res.json(await dal.run(request));
  } catch (error) {
    next(error);
  }
});

// GET /products/:id — detalle por id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session } = req as AuthenticatedRequest;
    const request = new ProductsGetByIdDto({ id: Number(req.params.id) });

    const scope = createRequestScope(session.dolikey, session.entity);
    const dal = scope.resolve(InjectionTokens.productsGetByIdDal);
    res.json(await dal.run(request));
  } catch (error) {
    next(error);
  }
});

// POST /products — crear
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = buildZodSchema(ProductsCreateDto).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload inválido', statusCode: 400, details: z.flattenError(parsed.error) });
    }

    const { session } = req as AuthenticatedRequest;
    const scope = createRequestScope(session.dolikey, session.entity);
    const dal = scope.resolve(InjectionTokens.productsCreateDal);
    res.json(await dal.run(parsed.data));
  } catch (error) {
    next(error);
  }
});

// PUT /products/:id — actualizar
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = buildZodSchema(ProductsUpdateDto).safeParse({ ...req.body, id: Number(req.params.id) });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload inválido', statusCode: 400, details: z.flattenError(parsed.error) });
    }

    const { session } = req as AuthenticatedRequest;
    const scope = createRequestScope(session.dolikey, session.entity);
    const dal = scope.resolve(InjectionTokens.productsUpdateDal);
    res.json(await dal.run(parsed.data));
  } catch (error) {
    next(error);
  }
});

// DELETE /products/:id — eliminar
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session } = req as AuthenticatedRequest;
    const request = new ProductsDeleteDto({ id: Number(req.params.id) });  // sin validación Zod — solo id

    const scope = createRequestScope(session.dolikey, session.entity);
    const dal = scope.resolve(InjectionTokens.productsDeleteDal);
    res.json(await dal.run(request));
  } catch (error) {
    next(error);
  }
});

export default router;
```

### Reglas del Router

- `GET /` — construye el DTO desde `req.query` directamente con `new ProductsGetAllDto(query)`. Sin validación Zod (los parámetros de listado son opcionales).
- `GET /:id` — construye el DTO con `new ProductsGetByIdDto({ id: Number(req.params.id) })`. Sin validación Zod.
- `POST /` y `PUT /:id` — validan el body con `buildZodSchema(Dto).safeParse(...)`. El `id` en PUT se inyecta desde `req.params.id`.
- `DELETE /:id` — construye el DTO con `new ProductsDeleteDto({ id: Number(req.params.id) })`. Sin validación Zod.
- Siempre `next(error)` en el catch — el middleware global de Express formatea el error como `ErrorResult`.

## Sistema de validación con @Field + buildZodSchema

Los decoradores `@Field` de los DTOs generan automáticamente el esquema Zod. No escribir esquemas Zod a mano.

```typescript
// En el router:
const parsed = buildZodSchema(ProductsUpdateDto).safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({
    error: 'Payload inválido',
    statusCode: 400,
    details: z.flattenError(parsed.error)
  });
}
```

Los DTOs de dominio definen los `@Field` — ver `onna-architecture-common` para el contrato completo.

## IoC Container (Awilix)

Todos los DALs se registran en `src/container.ts` y se resuelven por petición mediante `createRequestScope`:

```typescript
// container.ts — registro
const registrations = {
  productsGetAllDal:    asClass(ProductsGetAllDal,    { lifetime: Lifetime.SCOPED }),
  productsGetByIdDal:   asClass(ProductsGetByIdDal,   { lifetime: Lifetime.SCOPED }),
  productsCreateDal:    asClass(ProductsCreateDal,    { lifetime: Lifetime.SCOPED }),
  productsUpdateDal:    asClass(ProductsUpdateDal,    { lifetime: Lifetime.SCOPED }),
  productsDeleteDal:    asClass(ProductsDeleteDal,    { lifetime: Lifetime.SCOPED }),
};

export const InjectionTokens = Object.fromEntries(
  Object.keys(registrations).map(k => [k, k])
) as { [K in keyof typeof registrations]: K };

export function createRequestScope(dolikey: string, entityId: number) {
  const scope = container.createScope<RequestCradle>();
  scope.register({ dolikey: asValue(dolikey), entityId: asValue(entityId), ...registrations });
  return scope;
}

// En el router:
const scope = createRequestScope(session.dolikey, session.entity);
const dal = scope.resolve(InjectionTokens.productsGetAllDal);
```

Al añadir un nuevo DAL: (1) importarlo en `container.ts`, (2) añadirlo a `registrations`, (3) `InjectionTokens` se genera automáticamente.

## Jerarquía de errores

| Clase | statusCode | Uso |
|-------|------------|-----|
| `ArgumentError` | 400 | Parámetro inválido |
| `NotAuthenticatedError` | 401 | Sin sesión |
| `ForbiddenError` | 403 | Sin permisos |
| `NotFoundError` | 404 | No encontrado |
| `IllegalOperationError` | 422 | Operación no permitida |
| `InternalError` | 500 | Error no controlado |

Los errores no controlados deben llegar a `next(error)` — el middleware global de Express los formatea como `ErrorResult`.

## Reglas de estilo

- **Zero-Any**: prohibido `any`. Usar el tipo de dominio o `unknown`.
- **Async/Await**: exclusivo. Prohibido `.then()/.catch()` encadenados.
- DALs son clases, no funciones. Un fichero por DAL.
- Los mappers son clases instanciadas como atributos privados del DAL que las usa (no singleton, no inyectados).
- Los enums exclusivos de la capa DAL (como `ProductMode` para el parámetro `mode` de Dolibarr) viven en `infrastructure/dal/dolibarr/enums/`, no en `domain/`.

## Verificación obligatoria tras cambios

```bash
cd backend && npx tsc --noEmit
```
