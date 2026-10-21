# Agente Frontend: Reglas de Integración

## Skills disponibles

- `onna-architecture-common` — Contrato compartido FE ↔ BFF: dominio idéntico en ambos lados, reglas de campos, contrato de errores y comunicación.
- `onna-architecture-angular` — Arquitectura, estructura de carpetas, Signals, DAL, tipado.
- `onna-design-system` — Diseño visual, estructura de ventanas, formularios y listados.
- `angular-developer` — Guías oficiales Angular (signals, forms, routing, DI, testing).
- `angular-new-app` — Crear una nueva aplicación Angular.

## Iconos del menú lateral (sidebar)

Lucide icons usados en cada entrada de `layouts/sidebar/sidebar.html`:

| Sección | Entrada | Icono |
|---------|---------|-------|
| Área personal | Mis jornadas | `clock` |
| Compras | Proveedores | `truck` |
| Compras | Facturas de compra | `scroll-text` |
| Ventas | Clientes | `users` |
| Ventas | Presupuestos | `file-text` |
| Ventas | Pedidos | `shopping-cart` |
| Ventas | Facturas | `receipt` |
| Ventas | Factura electrónica | `receipt-text` |
| Gestión Comercial | Productos | `package` |
| Gestión Comercial | Servicios | `bell-ring` |
| Gestión Comercial | Almacenes | `warehouse` |
| Gestión Comercial | Bancos | `landmark` |
| Proyectos | Proyectos | `chart-no-axes-gantt` |
| Proyectos | Listas de materiales | `list` |
| Recursos Humanos | Empleados | `users` |
| Recursos Humanos | Jornadas | `calendar` |
| Recursos Humanos | Fichajes modificados | `file-pen` |
| Recursos Humanos | Resumen semanal | `calendar-range` |

## Capa `application/` (convención workdays / Products)

- **Services delgados** — solo orquestación DAL + feedback UI (`WorkdaysEditService`, `WorkdaysExportService`).
- **Lógica pura** en archivos dedicados: `*.mapper.ts`, `*.validator.ts`, `*.formatter.ts`, `*.config.ts`, `*.datetime.ts`.
- **Tipos de comando/DTO** en `domain/`, nunca en services ni componentes.
- **Tests unitarios** en la lógica pura (sin `TestBed` cuando sea posible).

## Paridad de `domain/` con el backend (productos y servicios)

Los `domain/` de `products` y `services` son espejo del backend: mismos objetos, mismos campos y mismos metadatos `@Field`. La única excepción permitida son tipos de soporte de UI sin equivalente en el backend. En `products/domain/` son:

- `enums/productsStockAdjustOrigin.ts`
- `productsCreateModel.ts`
- `productsStockAdjustFormModel.ts`
- `productsStockAdjustSignedQty.ts`
- `productsStockTransferFormModel.ts`

`ProductType` y `PriceBaseType` viven en `common/domain/Enumerations/` (frontend y backend) y ningún módulo importa del otro (`products` y `services` son independientes).
