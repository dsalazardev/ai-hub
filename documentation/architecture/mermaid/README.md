# AI Hub 3.0 - Diagramas Mermaid

## Proposito

Esta carpeta contiene la primera version de la documentacion visual de **AI Hub 3.0**, el sistema agentico de desarrollo autonomo. Los diagramas representan la arquitectura completa, no un MVP: actores, planos, componentes, flujos, estados, permisos, seguridad, datos, despliegue, calidad, operacion y trazabilidad.

El codigo Mermaid es la fuente de verdad de cada diagrama. No hay imagenes sustitutas. Cada archivo `.mmd` puede editarse y visualizarse con una extension de Mermaid o con un renderizador compatible.

## Estado de validacion

- Se generaron **25 diagramas** en archivos `.mmd`.
- Se hizo revision estatica de estructura, bloques y coherencia.
- Se valido la sintaxis con **Mermaid 11 en navegador**: los 25 archivos pasaron `mermaid.parse`.
- Se ejecuto `mermaid.render` sobre los 25 archivos: **25/25 renderizaron sin error**.
- **No se guardaron imagenes** ni se uso `mmdc`; `mmdc` no esta instalado en el entorno y no se instalaron dependencias sin autorizacion.
- No se hizo una revision visual manual de legibilidad sobre capturas; la validacion fue sintactica y de render tecnico.
- Las decisiones que el documento de referencia no resolvia se registran en `DECISIONES_PENDIENTES.md`.

## Estructura

```
docs/architecture/mermaid/
  README.md
  DECISIONES_PENDIENTES.md
  00-mapa-general.mmd
  01-diagrama-contexto.mmd
  02-arquitectura-cinco-planos.mmd
  03-componentes-hermes.mmd
  04-flujo-completo-tarea.mmd
  05-bucle-definicion.mmd
  06-bucle-entrega.mmd
  07-bucle-aprendizaje.mmd
  08-estados-issue.mmd
  09-estados-job-run.mmd
  10-ciclo-merge-request.mmd
  11-secuencia-ejecucion-agente.mmd
  12-despliegue-fisico.mmd
  13-modelo-entidades-relaciones.mmd
  14-roles-y-colaboracion.mmd
  15-matriz-permisos.mmd
  16-seguridad-y-limites-confianza.mmd
  17-autonomia-y-riesgo.mmd
  18-puertas-calidad.mmd
  19-ciclo-entornos-preview.mmd
  20-errores-reintentos-recuperacion.mmd
  21-observabilidad-y-metricas.mmd
  22-fuente-verdad-y-propiedad-datos.mmd
  23-integraciones-y-dependencias.mmd
  24-trazabilidad-requisitos-evidencias.mmd
```

## Indice

| Archivo | Pregunta que responde |
|---|---|
| `00-mapa-general.mmd` | Cual es la vista completa del sistema y como se conectan sus partes. |
| `01-diagrama-contexto.mmd` | Quienes son los actores, sistemas externos y fronteras de AI Hub 3.0. |
| `02-arquitectura-cinco-planos.mmd` | Como se dividen control, ejecucion, conocimiento, integracion y gobernanza. |
| `03-componentes-hermes.mmd` | Que componentes internos tiene Hermes y como se relacionan. |
| `04-flujo-completo-tarea.mmd` | Que camino sigue una idea hasta el merge, deploy y cierre. |
| `05-bucle-definicion.mmd` | Como se revisa, pregunta, especifica y aprueba una necesidad. |
| `06-bucle-entrega.mmd` | Como se implementa, prueba, revisa, valida y entrega. |
| `07-bucle-aprendizaje.mmd` | Como se usan metricas, incidentes y ADRs para mejorar el sistema. |
| `08-estados-issue.mmd` | Cuales son los estados de una issue y sus transiciones. |
| `09-estados-job-run.mmd` | Cuales son los estados de un job, un run y un intento. |
| `10-ciclo-merge-request.mmd` | Cuales son los estados internos y de GitLab de un MR. |
| `11-secuencia-ejecucion-agente.mmd` | Que ocurre paso a paso cuando se ejecuta un agente. |
| `12-despliegue-fisico.mmd` | Como se despliega logicamente la plataforma y sus servicios. |
| `13-modelo-entidades-relaciones.mmd` | Que entidades, relaciones y trazabilidad existen. |
| `14-roles-y-colaboracion.mmd` | Que roles hay y como se transfieren responsabilidades. |
| `15-matriz-permisos.mmd` | Que puede y que no puede hacer cada rol. |
| `16-seguridad-y-limites-confianza.mmd` | Cuales son las zonas de confianza, amenazas y controles. |
| `17-autonomia-y-riesgo.mmd` | Cuanta autonomia se permite segun el riesgo. |
| `18-puertas-calidad.mmd` | Que gates bloquean MR, merge y produccion. |
| `19-ciclo-entornos-preview.mmd` | Como nace, se usa, caduca y se destruye un preview. |
| `20-errores-reintentos-recuperacion.mmd` | Que pasa ante fallos, timeouts, duplicados y rollback. |
| `21-observabilidad-y-metricas.mmd` | Que se mide, donde se almacena y como se usa. |
| `22-fuente-verdad-y-propiedad-datos.mmd` | Que sistema es canonico para cada dato. |
| `23-integraciones-y-dependencias.mmd` | Que integraciones existen y cuales son criticas. |
| `24-trazabilidad-requisitos-evidencias.mmd` | Como se demuestra que un requisito fue implementado y verificado. |

## Convenciones visuales

- **Amarillo**: personas, aprobaciones y decisiones humanas.
- **Azul**: control, planificacion y estados del sistema.
- **Verde**: ejecucion, agentes y resultados exitosos.
- **Violeta**: conocimiento, Spec Kit, artefactos y datos.
- **Naranja**: integracion, GitLab y despliegue.
- **Rojo**: seguridad, gates, riesgos y fallos.
- **Gris**: decisiones pendientes, alternativas o elementos no verificados.
- **Linea solida**: flujo o dependencia principal.
- **Linea discontinua**: dependencia condicional, propuesta o pendiente.

Las etiquetas de estado `Definido`, `Inferido`, `Pendiente` y `No verificado` se usan en `DECISIONES_PENDIENTES.md`. En los diagramas, los comentarios `%%` marcan las incertidumbres.

## Como visualizar o editar

1. Abrir un archivo `.mmd` en VS Code con la extension **Mermaid Chart** o **Mermaid Preview**.
2. Usar **MermaidChart: Preview Diagram** o la vista previa integrada.
3. Tambien se puede pegar el contenido en el editor de Mermaid Live.
4. Mantener el codigo en `.mmd`; no reemplazarlo por capturas.

## Matriz de trazabilidad

| Tema de arquitectura | Diagramas |
|---|---|
| Vision general y contexto | 00, 01, 02 |
| Plano de control y componentes de Hermes | 02, 03, 11 |
| Bucle de definicion | 04, 05, 08, 14, 18 |
| Bucle de entrega | 04, 06, 10, 11, 18, 19 |
| Bucle de aprendizaje | 07, 21, 24 |
| Estados y ciclo de vida | 08, 09, 10, 19 |
| Datos y trazabilidad | 13, 22, 24 |
| Roles y permisos | 14, 15, 17 |
| Seguridad y confianza | 15, 16, 17 |
| Calidad y gates | 18, 20 |
| Despliegue e integraciones | 12, 19, 23 |
| Operacion y observabilidad | 20, 21, 22, 23 |

## Relacion con la fuente

La fuente principal es el documento de arquitectura de AI Hub 3.0 y el prompt maestro de diagramacion. No existia documentacion Mermaid previa en el repositorio. Las decisiones no resueltas por la fuente se registran en `DECISIONES_PENDIENTES.md` y no se presentan como hechos consumados.

## Limitaciones

- No hay renderizado real ni capturas generadas.
- La topologia fisica es una propuesta; Docker y Kubernetes aparecen como alternativas.
- PostgreSQL, Redis y MinIO son componentes propuestos, no verificados en el entorno actual.
- Las reglas de autonomia, auto-merge, TTL de preview, reconciliacion de estado y presupuesto siguen pendientes.
