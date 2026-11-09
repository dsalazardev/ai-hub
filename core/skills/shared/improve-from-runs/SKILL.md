---
name: improve-from-runs
description: "Improve the project's factory from its own run telemetry: read ai-hub runs, find the single piece that keeps failing, slowing down or being retried, fix only that piece and record the lesson in .ai-hub/lessons.md."
license: MIT
compatibility: Requires the ai-hub CLI (ai-hub runs list --json) and a project with .ai-hub/runs and .ai-hub/lessons.md.
metadata:
  author: ai-hub
  version: "1.0"
origin: dsalazardev
---

# Improve from runs — una pieza, una lección

## Cuándo usar esta skill

- Después de varias ejecuciones con fallos, reintentos o rondas `NEEDS_WORK` repetidas.
- Cuando la misma devolución o el mismo motivo de bloqueo vuelve a aparecer.
- Cuando la persona corrige siempre el mismo sitio a mano.
- No sirve para diagnosticar un bug concreto del producto (eso es `debug`) ni para ejecutar las
  verificaciones (eso es `verify` o `ai-hub gate`).

## Procedimiento

1. **Datos antes que opiniones.** Ejecuta `npx ai-hub runs list --json` y lee los eventos de las
   últimas ejecuciones en `.ai-hub/runs/<run>/events.jsonl`. Cuenta, por paso: fallos, intentos,
   rondas `NEEDS_WORK`, duración y motivos (`reason_code`). No supongas cifras que la telemetría no
   registra.
2. **Una sola pieza culpable.** Elige el paso que más falla, más se reintenta o más tarda, y decide
   cuál de estas causas lo explica:
   - le falta contexto (una regla o un documento que el agente no tenía);
   - sus instrucciones son ambiguas;
   - su criterio de aceptación está incompleto;
   - lo hace un agente cuando podría hacerlo código determinista;
   - su comprobación es demasiado laxa y deja pasar el error hasta más tarde.
3. **Arregla solo esa pieza.** Cambia una regla, una skill del proyecto o un comando del manifiesto,
   y nada más. Si el arreglo toca varias piezas, divide el trabajo.
4. **Escribe la lección** arriba de `.ai-hub/lessons.md`, con el formato del archivo: fecha y paso,
   qué pasó, la regla en imperativo y cómo se comprueba.
5. **Vuelve a pasar la misma entrada** y compara la telemetría antes y después. Si no mejoró,
   revierte el arreglo y vuelve al paso 2.

## Señales de mejora aunque nada falle

- Reintentos altos en un paso que termina en verde.
- Duración anómala frente a las ejecuciones anteriores del mismo paso.
- Notas `decision` que se repiten: la decisión debería ser una regla.
- Notas `awaiting-ok` que se repiten por el mismo motivo.

## Reglas

- Nunca copies prompts, contenido de archivos, tokens ni variables de entorno a las lecciones.
- Nunca cambies las etiquetas de una issue ni apruebes nada: propón y deja la decisión a la persona.
- Una lección por bloque; si contradice una anterior, actualiza la anterior en vez de duplicarla.
