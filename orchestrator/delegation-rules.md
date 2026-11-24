# Delegation rules

Por defecto el orquestador trabaja **inline**. Solo delega con una razón con nombre de `core/engine/engine.yaml` › `delegation` (fuente normativa; la regla `ai-hub-speckit` la proyecta con sus umbrales de partida). El número de archivos, el tamaño de la tarea o el precio del modelo no deciden por sí solos, y delegar no añade estados ni cambia `exit_effects`. El rol delegado cierra con `| delegated=<razón>` antes de `reason`.

| Razón | Cuándo |
|---|---|
| `exploration` | entender requiere más de un lote inline (referencia: unas 3 llamadas o 10k tokens) o más de unas 5 búsquedas secuenciales; explorador de solo lectura con mapa `path:line` |
| `parallel_writers` | dos o más unidades de comportamiento independientes con superficies de edición disjuntas, cada una de varios minutos |
| `context_backup` | una sesión larga entrega su siguiente unidad acotada a un trabajador nuevo (el arnés no mide el contexto) |
| `independent_verifier` | cambio de alto riesgo (datos, seguridad, contratos compartidos, concurrencia, entrega) sin una prueba que atrape la regresión |

Umbrales de la issue #7, como referencia que debe re-medirse con el modelo y el host; no son mediciones del arnés.

| Disparador | Agente | Razón |
|---|---|---|
| "¿Cómo funciona X?" | `explorer-domain` | `exploration` (si no se cumple, inline) |
| "Quiero construir X" | `spec-author` | inline salvo `context_backup` |
| "Aprobado" tras `ai::spec-ready` | `implementer-frontend` + `implementer-backend` | `parallel_writers` |
| Implementación terminada | `reviewer-architecture` + `reviewer-tests` | revisión obligatoria del flujo (puerta, no delegación por tamaño); `independent_verifier` si además es de alto riesgo sin prueba que atrape la regresión |
| Bug diagnosticado | `implementer-*` según el área | inline salvo `parallel_writers` |
| Bug reparado | `reviewer-tests` | revisión obligatoria del flujo (veredicto `VERIFIED` / `PARTIAL` / `FAILED`); `independent_verifier` con el mismo criterio de riesgo |

El verificador independiente recibe un contexto nuevo y la evidencia del candidato, nunca la defensa del autor; usa un modelo distinto del de autoría cuando `manifest.agentModels` lo permite y, con un solo modelo, anota la diversidad reducida. Si el riesgo exige diversidad que no hay, cierra `BLOCKED` con `reason=diversity_unavailable` y escala a una persona.

## Paralelismo

- Frontend y backend: en paralelo si el plan no impone dependencia.
- Reviewers: siempre en paralelo.
- Secuencial si el backend introduce un contrato que el frontend consume.

## Reglas

1. El orquestador no escribe código.
2. Un reviewer no modifica código ni tests.
3. Un implementer no cruza la frontera frontend/backend.
4. Los agentes no se comunican por chat; escriben en `.planning/`.
5. Máximo 3 reintentos por implementer antes de escalar.
6. Verificación obligatoria: comando del preset para build, typecheck y test.
7. `doctor` y `drift` deben estar en verde antes de delegar.

## Scopes

Los scopes concretos salen de `manifest.yaml` (`paths.source`, `paths.tests`) y del preset. Un agente que necesita escribir fuera de su scope debe detenerse y pedir una actualización de la spec.
