---
name: onna-architecture-common
description: Define el contrato compartido entre el frontend Angular y el BFF (Node.js/Express) de Onna/Doligestion. Activa este skill al tocar cualquier clase de dominio, enumeración, DTO, tipo de error o interfaz de comunicación entre frontend y backend.
license: MIT
---

# Onna Architecture — Contrato Común Frontend ↔ BFF

Todo lo que debe ser **igual en el frontend y en el BFF**. Cualquier cambio en un lado debe replicarse en el otro inmediatamente.

## Estructura de dominio compartido

```
src/<dominio>/domain/
  <entidad>.ts                  → interface principal (ej. Product)
  <entidad>CreateDto.ts         → extends UpdateDto, o campos propios si difieren
  <entidad>UpdateDto.ts         → campos modificables con decoradores @Field
  <entidad>DeleteDto.ts         → solo { id: number }
  <entidad>GetAllDto.ts         → extends QueryListDto con campos de filtro
  <entidad>GetByIdDto.ts        → extends QueryItemDto
  enums/
    <entidad>Status.ts          → enum de estado
    <entidad>Type.ts            → enum de tipo
    <entidad>PriceBaseType.ts   → enum auxiliar (si aplica)
```

Un fichero por artefacto. Nunca dos tipos en el mismo fichero.

## Convenciones de naming — obligatorias en todo el código

| Artefacto | Idioma | Casing | Ejemplo |
|-----------|--------|--------|---------|
| Clases, interfaces, tipos, enums | Inglés | PascalCase | `Product`, `ProductStatus`, `ProductsGetAllDto` |
| Campos de clase/interfaz | Inglés | camelCase | `priceBaseType`, `costPrice`, `notePublic` |
| Métodos | Inglés | camelCase | `toDomain()`, `fromDomain()`, `run()` |
| Parámetros | Inglés | camelCase | `dolikey`, `entityId`, `request` |
| Valores de enum | Inglés | PascalCase | `ProductStatus.Active`, `SortOrder.Asc` |
| Ficheros | Inglés | camelCase | `productsGetAllDto.ts`, `productMapper.ts` |

Las siglas se tratan como palabras normales en PascalCase: `Dto` no `DTO`, `Dal` no `DAL`, `Bff` no `BFF`, `Asc` no `ASC`.

Prohibido usar español en cualquier identificador de código (clases, campos, métodos, parámetros, variables, ficheros). El español solo aparece en los valores del decorador `@Field` (`label:`) y en el texto visible al usuario en templates HTML.

## Interfaz de entidad

Solo `id` obligatorio. Todo lo demás opcional con `?`. Sin uniones de tipos (`string | number`).

```typescript
// ✅ Correcto
export interface Product {
  id: number;
  type?: ProductType;
  ref?: string;
  label?: string;
  description?: string;
  status?: ProductStatus;
  toSell?: boolean;
  price?: number;
  priceBaseType?: ProductPriceBaseType;
  ivaRate?: number;
  iva?: number;
  toBuy?: boolean;
  costPrice?: number;
  weight?: number;
  length?: number;
  surface?: number;
  volume?: number;
  notePublic?: string;
  notePrivate?: string;
}

// ❌ Incorrecto
export interface Product {
  id: number;
  ref: string;           // todos los campos salvo id son opcionales
  price?: number | null; // prohibidas las uniones de tipos
  fk_category?: number;  // las referencias a otras entidades van como objeto tipado, no como id plano
}
```

Las referencias a otras entidades se expresan como objetos tipados, no como `fk_*: number`.

## DTOs — contrato de interfaz frontend ↔ BFF

Los DTOs son los **parámetros de entrada** de todas las consultas y servicios. Definen la interfaz exacta entre el frontend y el BFF. Cada campo visible en un formulario, tabla o filtro tiene su DTO correspondiente.

### Reglas generales de todos los DTOs

- **Todos los campos llevan `@Field`** — sin excepción, incluyendo los filtros de estado/tipo. Son la fuente de verdad que alimenta:
  - La validación Zod automática en el BFF (`buildZodSchema`)
  - Los formularios reactivos en el frontend (`formGroupFromDto`)
  - La configuración de tablas y filtros de listado
- Los campos se mapean directamente contra los campos de la entidad de dominio. El DTO es la proyección de la entidad para un caso de uso concreto.
- Todos los campos de tipo `string` llevan `defaultValue: ''` — nunca `undefined` ni `null`. `''` equivale a "sin valor" para strings.
- Los campos de tipo `Number`, `Boolean` y `Enum` opcionales no llevan `defaultValue` — `undefined` equivale a `null` (sin valor).
- Los campos `Boolean` o `Enum` con `required: true` llevan `defaultValue` para que el formulario tenga estado inicial definido.
- Los filtros de enum opcionales (`status?`, `type?`) no llevan `required` ni `defaultValue` — `undefined` significa "sin filtro" (devolver todos).
- Cuando el DTO extiende otra clase, el constructor llama a `super(init)` primero y luego asigna los campos propios.
- `fields` nunca se inicializa en el DTO — se asigna en el componente o route con la proyección mínima necesaria.

### Metadatos FieldMeta disponibles

| Campo | Tipo | Uso |
|-------|------|-----|
| `label` | string | Etiqueta del campo en UI y mensajes de error |
| `genere` | FieldGenere.male/female | Para mensajes de error con concordancia de género |
| `type` | FieldType | String, Number, Boolean, Enum |
| `subType` | FieldSubType | LargeText, Price, Percent (afecta al campo visual) |
| `required` | boolean | Validación obligatoria |
| `defaultValue` | string/number/boolean | Valor inicial del campo |
| `min` / `max` | number | Límites para String (longitud) y Number (valor) |
| `enumType` | object | El enum (para validación Zod y selector de opciones) |

## DTO GetAll

Obtiene una colección paginada. Siempre extiende `QueryListDto`, que provee la paginación, ordenación y proyección de campos base.

### QueryListDto (clase base, no instanciar directamente)

```typescript
export enum SortOrder { Asc = 1, Desc = 2 }

export class QueryListDto extends QueryDto {
  page: number = 0;              // página actual (0-based)
  limit: number = 100;           // elementos por página
  page_count?: number;           // total de páginas (lo rellena el BFF en la respuesta)
  total?: number;                // total de elementos (lo rellena el BFF en la respuesta)
  sortfield: string = '';        // campo de ordenación (ej. "rowid", "label")
  sortorder: SortOrder = SortOrder.Asc;
  fields?: string;               // proyección de campos separados por coma — se asigna en el componente
}
```

### Patrón GetAllDto de entidad

Añade obligatoriamente `filterBy` y un campo de filtro por cada dimensión por la que se quiera filtrar (estado, tipo, etc.).

```typescript
import { QueryListDto } from '../../common/domain/queryListDto';
import { Field, FieldGenere, FieldType } from '../../common/domain/field-meta';
import { ProductStatus } from './enums/productStatus';

export class ProductsGetAllDto extends QueryListDto {
  // Filtro de estado opcional — undefined significa "devolver todos"
  @Field({ label: 'Estado', genere: FieldGenere.male, type: FieldType.Enum, enumType: ProductStatus })
  status?: ProductStatus;

  // Búsqueda de texto libre contra todos los campos string del listado
  @Field({ label: 'Buscar por...', genere: FieldGenere.male, type: FieldType.String, defaultValue: '' })
  filterBy: string = '';

  constructor(init?: Partial<ProductsGetAllDto>) {
    super(init);
    this.status = init?.status;
    this.filterBy = init?.filterBy ?? '';
  }
}
```

**`filterBy`** siempre presente. En el BFF se mapea contra todos los campos string del listado con `mapFiltersFromDomain(request.filterBy.trim(), ['t.label', 't.ref', ...])`.

## DTO GetById

Obtiene una entidad completa por su `id` para rellenar el formulario de edición. El caso habitual es solo el `id` — `QueryItemDto` ya lo provee, por lo que el DTO queda vacío salvo el constructor.

```typescript
import { QueryItemDto } from '../../common/domain/queryItemDto';

export class ProductsGetByIdDto extends QueryItemDto {
  constructor(init?: Partial<ProductsGetByIdDto>) {
    super(init);
  }
}
```

Si el caso de uso requiere parámetros extra (p.ej. `includeArchived: boolean`), se añaden con `@Field` siguiendo las reglas generales.

## DTO Delete

Identifica el registro a eliminar. El caso habitual es solo el `id`. No extiende ninguna clase base.

```typescript
import { Field, FieldGenere, FieldType } from '../../common/domain/field-meta';

export class ProductsDeleteDto {
  @Field({ label: 'Id', genere: FieldGenere.male, type: FieldType.Number })
  id: number = 0;
}
```

## DTO Update

Contiene todos los campos modificables de la entidad. **No incluye `id`** — el `id` se pasa por separado (como parámetro de ruta en el router) y se inyecta junto al DTO al llamar al DAL. No extiende ninguna clase base — sin constructor.

```typescript
import { Field, FieldGenere, FieldSubType, FieldType } from '../../common/domain/field-meta';
import { ProductPriceBaseType } from './enums/productPriceBaseType';

export class ProductsUpdateDto {

  // string required → defaultValue: '' obligatorio además de required: true
  @Field({ label: 'Referencia', genere: FieldGenere.female, type: FieldType.String, required: true, defaultValue: '', max: 128 })
  ref?: string;

  @Field({ label: 'Nombre', genere: FieldGenere.male, type: FieldType.String, required: true, defaultValue: '', max: 255 })
  label?: string;

  // string opcional → defaultValue: '' igualmente
  @Field({ label: 'Descripción', genere: FieldGenere.female, type: FieldType.String, defaultValue: '' })
  description?: string;

  // Number opcional — sin defaultValue; undefined equivale a null (sin valor)
  @Field({ label: 'Precio de venta', genere: FieldGenere.male, type: FieldType.Number, subType: FieldSubType.Price, min: 0 })
  price?: number;

  @Field({ label: 'Precio de compra', genere: FieldGenere.male, type: FieldType.Number, subType: FieldSubType.Price, min: 0 })
  costPrice?: number;

  @Field({ label: 'Tipo de IVA', genere: FieldGenere.male, type: FieldType.Number, subType: FieldSubType.Percent, min: 0 })
  ivaRate?: number;

  // Boolean required → defaultValue obligatorio para que el formulario tenga estado inicial definido
  @Field({ label: 'Disponible para venta', genere: FieldGenere.male, type: FieldType.Boolean, required: true, defaultValue: true })
  toSell?: boolean;

  @Field({ label: 'Disponible para compra', genere: FieldGenere.male, type: FieldType.Boolean, required: true, defaultValue: true })
  toBuy?: boolean;

  // Enum con defaultValue → valor concreto al abrir el formulario
  @Field({ label: 'Tipo de precio base', genere: FieldGenere.male, type: FieldType.Enum, enumType: ProductPriceBaseType, defaultValue: ProductPriceBaseType.ConIVA })
  priceBaseType?: ProductPriceBaseType;
}
```

## DTO Create

Si los campos de creación son los mismos que los de edición, se extiende `UpdateDto` — el `id` queda en `0` y el DAL lo ignora al crear. Si los campos difieren, se define la clase con sus propios campos siguiendo las mismas reglas que `UpdateDto`.

```typescript
// Caso habitual — mismos campos que Update
export class ProductsCreateDto extends ProductsUpdateDto {}

// Caso alternativo — campos distintos al Update
export class ProductsCreateDto {
  @Field({ label: 'Referencia', genere: FieldGenere.female, type: FieldType.String, required: true, defaultValue: '', max: 128 })
  ref?: string;
  // ... solo los campos relevantes para la creación
}
```

Cuando se extiende `UpdateDto`, no sobreescribir `id` ni ningún campo heredado.

## Comunicación frontend → BFF

- El frontend solo habla con el BFF. Nunca llama directamente a Dolibarr.
- Autenticación: cookies `httpOnly` + `withCredentials: true` en todas las peticiones.
- El BFF inyecta el `dolikey` en cada petición saliente a Dolibarr.

### Estructura de error (ErrorResult)

El BFF siempre devuelve este shape en caso de error:

```typescript
interface ErrorResult {
  error: string;
  statusCode: number;
  details?: unknown;
}
```

| Clase BFF | statusCode | Cuándo |
|-----------|------------|--------|
| `ArgumentError` | 400 | Payload inválido |
| `NotAuthenticatedError` | 401 | Sin sesión o sesión expirada |
| `ForbiddenError` | 403 | Sin permisos |
| `NotFoundError` | 404 | Recurso no encontrado |
| `IllegalOperationError` | 422 | Operación no permitida |
| `InternalError` | 500 | Error no controlado |

## Reglas de sincronía

Cuando se modifica cualquiera de estos artefactos en un lado, **se actualiza el otro inmediatamente**:

- Interfaces de entidad (`Product`, `Invoice`, `Thirdparty`...)
- Enumeraciones (`ProductStatus`, `ProductType`...)
- DTOs de entrada/salida
- `ErrorResult` y clases de error

**Excepciones permitidas solo en frontend**: tipos auxiliares de UI sin equivalente en backend (`*Stats`, filtros de listado complejos, payloads de diálogos internos).

## Enums de dominio — patrón

```typescript
// productStatus.ts
export enum ProductStatus {
  Inactive = 0,
  Active   = 1
}

// productType.ts
export enum ProductType {
  Product = 0,
  Service = 1
}

// productPriceBaseType.ts
export enum ProductPriceBaseType {
  SinIVA = 1,  // HT en Dolibarr
  ConIVA = 2   // TTC en Dolibarr
}
```

Los valores numéricos facilitan el mapeo con la capa de acceso a datos actual, pero el dominio no depende de ello — si el DAL cambia de backend, solo se actualizan los mappers, no los enums.