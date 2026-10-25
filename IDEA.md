# AI-Hub - Arquitectura, Investigación y Evolución

## Propósito

Este proyecto tiene como objetivo investigar, comprender, documentar y evolucionar AI-Hub como una fábrica de software universal basada en agentes de inteligencia artificial.

AI-Hub debe permitir instalar un arnés de desarrollo agéntico verificable en diferentes repositorios, manteniendo la separación entre el motor reutilizable, los presets y los activos específicos de cada proyecto consumidor.

El objetivo arquitectónico es evolucionar hacia un sistema dirigido por producto, en el que las tareas, las especificaciones, los estados, los agentes especializados, las revisiones, las puertas de calidad y las evidencias coordinen el ciclo completo de desarrollo.

La inspiración conceptual es el modelo CPTO 10x: el criterio humano se concentra en definir qué construir y validar qué está listo, mientras los agentes ejecutan trabajos especializados, aislados, concurrentes y verificables.

Esta inspiración debe adaptarse al diseño propio de AI-Hub y no copiar mecánicamente arquitecturas de otras plataformas.

## Fuentes de investigación

### 1. Fábrica principal

El repositorio `ai-hub` es la fuente principal para estudiar el motor, la CLI, los contratos, los presets, los agentes, las skills, las reglas, la sincronización, los guards y la documentación arquitectónica.

La gobernanza operativa de AI-Hub debe determinar cómo se investigan y modifican sus componentes.

### 2. Primera implementación real

La carpeta `.ai-hub` de Doligestion es la referencia principal para estudiar cómo se utiliza la fábrica actualmente en un proyecto consumidor.

Debe permitir contrastar el diseño del motor con la configuración instalada, identificar desviaciones y detectar problemas prácticos de compatibilidad, sincronización, procedencia y mantenimiento.

La implementación de Doligestion constituye evidencia de uso, pero sus particularidades no deben incorporarse automáticamente al motor universal.

### 3. Repositorio upstream

RSC-Harness es una referencia para investigar la procedencia y evolución de agentes, skills, scripts, targets y mecanismos de orquestación.

Se deben distinguir los activos originales de AI-Hub, los heredados o adaptados de upstream y los que tengan procedencia no verificada.

### 4. Proyecto de referencia tecnológica

REPO-BETTATECH permite explorar estructuras, patrones arquitectónicos, configuraciones y posibles activos reutilizables.

Toda propuesta de reutilización debe justificar su aplicabilidad, compatibilidad y ubicación correcta: motor, preset o proyecto consumidor.

### 5. Arquitectura maestra

Lucidchart y los diagramas Mermaid existentes en `ai-hub/architecture/` sirven para contrastar el diseño conceptual con el código y la documentación reales.

Los diagramas deben evolucionar hacia una colección coherente de vistas editables, con trazabilidad entre componentes, flujos, estados, permisos, datos, seguridad, ejecución y despliegue.

## Modelo arquitectónico

La visión objetivo contempla cinco planos:

1. Control: orquestación, eventos, estados, políticas, colas, roles, aprobaciones y costes.
2. Ejecución: agentes, herramientas, worktrees aislados, builds y pruebas.
3. Conocimiento: especificaciones, skills, reglas, ADR y plantillas.
4. Integración: GitLab, Git, CI, entornos de preview y servicios del proyecto.
5. Gobernanza: identidad, permisos, secretos, auditoría, riesgos e incidentes.

La arquitectura de referencia utiliza Hermes como plano de control y Claude Code como motor principal de ejecución técnica. Debe verificarse qué capacidades existen realmente y cuáles necesitan configuración, integración o desarrollo.

Spec Kit es la metodología de runtime de referencia. OpenSpec se considera archivo histórico, según la arquitectura proporcionada. No deben introducirse metodologías operativas paralelas sin una decisión explícita.

## Objetivos del proyecto

- Comprender la arquitectura y los contratos reales de AI-Hub.
- Contrastar el motor con su primera implementación real.
- Detectar contradicciones entre código, documentación, manifiestos, diagramas y tests.
- Investigar la procedencia de los activos y mantener la separación entre motor, presets y proyectos consumidores.
- Mejorar la arquitectura de sincronización, validación y proyección hacia herramientas compatibles.
- Diseñar un sistema de orquestación capaz de gestionar tareas, estados, agentes, ejecuciones aisladas y evidencias.
- Definir permisos explícitos, mínimo privilegio, puertas humanas y revisiones independientes.
- Documentar máquinas de estados, integraciones, modelo de datos, flujos de ejecución, recuperación y despliegue mediante Mermaid.
- Preparar contratos, decisiones y criterios de aceptación que puedan formalizarse cuando corresponda.
- Evolucionar la fábrica sin introducir regresiones en la primera implementación.

## Principios obligatorios

- Investigar antes de recomendar.
- Verificar el código y los tests antes de afirmar que una capacidad existe.
- Mantener la separación entre motor, preset y proyecto consumidor.
- No inventar comandos, archivos, resultados, permisos ni capacidades.
- Distinguir hechos verificados, inferencias, propuestas y decisiones pendientes.
- Preservar la procedencia de los activos.
- Diseñar para el aislamiento, la idempotencia, la trazabilidad y la recuperación.
- No permitir que un agente apruebe su propio trabajo.
- No interpretar una comprobación fallida o no disponible como una aprobación satisfactoria.
- No modificar archivos ni implementar funcionalidades durante una exploración de solo lectura.
- Solicitar autorización para implementar cambios fuera de un alcance explícitamente aprobado.
- No presentar un diagrama conceptual como prueba de que la implementación coincide con él.

## Resultado esperado

Este proyecto debe convertirse en un espacio central de trabajo arquitectónico para AI-Hub: una fuente organizada de investigaciones, hallazgos, decisiones, diagramas Mermaid, contratos y propuestas de evolución.

Cada análisis debe identificar su alcance, las fuentes inspeccionadas, las evidencias relevantes, los riesgos, las decisiones pendientes y las verificaciones realmente ejecutadas.

La prioridad no es producir más código ni más diagramas indiscriminadamente. Es construir una fábrica de software fiable, reutilizable, segura, mantenible y capaz de convertir necesidades de producto en cambios técnicamente verificables.
