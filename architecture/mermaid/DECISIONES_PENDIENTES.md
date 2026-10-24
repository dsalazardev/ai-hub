# Decisiones pendientes - AI Hub 3.0

## Decisiones ya establecidas

Estas decisiones se toman como base del modelado y no se reabren en los diagramas:

1. GitLab es la fuente de verdad para issues, comentarios, labels y Merge Requests.
2. Hermes es el plano de control y la orquestacion.
3. Claude Code es el motor principal de ejecucion tecnica aislada.
4. OpenSpec formaliza propuestas, decisiones, requisitos, tareas y criterios de aceptacion.
5. El sistema se divide en cinco planos: control, ejecucion, conocimiento, integracion y gobernanza.
6. Los estados de issue, job/run y Merge Request son distintos y no se mezclan.
7. Las aprobaciones humanas son obligatorias en los puntos definidos por la politica.
8. Los roles tienen privilegios separados: quien implementa no aprueba su propio trabajo.

## Registro de decisiones abiertas

| ID | Cuestion | Fuente | Diagramas afectados | Alternativas | Impacto | Estado |
|---|---|---|---|---|---|---|
| D-01 | Infraestructura de ejecucion: Docker o Kubernetes. | Documento de arquitectura, seccion de despliegue. | 02, 12 | Docker Compose en un host; Kubernetes con namespaces por job; runner gestionado. | Define aislamiento, coste, escalado y complejidad operativa. | Pendiente |
| D-02 | Nivel de autonomia objetivo. | Documento de arquitectura, seccion de autonomia. | 04, 17 | A3 con merge humano; A4 con auto-merge para bajo riesgo; A5 solo para R0. | Cambia las puertas humanas y el riesgo aceptado. | Pendiente |
| D-03 | Modelo o modelos usados y separacion del reviewer. | Documento de arquitectura, seccion de ejecucion. | 01, 03, 11 | Solo Claude Code; Claude para implementar y otro modelo para revisar; proveedor unico con contexto limpio. | Afecta independencia de revision, coste y calidad. | Pendiente |
| D-04 | Origen de datos de los preview environments. | Documento de arquitectura, seccion de preview. | 12, 19 | Datos sinteticos; copia anonimizada; datos reales solo en staging. | Afecta privacidad, realismo de la validacion y coste. | Pendiente |
| D-05 | Politica de auto-merge. | Documento de arquitectura, seccion de merge. | 10, 17, 18 | Sin auto-merge; auto-merge solo R0/R1 con todos los gates; auto-merge con aprobacion humana previa. | Define el nivel real de autonomia y el riesgo de produccion. | Pendiente |
| D-06 | Fuente canonica del estado interno y regla de reconciliacion. | Documento de arquitectura, seccion de datos. | 13, 22 | GitLab como espejo; PostgreSQL como canonico para runs; reconciliacion periodica. | Evita divergencias entre issue y estado real del job. | Pendiente |
| D-07 | Quien aprueba spec, merge y produccion. | Documento de arquitectura, seccion de roles. | 14, 15, 18 | Product Owner + Tech Lead; Tech Lead solamente; comite por riesgo. | Define las puertas humanas y los permisos reales. | Pendiente |
| D-08 | Limites de reintentos, timeout y presupuesto por job. | Documento de arquitectura, seccion de errores. | 09, 20, 21 | Maximo fijo por rol; presupuesto por issue; corte por coste acumulado. | Afecta coste, recuperacion y experiencia de usuario. | Pendiente |
| D-09 | Tecnologias de cola, estado y artefactos. | Documento de arquitectura, seccion de despliegue. | 12, 22 | Redis + PostgreSQL + S3/MinIO; solo PostgreSQL; cola gestionada. | Afecta operacion, persistencia y recuperacion. | Pendiente |
| D-10 | Frontera entre GitLab CI y los runners de agentes. | Documento de arquitectura, seccion de integracion. | 02, 12, 23 | CI oficial para gates; runners propios para agentes; runners dedicados para ambos. | Evita confundir ejecucion de agentes con pipelines oficiales. | Pendiente |
| D-11 | TTL, reutilizacion y limpieza de previews. | Documento de arquitectura, seccion de preview. | 19 | TTL fijo por MR; reutilizacion por rama; destruccion inmediata al merge. | Afecta coste, disponibilidad y higiene de recursos. | Pendiente |
| D-12 | Gestion de secretos y tokens. | Documento de arquitectura, seccion de seguridad. | 16 | Vault externo; secretos de GitLab; tokens efimeros por job. | Afecta el riesgo de exfiltracion y la operacion. | Pendiente |
| D-13 | Alcance multi-proyecto. | Documento de arquitectura, seccion de contexto. | 13, 22 | Un proyecto; varios proyectos con policies por proyecto; multi-tenant. | Cambia el modelo de datos y el aislamiento. | Pendiente |
| D-14 | Propiedad de archivos protegidos y politica de CI. | Documento de arquitectura, seccion de seguridad. | 15, 16 | CODEOWNERS; branch protection; ambos. | Evita que un agente modifique el sistema que lo controla. | Pendiente |
| D-15 | Politica de despliegue a produccion. | Documento de arquitectura, seccion de entrega. | 12, 18 | Deploy manual; deploy automatico a staging y manual a produccion; canary. | Define el ultimo gate y el rollback. | Pendiente |
| D-16 | Alcance de deduplicacion e idempotencia. | Documento de arquitectura, seccion de Hermes. | 03, 20 | Deduplicacion por event id; por issue y transicion; ambas. | Evita jobs duplicados y efectos laterales. | Pendiente |
| D-17 | Versionado de prompts, skills y modelos por run. | Documento de arquitectura, seccion de observabilidad. | 03, 13, 21 | Version fija por release; version por job; pin de modelo. | Permite reproducir resultados y comparar calidad. | Pendiente |
| D-18 | Retencion de evidencias y artefactos. | Documento de arquitectura, seccion de datos. | 13, 20, 21 | Retencion por issue; por release; por tiempo. | Afecta auditoria, coste y privacidad. | Pendiente |

## Notas de coherencia

- El diagrama `12-despliegue-fisico.mmd` muestra Docker y Kubernetes como alternativas; no deben interpretarse como servicios simultaneos.
- El diagrama `22-fuente-verdad-y-propiedad-datos.mmd` distingue datos canonicos de proyecciones. La regla de reconciliacion no esta definida.
- El diagrama `19-ciclo-entornos-preview.mmd` no supone datos reales ni credenciales productivas.
- El diagrama `17-autonomia-y-riesgo.mmd` es una propuesta de politica; no autoriza por si mismo ninguna operacion.
- Los estados `APPROVED`, `MERGEABLE` y `DEPLOYED` no son equivalentes ni mutuamente excluyentes.
- Las entidades `RUN_ATTEMPT`, `REQUIREMENT`, `EVIDENCE`, `COMMIT`, `PIPELINE` y `MERGE_REQUEST` son propuestas de modelado, no implementaciones verificadas.
