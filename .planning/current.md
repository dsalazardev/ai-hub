# Estado de la sesión — hermes-control CERRADO (2026-11-09)

**Change:** `hermes-control` (taller) — **39/39 tareas**, detalle en `.planning/impl_hermes-control.md` § "CIERRE FINAL".

| Fase | Tareas | Cierre |
|---|---|---|
| 1 — tick + notificación Discord | 10/10 | suite 37 archivos, 508 pasados, 1 omitido |
| 2 — webhook GitLab → Discord | 5/5 | suite 37, 511, 1 |
| 3 — aprobaciones y etiquetas | 9/9 | suite 38, 531, 1 |
| 4 — notas de evidencia y enroll | 9/9 | suite 39 verdes + fase 5 en rojo por diseño (desviación 15) |
| 5 — endurecimiento | 6/6 | suite final 40/40, 555 pasados, 1 omitido (symlinks), 808 s |

- Tarball: 1981 entradas (+25 frente a 0.11.0). `validate --strict` válido. Doctor del taller sano.
- Pendiente del propietario: entrega real a Discord, webhook alcanzable (VPS o túnel), `hermes cron run` en vivo,
  revisión y archivado del change. Sin git ni publicación en esta sesión.
- Fuera del change (`findings.md`): falso positivo del filtro de secretos de `runs`; Spec Kit 1.3.x fuera de rango.
