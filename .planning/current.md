# Estado de sesión — shell-resolution

- Fecha: 2026-10-28
- Cambio activo: `shell-resolution`
- Fase: implementado (11/11 tareas; pendiente de revisión humana y archivo)
- Repo: `C:\Users\USUARIO\OneDrive\Escritorio\ARCHIVOS\DESARROLLO\ai-hub`
- Anterior: `install-completo` archivado en `openspec/changes/archive/2026-10-26-install-completo/`

## Resultado de la implementación

Aplicado con `/opsx-apply` en 4 lotes, con sondas rojas vistas antes de cada cambio (evidencia en `.planning/impl_shell.md`):

- `shellCandidates` + `gitBashCandidates`: PATH primero, luego rutas estándar de Git for Windows en `win32`; `probeShell` devuelve `tried` y filtra rutas inexistentes.
- Preflight reescrito: comandos probados, Git for Windows, bandera exacta (`ai-hub init|install --script ps`); sin `manifest.yaml`.
- `doctor`: nuevo check `speckit:script` (doceavo) detecta desvío manifest/instalación; `speckit:shell` nombra la ruta absoluta fuera del PATH; fila nueva en `core/README.md`.
- `--script <sh|ps>` en `init`/`install`: validación temprana (exit 2), precedencia bandera > manifest > motor, persistencia en `speckit.script`, hash del plan sigue a la bandera, cambio de script reinstala Spec Kit.
- Sonda manual en consumidor temporal: `shellCommand` pasa de `bash` (missing) a `C:\Program Files\Git\bin\bash.exe` (found).
- Release 0.3.1: `core/package.json` + lock + `CHANGELOG.md` (cifras medidas sin cambio, `excludeNewer` quieto).

## Verificación final

- `npm run build`: exit 0. `npm run ai:typecheck`: exit 0.
- `npm test` (core): 27 archivos, 285 pasados, 1 omitido, exit 0.
- `doctor` en el taller: sano (11 `speckit:*` en "no aplica").

## Pendiente

1. Revisión humana del diff completo (todo sin commit).
2. Publicar 0.3.1 fuera de esta sesión.
3. Archivar con `/opsx-archive` cuando la revisión lo apruebe.

## Comando para retomar

```powershell
openspec instructions apply --change "shell-resolution" --json
```
