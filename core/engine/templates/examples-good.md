# Buenos ejemplos

Ejemplos reales de lo que el arnés espera. Los revisores los leen antes de juzgar; el proyecto
añade aquí los suyos (un archivo por ejemplo, con el porqué).

## Línea de cierre de un implementer

```text
AI-HUB-STATUS: APPLIED | artifact=.ai-hub/work/012-invoices/impl.md | reason=-
```

Por qué es buena: el estado es del contrato, el artefacto existe y es una ruta relativa, y no hay
contenido de archivos en la línea.

## Línea de cierre de un bloqueo

```text
AI-HUB-STATUS: BLOCKED | artifact=specs/012-invoices/tasks.md | reason=missing_fixture: falta el fichero de ejemplo de la API de cobros
```

Por qué es buena: `BLOCKED` lleva motivo con código y una frase corta que dice qué falta, sin pegar
datos.

## Hallazgo de un refuter

```json findings
[{ "lens": "correctness", "severity": "should-fix", "file": "src/invoices/total.ts", "line": 42, "claim": "el descuento se aplica dos veces", "failure_scenario": "un pedido con dos líneas descontadas devuelve un total negativo", "evidence": "src/invoices/total.ts:42 suma discount en el bucle y otra vez al final" }]
```

Por qué es bueno: archivo, línea y escenario de fallo concreto; la consolidación puede verificarlo.
