# Fichajes → workdays + punches — Índice rápido

> **No duplicar este archivo.** La fuente operativa es [`.planning/fichajes-migration-master-plan.md`](../../.planning/fichajes-migration-master-plan.md).
>
> **Estado**: planning completado — sin `/speckit.implement` hasta aprobación humana.

---

## Lectura obligatoria del agente

1. [`.planning/fichajes-migration-master-plan.md`](../../.planning/fichajes-migration-master-plan.md) — decisiones, nombres, permisos, 9 changes, riesgos
2. [`.planning/handoff_fichajes-migration.md`](../../.planning/handoff_fichajes-migration.md) — estado del programa
3. Guías G2 (track fichajes, autocontenidas): `guia-migracion-monorepo2.md`, `backend/guia-migracion-backend2.md`, `frontend/guia-migracion-frontend2.md`
4. Plantilla código: [products-module-blueprint.md](./products-module-blueprint.md)

---

## Decisiones cerradas (resumen)

| Tema | Decisión |
|------|----------|
| Módulos | `workdays/` + `punches/`; eliminar `fichajes/` al final |
| BFF | Corte duro `/api/workdays`, `/api/punches` |
| Config (P5) | `PunchesConfig`, `PunchesConfigParam`, `PunchesConfigFlag` |
| Permisos (P6) | `RightFichaje` en users; policies en common; **misma lógica que legacy** |
| users-list (P3) | Facade hasta change 4; refactor KPIs en change 9 |
| IDs dominio | `id: number` siempre (D21) |
| `PunchType` | Un solo enum; manual incluido (D22); eliminar `RegistroManualAccionTipo` |
| Entidad fichaje | `Punch` en inglés (D23) |
| Auditoría modificados | `workdays/domain/` (D24) |
| Paginación workdays | Igual que products / `QueryListDto` (D27) |
| `punch-card` | Permanece en `common/` (D28) |
| Enriquecimiento pausas | Helper `application/` + batch eventos (D25); no DAL `EnrichBreaks` |
| Filtro empleados | Criterio employees users (D26); refactor `entityUsersScope` |
| Export | Motor `common/`; helper `WorkdaysService` (patrón actual) |

---

## Clasificación

| Aspecto | Valor |
|---------|-------|
| Perfil | **Híbrido** — workdays listado tipo products; punches acciones + service layer |
| Referencia listado | `products-getall` + `users-list` (employees) |
| Primer change | `migrate-workdays-getall` (opcional previo: `fix-app-query-base-products-strings`) |

---

## Enlaces legacy (solo exploración)

| Qué | Dónde |
|-----|-------|
| Routes BFF | `backend/routes/fichajes.ts`, `backend/routes/jornadas.ts` |
| FE monolito | `frontend/src/app/fichajes/` |
| Permisos dominio | `backend/src/users/domain/rightFichaje.ts` |

Detalle de endpoints, mapa ES→EN, DALs objetivo y complicaciones: **solo en el planning maestro**.
