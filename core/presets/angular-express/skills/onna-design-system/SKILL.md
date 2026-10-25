---
name: onna-design-system
description: Define el diseño visual, estructura y comportamiento de formularios, listados y ventanas en la aplicación Onna/Doligestion. Activa este skill cuando se creen o modifiquen componentes de UI, formularios, listados o tablas.
license: MIT
---

# Onna Design Guidelines

Referencia canónica de implementación: `products-create`, `products-update`, `products-getall`.

## Principios generales

- Cada caso de uso tiene su propio componente: `create` y `update` son siempre componentes separados.
- La ventana `ver` y `update` son la misma: se entra con el formulario deshabilitado (`form.disable()`). Un botón "Modificar" llama a `form.enable()`.
- Iconos de recursos: Lucide Icons via `@lucide/angular` (no Material Icons para iconos de estado/tipo).
- Nombres de recursos en **inglés y plural** en rutas y componentes. Texto visible al usuario en **español**.
- Todos los componentes son `standalone: true`. Prohibido NgModules.
- Inyección exclusivamente con `inject()` a nivel de clase. Prohibido parámetros de constructor para inyección.

## Clases base de componentes

Los componentes extienden clases base que proveen formulario, DAL, routing y snackbar:

```typescript
// Listado / consultas
export class ProductsGetAllComponent extends AppQueryBase<ProductsGetAllDto, QueryResult<Product>>

// Crear / Editar (un solo DAL)
export class ProductsCreateComponent extends AppServiceBase<ProductsCreateDto, Product>
export class ProductsUpdateComponent extends AppServiceBase<ProductsUpdateDto, Product>
```

### AppQueryBase — para listados

```typescript
// Proporciona:
// - form: FormGroup generado automáticamente desde el DTO
// - controls: acceso tipado a los controles del form
// - messageError: signal<string | null>
// - dal: QueryBackendDal (asignar en constructor)
// - navigate(), navigateBack(), showSnackBar(), isMobile()

export class ProductsGetAllComponent extends AppQueryBase<ProductsGetAllDto, QueryResult<Product>> {
  protected readonly globalInfo = inject(GlobalInfoService);
  protected readonly ProductStatus = ProductStatus;
  private productsGetAllDal = inject(ProductsGetAllDal);

  protected readonly canCreate = computed(() => !!this.globalInfo.right().products?.canCreateProducts);
  protected readonly canEdit   = computed(() => !!this.globalInfo.right().products?.canCreateProducts);
  protected readonly canDelete = computed(() => !!this.globalInfo.right().products?.canDeleteProducts);

  protected items = signal<Product[]>([]);
  protected readonly displayedColumns: string[] = ['status', 'ref', 'label', 'costPrice', 'price', 'actions'];
  protected readonly selectedId = signal<number | null>(null);
  protected request = signal<ProductsGetAllDto>(new ProductsGetAllDto({
    page_count: 0, total: 0,
    fields: 'id,status,ref,label,toSell,price,toBuy,costPrice',
    status: ProductStatus.Active,
    filterBy: ''
  }));
  protected readonly statusCounts = signal<Partial<Record<ProductStatus, number>>>({});
  private readonly dialog = inject(MatDialog);
  protected readonly statusSelected = computed(() => this.request().status);

  constructor() {
    super(ProductsGetAllDto);
    this.dal = this.productsGetAllDal;
  }

  override ngOnInit(): void {
    super.ngOnInit();
    this.load();
  }

  protected load(): void {
    this.messageError.set(null);
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }

    const dto = this.form.getRawValue() as ProductsGetAllDto;
    this.productsGetAllDal.run(dto).subscribe({
      next: (response) => {
        this.items.set(response.data);
        this.request.update(item => ({ ...item, ...response.pagination }));

        // Calcular conteos por status con RxJS
        from(response.data).pipe(
          groupBy(p => p.status),
          mergeMap(group => group.pipe(
            reduce((count) => count + 1, 0),
            mergeMap(count => [{ status: group.key, count }])
          )),
          toArray()
        ).subscribe(groups => {
          const counts: Partial<Record<ProductStatus, number>> = {};
          groups.forEach(({ status, count }) => { if (status !== undefined) counts[status] = count; });
          this.statusCounts.set(counts);
        });
      },
      error: () => this.showSnackBar('Error al cargar productos', 'Cerrar')
    });
  }

  protected setStatus(status?: number): void {
    this.request.update(item => ({ ...item, status, page: 0 }));
    this.load();
  }
}
```

### AppServiceBase — para crear/editar

```typescript
// Proporciona:
// - form: FormGroup generado desde el DTO con @Field
// - controls: acceso tipado
// - dal: ServiceBackendDal (asignar en constructor)
// - loadDal: QueryBackendDal (asignar en constructor para update; load() lo usa en ngOnInit)
// - load(): carga el item por id desde la URL y hace patchValue en el form
// - onSave(): valida y envía via dal.run()
// - onCancel(): navega atrás

// Create — sin loadDal
export class ProductsCreateComponent extends AppServiceBase<ProductsCreateDto, Product> {
  private productsCreateDal = inject(ProductsCreateDal);

  constructor() {
    super(ProductsCreateDto);
    this.dal = this.productsCreateDal;
  }
}

// Update — con loadDal para cargar el item
export class ProductsUpdateComponent extends AppServiceBase<ProductsUpdateDto, Product> {
  private readonly productsUpdateDal  = inject(ProductsUpdateDal);
  private readonly productsGetByIdDal = inject(ProductsGetByIdDal);

  constructor() {
    super(ProductsUpdateDto);
    this.dal     = this.productsUpdateDal;
    this.loadDal = this.productsGetByIdDal;
  }

  override ngOnInit(): void {
    this.form.disable({ emitEvent: false }); // entra en modo solo lectura
    super.ngOnInit(); // llama a load()
  }
}
```

## Formularios — template HTML canónico

Layout con Tailwind + Angular Material. Sin CSS propio para grids (usar clases de Tailwind y los componentes compartidos).

### Estructura de ventana create

```html
<section>
  <form [formGroup]="form" (submit)="onSave()">
    <div class="flex flex-col gap-4">

      <!-- CABECERA -->
      <card-header [icon]="undefined | productStatusIcon" title="Crear producto"
        subtitle="Completa los datos para crear un producto." />

      <!-- SECCIÓN: mat-card + card-section + form-field-* -->
      <mat-card>
        <mat-card-header>
          <card-section icon="info" title="Información básica" />
        </mat-card-header>
        <mat-card-content>
          <div class="flex flex-col gap-4">
            <form-field-text [control]="controls['ref']" />
            <form-field-text [control]="controls['label']" />
            <form-field-area [control]="controls['description']" />
            <form-field-enum [control]="controls['priceBaseType']" [options]="priceBaseOptions" />
          </div>
        </mat-card-content>
      </mat-card>

      <!-- SECCIONES EN COLUMNAS (ej. Ventas / Compras) -->
      <div class="flex w-full gap-4">
        <mat-card>
          <mat-card-header><card-section icon="shopping-cart" title="Ventas" /></mat-card-header>
          <mat-card-content>
            <div class="flex flex-col w-full gap-4">
              <form-field-boolean [control]="controls['toSell']" />
              <form-field-euro [control]="controls['price']" />
            </div>
          </mat-card-content>
        </mat-card>
        <mat-card>
          <mat-card-header><card-section icon="store" title="Compras" /></mat-card-header>
          <mat-card-content>
            <div class="flex flex-col w-full gap-4">
              <form-field-boolean [control]="controls['toBuy']" />
              <form-field-euro [control]="controls['costPrice']" />
            </div>
          </mat-card-content>
        </mat-card>
      </div>

      <!-- ERROR GENERAL -->
      @if (messageError(); as message) {
        <mat-card>
          <mat-card-header><card-section icon="x" title="Error" /></mat-card-header>
          <mat-card-content><span>{{ message }}</span></mat-card-content>
        </mat-card>
      }

      <!-- ACCIONES -->
      <div class="flex w-full gap-4 justify-end items-center">
        <form-button (onClick)="onCancel()" />
        <form-submit />
      </div>

    </div>
  </form>
</section>
```

### Diferencias en update (modo ver/editar)

```html
<!-- Cabecera condicional + botón Modificar -->
<div class="flex w-full justify-between">
  @if (form.disabled) {
    <card-header [icon]="..." title="Ver producto" subtitle="Visualiza el producto..." />
  } @else {
    <card-header [icon]="..." title="Modificar producto" subtitle="Completa los datos..." />
  }
  <div class="flex items-center">
    @if (form.disabled && canEdit()) {
      <div class="flex gap-4">
        <form-button-principal (click)="form.enable()" label="Modificar" icon="pencil" />
      </div>
    }
  </div>
</div>

<!-- Botón Guardar deshabilitado si el form está deshabilitado o inválido -->
<form-submit [disabled]="form.disabled || form.invalid" />
```

## Componentes de campo del formulario

Todos leen `label`, `required` y `placeholder` desde el `AppFormField` (que los lleva desde `@Field`). No repetir el label en el template.

| Componente | Uso | Input |
|------------|-----|-------|
| `form-field-text` | Campo texto de una línea (admite `type`, `prefixIcon`, `placeholder`) | `[control]` o `[field]` |
| `form-field-area` | Textarea (descripción, notas; admite `rows`, `placeholder`, `hintAlign`) | `[control]` o `[field]` |
| `form-field-number` | Número genérico | `[control]` o `[field]` |
| `form-field-euro` | Número con símbolo € | `[control]` o `[field]` |
| `form-field-percent` | Número con símbolo % | `[control]` o `[field]` |
| `form-field-date` | Fecha (valor texto ISO de solo fecha; admite `dateFilter`, `minDate`, `maxDate`) | `[control]` o `[field]` |
| `form-field-date-period` | Rango de fechas (desde/hasta) | `[startControl]` + `[endControl]` |
| `form-field-time` | Hora | `[control]` o `[field]` |
| `form-field-boolean` | Toggle/switch (admite `(valueChange)`, `disabled`, `compact`) | `[control]` o `[field]` |
| `form-field-password` | Contraseña | `[control]` o `[field]` |
| `form-field-enum` | Desplegable con autocompletado | `[control]` + `[options]` |
| `form-field-enum-select` | Desplegable simple (`mat-select`); admite también `[value]` + `(selectionChange)` | `[control]` + `[options]` |
| `form-field-enum-multiple` | Selección múltiple | `[control]` + `[options]` |
| `form-button` | Botón acción secundaria (Cancelar) | `(onClick)` + `label` + `icon` |
| `form-button-principal` | Botón acción principal (Modificar, azul) | `(click)` + `label` + `icon` |
| `form-submit` | Botón submit del formulario | `[disabled]` |
| `card-header` | Cabecera de ventana con icono + título + subtítulo | `[icon]` + `title` + `subtitle` |
| `card-section` | Título de sección dentro de mat-card-header | `icon` + `title` |

Los `[options]` de `form-field-enum` se obtienen del Pipe del enum con `.selector()`:

```typescript
readonly productPriceBaseTypeLabel = inject(ProductPriceBaseTypeLabelPipe);
readonly priceBaseOptions = this.productPriceBaseTypeLabel.selector();
```

## Listado — template canónico

```html
<div class="page-container">
  <!-- KPIs de estado (filtros rápidos) -->
  <div class="kpi-grid kpi-grid--cols-3">
    <kpi-card [value]="items().length" [total]="request().total" [icon]="undefined | productStatusIcon"
      [label]="undefined | productStatusLabel" [color]="undefined | productStatusColor"
      [isSelected]="request().status === undefined" (selected)="setStatus(undefined)" />
    <kpi-card [value]="statusCounts()[ProductStatus.Active] || 0" [icon]="ProductStatus.Active | productStatusIcon"
      [label]="ProductStatus.Active | productStatusLabel" [color]="ProductStatus.Active | productStatusColor"
      [isSelected]="request().status === ProductStatus.Active" (selected)="setStatus(ProductStatus.Active)" />
    <kpi-card [value]="statusCounts()[ProductStatus.Inactive] || 0" [icon]="ProductStatus.Inactive | productStatusIcon"
      [label]="ProductStatus.Inactive | productStatusLabel" [color]="ProductStatus.Inactive | productStatusColor"
      [isSelected]="request().status === ProductStatus.Inactive" (selected)="setStatus(ProductStatus.Inactive)" />
  </div>

  <section>
    <form [formGroup]="form" (submit)="load()">
      <div class="flex flex-col gap-4">

        <!-- CABECERA responsive -->
        @if (globalInfo.isMobile() || globalInfo.isTablet()) {
          <div class="flex flex-col gap-4">
            <div class="flex w-full justify-between items-center">
              <card-header [icon]="..." title="Productos" subtitle="Gestiona y administra los productos." />
              <div class="flex items-center gap-4">
                @if (canCreate()) { <form-button icon="plus" label="Crear" [routerLink]="['/products', 'create']" /> }
                <form-submit icon="search" label="Buscar" />
              </div>
            </div>
            <form-field-text [control]="controls['filterBy']" />
          </div>
        } @else {
          <div class="flex w-full justify-between items-center">
            <card-header [icon]="..." title="Productos" subtitle="Gestiona y administra los productos." />
            <div class="flex items-center gap-4">
              <form-field-text [control]="controls['filterBy']" />
              @if (canCreate()) { <form-button icon="plus" label="Crear" [routerLink]="['/products', 'create']" /> }
              <form-submit icon="search" label="Buscar" />
            </div>
          </div>
        }

        <!-- ESTADO VACÍO -->
        @if (items().length === 0) {
          <mat-card>
            <mat-card-content>
              <card-empty [icon]="..." title="No hay productos" subtitle="Ajusta los filtros o crea uno nuevo." />
            </mat-card-content>
          </mat-card>

        <!-- MOBILE: tarjetas expandibles -->
        } @else if (isMobile()) {
          @for (item of items(); track item.id) {
            <mat-card (click)="selectedId() ? selectedId.set(null) : selectedId.set(item.id)">
              <mat-card-header>
                <div class="flex w-full justify-between items-center size-4">
                  <div class="flex gap-4">
                    <svg [lucideIcon]="item.status | productStatusIcon"
                         [style.color]="item.status | productStatusColor"
                         [matTooltip]="item.status | productStatusLabel"></svg>
                    <span class="font-semibold text-slate-800 truncate">{{ item.ref }} - {{ item.label }}</span>
                  </div>
                  <svg lucideChevronDown></svg>
                </div>
              </mat-card-header>
              @if (selectedId() === item.id) {
                <mat-card-content><!-- datos expandidos --></mat-card-content>
                <mat-card-actions>
                  <div class="flex justify-end w-full gap-4" (click)="$event.stopPropagation()">
                    <form-button icon="eye" label="Ver" [routerLink]="['/products', item.id]" />
                    @if (canEdit()) { <form-button icon="euro" label="Precio" (click)="changePriceProduct(item)" /> }
                    @if (canDelete()) { <form-button icon="trash-2" label="Eliminar" class="text-red-500!" (click)="deleteProduct(item)" /> }
                  </div>
                </mat-card-actions>
              }
            </mat-card>
          }

        <!-- DESKTOP: mat-table -->
        } @else {
          <mat-card>
            <mat-card-content>
              <table mat-table [dataSource]="items()">
                <ng-container matColumnDef="status">
                  <th mat-header-cell *matHeaderCellDef class="col-icon1" aria-label="Estado"></th>
                  <td mat-cell *matCellDef="let item" class="col-icon1">
                    <col-icon [icon]="item.status | productStatusIcon"
                               [color]="item.status | productStatusColor"
                               [tooltip]="item.status | productStatusLabel" />
                  </td>
                </ng-container>
                <ng-container matColumnDef="ref">
                  <th mat-header-cell *matHeaderCellDef>Referencia</th>
                  <td mat-cell *matCellDef="let item"><col-text [text]="item.ref || '—'" /></td>
                </ng-container>
                <ng-container matColumnDef="label">
                  <th mat-header-cell *matHeaderCellDef>Nombre</th>
                  <td mat-cell *matCellDef="let item"><col-text [text]="item.label || '—'" /></td>
                </ng-container>
                <ng-container matColumnDef="costPrice">
                  <th mat-header-cell *matHeaderCellDef>P. compra</th>
                  <td mat-cell *matCellDef="let item">
                    @if (!item.toBuy || item.costPrice === undefined) { <col-empty /> }
                    @else { <col-currency [value]="item.costPrice" /> }
                  </td>
                </ng-container>
                <ng-container matColumnDef="price">
                  <th mat-header-cell *matHeaderCellDef>P. venta</th>
                  <td mat-cell *matCellDef="let item">
                    @if (!item.toSell && item.price != null) { <col-empty /> }
                    @else { <col-currency [value]="item.price" /> }
                  </td>
                </ng-container>
                <ng-container matColumnDef="actions">
                  <th mat-header-cell *matHeaderCellDef class="col-icon3" aria-label="Acciones"></th>
                  <td mat-cell *matCellDef="let item" class="col-icon3">
                    <col-button icon="eye" tooltip="Ver detalle" [routerLink]="['/products', item.id]" />
                    @if (canEdit()) { <col-button icon="euro" tooltip="Cambiar precio" (click)="changePriceProduct(item)" /> }
                    @if (canDelete()) { <col-button icon="trash-2" color="#ef4444" tooltip="Eliminar" (click)="deleteProduct(item)" /> }
                  </td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: displayedColumns"
                    class="transition-colors hover:bg-slate-50/50"></tr>
              </table>
            </mat-card-content>
          </mat-card>
        }

      </div>
    </form>
  </section>
</div>
```

## Componentes de columna de tabla (desktop)

| Componente | Uso | Inputs |
|------------|-----|--------|
| `col-icon` | Icono de estado con color y tooltip | `[icon]` `[color]` `[tooltip]` |
| `col-text` | Texto simple truncado | `[text]` |
| `col-currency` | Número formateado como moneda EUR | `[value]` |
| `col-empty` | Celda vacía (—) cuando el valor no aplica | — |
| `col-button` | Botón de acción ghost con icono Lucide | `icon` `tooltip` `[routerLink]` / `(click)` / `color` |

Ancho de columna de iconos:
- `col-icon1`: primera columna de estado (estrecha)
- `col-icon3`: última columna de acciones (3 botones)

## Pipes de estado/tipo

Patrón estándar: un pipe por cada transformación visual de un enum. Siempre `standalone: true`.

```typescript
// Label (texto)
@Pipe({ name: 'productStatusLabel', standalone: true })
export class ProductStatusLabelPipe implements PipeTransform {
  transform(status?: ProductStatus): string {
    if (status === ProductStatus.Active) return 'Activo';
    if (status === ProductStatus.Inactive) return 'Inactivo';
    return 'Total'; // undefined → total / todos
  }
  selector(): { value: ProductStatus; label: string }[] {
    return [
      { value: ProductStatus.Active, label: this.transform(ProductStatus.Active) },
      { value: ProductStatus.Inactive, label: this.transform(ProductStatus.Inactive) }
    ];
  }
}

// Color (hex)
@Pipe({ name: 'productStatusColor', standalone: true })
export class ProductStatusColorPipe implements PipeTransform {
  transform(status?: ProductStatus): string {
    if (status === ProductStatus.Active) return '#10b981';   // verde
    if (status === ProductStatus.Inactive) return '#ef4444'; // rojo
    return '#94a3b8'; // gris (todos)
  }
}

// Icono (nombre Lucide)
@Pipe({ name: 'productStatusIcon', standalone: true })
export class ProductStatusIconPipe implements PipeTransform {
  transform(status?: ProductStatus): string {
    if (status === ProductStatus.Active) return LucideCircleCheck.icon.name;
    if (status === ProductStatus.Inactive) return LucideX.icon.name;
    return LucideTag.icon.name;
  }
}
```

Uso en template:
```html
<svg [lucideIcon]="item.status | productStatusIcon"
     [style.color]="item.status | productStatusColor"
     [matTooltip]="item.status | productStatusLabel"></svg>
```

## Pipes de tipo de precio (patrón con selector())

Los pipes de enums que se usan en `form-field-enum` implementan `.selector()`:

```typescript
@Pipe({ name: 'productPriceBaseTypeLabel', standalone: true })
export class ProductPriceBaseTypeLabelPipe implements PipeTransform {
  transform(type?: ProductPriceBaseType): string {
    if (type === ProductPriceBaseType.ConIVA) return 'Con IVA';
    if (type === ProductPriceBaseType.SinIVA) return 'Sin IVA';
    return 'Desconocido';
  }
  selector(): { value: ProductPriceBaseType; label: string }[] {
    return [
      { value: ProductPriceBaseType.ConIVA, label: this.transform(ProductPriceBaseType.ConIVA) },
      { value: ProductPriceBaseType.SinIVA, label: this.transform(ProductPriceBaseType.SinIVA) }
    ];
  }
}
```

En el componente (declarar en `providers` + inyectar):
```typescript
providers: [ProductPriceBaseTypeLabelPipe],
// ...
readonly productPriceBaseTypeLabel = inject(ProductPriceBaseTypeLabelPipe);
readonly priceBaseOptions = this.productPriceBaseTypeLabel.selector();
```

## DAL del frontend (backend/)

```typescript
// GetAll
@Injectable({ providedIn: 'root' })
export class ProductsGetAllDal extends QueryBackendDal<ProductsGetAllDto, QueryResult<Product>> {
  private api = inject(ApiDalService);
  private basePath = 'products';

  run(request: ProductsGetAllDto): Observable<QueryResult<Product>> {
    return this.api.queryList<QueryResult<Product>>(this.basePath, request);
  }
}

// GetById
@Injectable({ providedIn: 'root' })
export class ProductsGetByIdDal extends QueryBackendDal<ProductsGetByIdDto, QueryItemResult<Product>> {
  private api = inject(ApiDalService);
  private basePath = 'products';

  run(request: ProductsGetByIdDto): Observable<QueryItemResult<Product>> {
    return this.api.queryItem<QueryItemResult<Product>>(this.basePath, request);
  }
}

// Create
@Injectable({ providedIn: 'root' })
export class ProductsCreateDal extends ServiceBackendDal<Product, Product> {
  private api = inject(ApiDalService);
  private basePath = 'products';

  run(request: Product): Observable<Product> {
    return this.api.post<Product>(this.basePath, request);
  }
}

// Update
@Injectable({ providedIn: 'root' })
export class ProductsUpdateDal extends ServiceBackendDal<Product, Product> {
  private api = inject(ApiDalService);
  private basePath = 'products';

  run(request: Product): Observable<Product> {
    return this.api.put<Product>(this.basePath, request.id, request);
  }
}
```

`ApiDalService` expone: `queryList`, `queryItem`, `post`, `put`, `delete`, `get`, `patch`. No usar `create` ni `read` (deprecated).

## Seguridad y permisos

Los permisos se obtienen con `GlobalInfoService` como computeds:

```typescript
protected readonly globalInfo = inject(GlobalInfoService);
protected readonly canCreate = computed(() => !!this.globalInfo.right().products?.canCreateProducts);
protected readonly canEdit   = computed(() => !!this.globalInfo.right().products?.canCreateProducts);
protected readonly canDelete = computed(() => !!this.globalInfo.right().products?.canDeleteProducts);
```

En el template, envolver con `@if (canCreate())` / `@if (canEdit())` / `@if (canDelete())`.

## Diálogos (Angular Material Dialog)

Para operaciones que necesitan confirmación o datos extra:

```typescript
// Abrir diálogo de confirmación
protected deleteProduct(product: Product): void {
  this.dialog.open(ConfirmDialogComponent, {
    width: '450px',
    data: { title: 'Eliminar Producto', message: `¿Eliminar ${product.label}? Esta acción no se puede deshacer.` }
  }).afterClosed().subscribe((confirmed: boolean) => {
    if (!confirmed) return;
    // ejecutar delete DAL
  });
}

// Abrir diálogo con datos
protected changePriceProduct(product: Product): void {
  this.dialog.open(ProductUpdatePriceDialogComponent, { data: product })
    .afterClosed().subscribe(() => this.load());
}
```

## Reglas de nomenclatura

| Artefacto | Idioma | Forma | Ejemplo |
|-----------|--------|-------|---------|
| Rutas URL, carpetas | Inglés | Plural | `/products`, `products/` |
| Selector de componente | Inglés | Plural kebab | `products-getall`, `app-products-update` |
| Interfaces de dominio | Inglés | Singular PascalCase | `Product`, `ProductStatus` |
| DAL de frontend | Inglés | Plural + operación | `ProductsGetAllDal`, `ProductsCreateDal` |
| Pipes | Inglés | camelCase | `productStatusLabel`, `productStatusColor` |
| Texto visible al usuario | Español | — | `Crear`, `Guardar`, `Cancelar`, `Modificar` |
| Iconos de acción | Lucide | — | `eye`, `pencil`, `trash-2`, `plus`, `euro` |

## Convenciones de rutas

| Acción | Ruta |
|--------|------|
| Listado | `/products` |
| Crear | `/products/create` |
| Ver/Editar | `/products/:id` |

## Verificación obligatoria tras cambios

```bash
cd frontend && ng build
```
