# Malos ejemplos

Lo que el arnés rechaza o degrada, con el motivo. El proyecto añade aquí los errores reales que no
quiere repetir.

## Cierre en prosa

```text
Listo, ya implementé todo y los tests pasan.
```

Por qué es malo: no hay línea `AI-HUB-STATUS`; el plano de control no puede leer el resultado y
`ai-hub runs event --from-status` lo registra como `invalid_status`.

## Bloqueo sin motivo

```text
AI-HUB-STATUS: BLOCKED | artifact=- | reason=-
```

Por qué es malo: `BLOCKED` exige `reason=<código>`; el parser lo rechaza.

## Hallazgo sin escenario

```json findings
[{ "lens": "security", "severity": "blocker", "file": "src/auth/session.ts", "claim": "esto parece inseguro" }]
```

Por qué es malo: sin línea ni escenario de fallo; `ai-hub review consolidate` lo degrada a `question`
y nunca bloquea.

## Test editado para pasar

Un implementer que cambia la aserción de un test existente para que la suite quede en verde. La
regla de autoría lo prohíbe: un test incorrecto se informa y se corrige en su propio paso revisado.
