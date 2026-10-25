# Delegation rules

| Disparador | Agente | Por qué |
|---|---|---|
| "¿Cómo funciona X?" | `explorer-domain` | Investiga sin implementar |
| "Quiero construir X" | `spec-author` | Escribe Spec Kit, no código |
| "Aprobado" tras `ai::spec-ready` | `implementer-frontend` + `implementer-backend` | Implementación paralela |
| Implementación terminada | `reviewer-architecture` + `reviewer-tests` | Validación independiente |
| Bug diagnosticado | `implementer-*` según el área | Reparación acotada |
| Bug reparado | `reviewer-tests` | Veredicto `VERIFIED` / `PARTIAL` / `FAILED` |

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
