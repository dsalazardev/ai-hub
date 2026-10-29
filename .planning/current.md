# Estado de sesión — speckit-latest

- Fecha: 2026-10-29 (implementación completa y ARCHIVADO)
- Cambio: `speckit-latest` → `openspec/changes/archive/2026-10-29-speckit-latest/`
- Fase: archivado (17/17 tareas; specs principales sincronizados)
- Repo: `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\DESARROLLO\ai-hub`
- Anterior: `shell-resolution` archivado (0.3.1 publicado)
- Detalle y desviaciones: `.planning/impl_speckit-latest.md`; evidencia de la sonda en `.planning/findings.md`

## Resultado de la implementación

Aplicado en 6 lotes, con sondas rojas vistas antes de cada cambio:

- `supported` (`>=1.2.3 <1.3.0`) es la única fuente de versión: `engine.yaml` sin `pin` ni `excludeNewer`; `uvxPrefix` produce `--from specify-cli>=1.2.3,<1.3.0` (o `==<declarada>` con `speckit.version`, design D6); validación del motor y del proyecto rechaza campos retirados nombrándolos (dinámica, sin literales en `core/src`).
- `speckit:version` valida por rango con `satisfiesRange`: 1.2.5 sana; `1.3.0` y `1.2.1.dev0` fallan nombrando instalada y rango; `speckit:managed` informa el rango.
- Secuencia interna de tres `specify init` (no elegidos primero, elegido al final): `.specify/scripts/{bash,powershell,python}` con 6 archivos cada uno y manifiesto de 24; `doctor` no exige los tres (proyecto viejo bash-only sigue sano).
- El hash del plan lleva la versión RESUELTA (sondeo en dry-run, `init-options.speckit_version` tras instalar); sin resolución nombra el rango.
- `speckit-real.test.ts` dinámico: valida el contrato (dentro del rango), no una versión puntual.
- Docs: `core/README.md` y `AGENTS.md` §3 con el rango como única fuente; `CHANGELOG.md` 0.4.0 (0.3.1 intacta); bump a 0.4.0 en `core/package.json` + lock.

## Verificación final (6.1–6.3, con salida real)

- `npm run build`: exit 0. `npm run ai:typecheck`: exit 0.
- Suite completa: 27 archivos, **290 pasados, 1 omitido**, exit 0 (~378 s).
- Grep `excludeNewer|exclude-newer`: limpio en `core/src`, `core/engine`, `core/README.md`, `AGENTS.md`; en `core/tests` sólo lápidas (escenario exigido por 1.1 y aserciones negativas). Sin `any` en `core/src`.
- Sonda manual (consumidor `scratch\speckit-latest-probe\consumer-final`): `init --yes` exit 0, `Spec Kit 1.2.5 · script sh`, tres directorios con 6 archivos, manifiesto 24, `doctor` exit 0 con `speckit:version: 1.2.5 dentro del rango >=1.2.3 <1.3.0`.
- `doctor` en el taller: sano (exit 0); los 11 `speckit:*` en "no aplica en el checkout del motor".

## Pendiente

1. Publicar 0.4.0 fuera de esta sesión (todo sigue sin commit).
2. Próximo cambio puede actualizar el wording residual de `preset-system` ("The project manifest separates engine from project" aún menciona "pin, date" en su descripción y "package pin" en un escenario; el delta no lo tocó y se conservó tal cual).

## Comando para retomar

```powershell
openspec instructions apply --change "speckit-latest" --json
```
