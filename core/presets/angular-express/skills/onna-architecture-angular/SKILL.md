---
name: onna-architecture-angular
description: Define la arquitectura específica del frontend Angular en Onna/Doligestion. Activa este skill al crear o modificar componentes, servicios, DALs, guards, interceptors o cualquier fichero TypeScript del frontend. Complementa los skills angular-developer, angular-new-app y onna-architecture-common con las decisiones propias del cliente Angular.
license: MIT
---

# Onna Angular Architecture Guidelines

Decisiones arquitectónicas propias del frontend Angular de Onna/Doligestion.

- Para buenas prácticas generales de Angular (signals, forms, routing, DI, testing, CLI): ver skill `angular-developer`.
- Para el contrato compartido con el BFF (dominio, errores, comunicación): ver skill `onna-architecture-common`.
- Para convenciones visuales de ventanas, formularios y listados: ver skill `onna-design-system`.

## Estructura de Carpetas

```
src/app/
  <dominio>/               → Una carpeta por entidad (products, invoices, fichajes...)
    domain/                → Interfaces, tipos, enumeraciones (idénticos al backend)
    application/           → Application services (lógica de caso de uso)
    infrastructure/
      dal/                 → Clases DAL: acceso al BFF, una por caso de uso
        <resources>.dal.ts
      components/          → Componentes Angular, uno por subcarpeta
        <resources>-create/
        <resources>-update/
        <resources>-retrieve/
      <resources>.service.ts  → Service que orquesta los DALs
```

Las carpetas de dominio son solo agrupadores. Ningún `.ts`, `.html` o `.css` de componente se coloca en la raíz — cada componente vive en su propia subcarpeta.

Dentro de `infrastructure/` la separación es estricta:
- `dal/` — solo clases DAL que se comunican con el BFF. Ningún componente ni lógica de UI aquí.
- `components/` — solo componentes Angular. Ninguna llamada directa a la API aquí.

## Capa DAL (Data Access Layer)

El componente nunca llama directamente a la API — siempre a través de `DAL → Service`.

- Los DALs viven en `infrastructure/dal/`
- Naming: `<resources>.dal.ts` (ej. `products.dal.ts`)
- Para casos de uso separados: `products-create.dal.ts` / `products-update.dal.ts`
- Los DALs se inyectan en los application services, no en los componentes directamente.

## Reglas de Tipado

- **Zero-Any Policy**: prohibido `any`. TypeScript estricto en todos los ficheros.
- Las interfaces de dominio viven en `<entidad>/domain/` y deben ser idénticas a las del backend (ver `onna-architecture-common`).
- Los tipos auxiliares de UI (`*Pagination`, `*ListResponse`, `*Stats`, payloads de formulario) pueden vivir en `domain/` pero en ficheros separados de la entidad principal.

## Diseño responsive — Mobile First

Toda la interfaz debe ser responsive. El diseño se construye primero para móvil y se adapta al escritorio con media queries o directivas de breakpoint de Angular Material.

- **Móvil**: los listados se muestran como **cards independientes**, una por elemento.
- **Escritorio**: los listados se muestran como **tabla** (`mat-table`).
- Usar `@if` con un breakpoint observer para alternar entre ambas vistas dentro del mismo componente.

## Convenciones de listados

### Paginación

- El tamaño de página por defecto es **50 elementos**.
- Las opciones de página disponibles son siempre: `[10, 25, 50, 100, 250, 500, 1000]`.

```typescript
readonly pageSizeOptions = [10, 25, 50, 100, 250, 500, 1000];
readonly defaultPageSize = 50;
```

### Columna de estado (primera columna)

La primera columna de toda tabla no tiene cabecera y representa el **estado y tipo** del objeto listado mediante un icono con color.

- El color se obtiene de un **pipe** que recibe el objeto y devuelve un string de color.
- El icono se obtiene de otro **pipe** independiente que recibe el objeto y devuelve el nombre del icono Material.
- El icono debe llevar un `matTooltip` que explique su significado al usuario.

```typescript
// Ejemplo de pipes
@Pipe({ name: 'productStatusColor', standalone: true })
export class ProductStatusColorPipe implements PipeTransform {
  transform(product: Product): string { ... }
}

@Pipe({ name: 'productStatusIcon', standalone: true })
export class ProductStatusIconPipe implements PipeTransform {
  transform(product: Product): string { ... }
}
```

```html
<!-- Primera columna sin cabecera -->
<ng-container matColumnDef="status">
  <th mat-header-cell *matHeaderCellDef></th>
  <td mat-cell *matCellDef="let row">
    <mat-icon
      [style.color]="row | productStatusColor"
      [matTooltip]="row | productStatusIcon | productStatusTooltip">
      {{ row | productStatusIcon }}
    </mat-icon>
  </td>
</ng-container>
```

### Columna de acciones (última columna)

La última columna contiene los **iconos de acción** que redirigen a las operaciones disponibles sobre el elemento.

- Cada icono debe llevar un `matTooltip` que describa la acción.
- Usar los iconos estándar definidos en `onna-design-system` (`visibility`, `edit`, `add`, `delete` con `action-btn-delete`).
- No mostrar texto, solo iconos.

```html
<ng-container matColumnDef="actions">
  <th mat-header-cell *matHeaderCellDef></th>
  <td mat-cell *matCellDef="let row">
    <button mat-icon-button [routerLink]="['/products', row.id]" matTooltip="Ver detalle">
      <mat-icon>visibility</mat-icon>
    </button>
    <button mat-icon-button [routerLink]="['/products', row.id]" matTooltip="Editar">
      <mat-icon>edit</mat-icon>
    </button>
    <button mat-icon-button (click)="onDelete(row)" matTooltip="Eliminar" class="action-btn-delete">
      <mat-icon>delete</mat-icon>
    </button>
  </td>
</ng-container>
```

## Estructura interna de componentes create/update

Aplica **solo** a componentes `*-create`/`*-update` (formulario de un único registro, Signal Forms, extendiendo `AppServiceSignalBase`). No aplica a listados (`*-getall`), vistas de detalle de solo lectura, diálogos, ni ningún otro tipo de componente — esos no siguen esta estructura de secciones.

Todo componente `*-create`/`*-update` organiza sus miembros de clase en el siguiente orden, cada bloque precedido por su comentario de sección. El objetivo es que cualquier componente de este tipo se lea igual, independientemente del dominio.

```typescript
export class ProductsUpdateComponent extends AppServiceSignalBase<...> {
  // #region DALs
  private productsUpdateDal = inject(ProductsUpdateDal);
  private categoriesGetAllDal = inject(CategoriesGetAllDal);
  // #endregion

  // #region Services
  private companyService = inject(CompanyService);
  // #endregion

  // #region Other members
  private dialog = inject(MatDialog);
  protected globalInfo = inject(GlobalInfoService);
  private emailDal = inject(EmailDal);
  // (router, route, snackBar ya vienen heredados de AppBase/AppServiceSignalBase — no
  // se redeclaran aquí salvo que el comportamiento por defecto no sirva, ver más abajo)
  // #endregion

  // #region Model
  isLoading = signal<boolean>(false);
  // #endregion

  // #region Forms
  protected override configureSchema(p: SchemaPathTree<ProductFormModel>): void {
    required(p.name, { message: 'El nombre es obligatorio' });
    ...
  }
  // #endregion

  // #region Related categories
  categories = signal<Category[]>([]);
  categoryOptions = computed<SelectorResult[]>(() =>
    this.categories().map((c) => ({ value: c.id, label: c.name })),
  );
  private loadCategories(): void {
    this.categoriesGetAllDal.getAll().subscribe({
      next: (data) => this.categories.set(data),
      error: () => this.showSnackBar('Error al cargar categorías', 'Cerrar'),
    });
  }
  // #endregion

  // #region Constructor / onInit / onDestroy
  constructor() {
    super(new ProductFormModel());
  }

  override ngOnInit(): void {
    super.ngOnInit();
    this.loadCategories();
  }
  // #endregion

  // #region Actions
  protected override onSave(): void { ... }
  protected override onCancel(): void { ... }
  onDeleteClick(): void { ... }
  // #endregion
}
```

Cada sección va envuelta en `// #region <Nombre>` / `// #endregion` (folding region nativo de VS Code, sin extensión ni equivalencia a JSDoc) para poder colapsarla en el editor — mismo comentario que hace de cabecera de sección, solo que ahora abre y cierra el bloque plegable.

Reglas del orden:

0. **Herencia obligatoria de `AppServiceSignalBase`** — todo componente `*-create`/`*-update` que use Signal Forms extiende `AppServiceSignalBase<TModel, T, TPayload>` (`frontend/src/app/common/infrastructure/app-service-signal-base.ts`), nunca reimplementa `model`/`fieldTree`/`onSave`/`load` desde cero. Si el flujo del componente no encaja 1:1 con el contrato genérico de la base (múltiples DAL de transición de estado, modo lectura/edición conmutable, `onSave` con lógica propia), se hereda igualmente solo para lo que sí encaja — como mínimo `model`/`fieldTree` vía `configureSchema()` — y el resto de métodos (`onSave`, `load`, etc.) se sobreescriben con `override` en vez de duplicarse fuera de la jerarquía. Ver `proposal-update.ts` como referencia de una herencia parcial bien resuelta (`model`/`fieldTree` heredados; `proposal`, `isLoading`, `isEditing`, `loadProposal()`, `onSave()` propios).
1. **DALs** — todas las inyecciones de clases `*Dal`, agrupadas primero.
2. **Services** — application services u otros servicios de dominio inyectados (`CompanyService`, `GlobalInfoService` si el componente lo trata como servicio de negocio, no como utilidad transversal).
3. **Other members** — el resto de inyecciones que no encajan arriba: `MatDialog` y cualquier referencia a diálogos, `GlobalInfoService` como utilidad transversal, `EmailDal`, `Injector`, etc. `router`, `route`, `snackBar`, `isMobile`, `onCancel` ya existen en `AppBase`/`AppServiceSignalBase`: no se re-inyectan ni redeclaran con el mismo nombre — se usan tal cual (`this.router`, `this.getId()`, `this.showSnackBar(...)`). Si el comportamiento heredado no encaja (breakpoint distinto, snackbar con opciones no soportadas), se resuelve extendiendo la base compartida, nunca duplicando el campo con otro nombre ad-hoc por componente.
4. **Model** — signals de estado propio del componente que no son el modelo de formulario ni un catálogo relacionado (`model`/`fieldTree` ya los aporta la base): flags (`isLoading`, `isEditing`), estado de UI propio de la pantalla.
5. **Forms** — `configureSchema()` (validadores del `SchemaPathTree`) y cualquier lógica de formulario adicional.
6. **Related `<nombre>`** — una subsección `#region`/`#endregion` por catálogo relacionado (`// #region Related clients`, `// #region Related products`, `// #region Related projects`...), cada una con TODO lo de ese catálogo junto: el signal fuente (`clients = signal<...>([])`), su(s) `computed` derivado(s) (`clientsList`, `clientOptions`, `productsOptions`/`servicesOptions` cuando derivan de un mismo signal, etc.) y su `load*()` privado — en ese orden, sin repartir el signal en «Model» y el resto en otra sección. Tantas subsecciones «Related» como catálogos tenga el componente.
7. **Constructor / onInit / onDestroy** — `super(...)` y suscripciones/`effect()` que deban existir desde la construcción, junto con el ciclo de vida Angular (`ngOnInit`/`ngOnDestroy`). Una única región: ambos bloques son inicialización del componente, solo que en momentos distintos del ciclo de vida.
8. **Actions** — `onSave`, `onCancel`, y cualquier acción disparada por botón del template (`onDeleteClick`, `onValidateClick`, etc.). `load()` (si se sobreescribe) y los helpers transversales sin acción propia asociada (`formatCurrency`, `formatDate`, `onBackToList`, `canManageProposal`) van sueltos, sin subregión. Cuando el componente tiene varias acciones de botón independientes (típico en `*-update` con workflow de estados: validar, aceptar, rechazar, convertir...), cada una se envuelve en su propia subsección `// #region Action <nombre>` que agrupa TODO lo de esa acción junto — el `xxxClick()` que abre el diálogo de confirmación, el `onXxx()` que hace la llamada al DAL, y cualquier `canXxx` que solo esa acción consulta — en vez de repartir click/handler/condición en puntos distintos del archivo. Si un `can*` condiciona más de una acción a la vez (p. ej. `canConvertProposal()` usado tanto por `createOrderClick` como por `createInvoiceClick`), vive en su propia subsección compartida (`// #region Action convertProposal`) en vez de duplicarse o adjuntarse arbitrariamente a una sola. Ver `proposal-update.ts` como referencia. En componentes sin ese patrón de múltiples acciones de workflow (p. ej. `*-create`, con un único flujo de guardado), no se fuerzan subregiones — la lista plana ya es clara.

## Nomenclatura

Regla general: **inglés y plural** en todo el código, salvo el dominio que es **inglés y singular**.

| Artefacto | Forma | Ejemplo |
|---|---|---|
| Carpeta de entidad | plural | `products/`, `invoices/` |
| Rutas URL | plural | `/products`, `/products/create` |
| Componentes | plural | `products-retrieve`, `products-create` |
| DALs | plural | `products.dal.ts` |
| Services | plural | `products.service.ts` |
| Application services | plural | `products-create.service.ts` |
| Interfaces de dominio | singular | `Product`, `Invoice` |
| Clases de dominio | singular | `Product`, `BomLine` |
| Enumeraciones | singular | `ProductStatus`, `InvoiceType` |
