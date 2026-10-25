---
name: gitlab-auth
description: "GitLab self-managed (gitlab.v3.onnadigital.com) authentication for agents: PAT from .ai-hub/.env, smoke test, security rules, Playwright fallback for UI-only flows."
license: MIT
compatibility: Requires curl or Node and a GitLab personal access token with the "api" scope.
metadata:
  author: Doligestion AI Hub
  version: "1.0"
origin: ai-hub
---

# GitLab Auth — self-managed con Personal Access Token

## Cuándo usar esta skill

- Antes de cualquier operación de GitLab (issues, MRs, pipelines): cargar el entorno y verificar identidad.
- Para diagnosticar 401/403 y para rotar tokens.
- El día a día de operaciones vive en `gitlab-workflow`.

## Contrato de credenciales

Ruta: `.ai-hub/.env` (local; NUNCA versionado — patrón `*.env` del `.gitignore`).
Plantilla: `.ai-hub/.env.example`.

| Variable | Obligatoria | Uso |
|---|---|---|
| `GITLAB_URL` | sí | Base sin `/api` (por defecto `https://gitlab.v3.onnadigital.com`) |
| `GITLAB_TOKEN` | sí | PAT con scope `api` |
| `GITLAB_USER` | no | Solo fallback UI (Playwright) |
| `GITLAB_PASSWORD` | no | Solo fallback UI (Playwright) |

Crear el PAT: GitLab → avatar → Edit profile → Access Tokens
(`https://gitlab.v3.onnadigital.com/-/user_settings/personal_access_tokens`),
nombre `ai-hub-agent`, expiración 90-180 días, scope `api`. El valor `glpat-...`
se muestra UNA sola vez.

## Cargar el entorno

bash / git-bash:

```
source .ai-hub/bootstrap/load-env.sh
```

PowerShell:

```
Get-Content .ai-hub/.env | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim('"'), 'Process')
  }
}
```

## Prueba de humo (obligatoria antes de operar)

bash:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/user"
```

PowerShell:

```
curl.exe -s -H "PRIVATE-TOKEN: $env:GITLAB_TOKEN" "$env:GITLAB_URL/api/v4/user"
```

- 200 → JSON con `id`, `username`, `name`: token válido.
- 401 → token inválido, revocado o caducado: reponer uno nuevo.
- 403 → falta scope `api` (o el usuario no tiene permiso en el recurso).

## Reglas de seguridad (duras)

1. NUNCA imprimir, loggear, citar ni pegar el token en chats, prompts, informes o `.md`.
2. NUNCA escribirlo en archivos versionados; su único sitio es `.ai-hub/.env`.
3. No usar `curl -v` ni `--trace` con cabeceras de autenticación (filtran el header).
4. Ante un error, reportar «token inválido o caducado» sin incluir su valor.
5. Rotación: revocar en Access Tokens y sustituirlo en `.env`; repetir la prueba de humo.

## Fallback de navegador (Playwright) — solo flujos UI-only

Solo cuando la operación no exista en la API (ajustes de UI o formularios sin endpoint).

1. Verificar `GITLAB_USER` y `GITLAB_PASSWORD` en el entorno; si faltan, pedirlos al usuario.
2. Abrir `https://gitlab.v3.onnadigital.com/users/sign_in`, rellenar y enviar.
3. Nunca escribir la contraseña en logs ni capturas con el campo visible.
4. Si hay 2FA/passkey, pedir al usuario que complete el login manualmente.

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| 401 en API | Token inválido o caducado | Reponer PAT y actualizar `.env` |
| 403 en API | Scope insuficiente | PAT con scope `api` |
| 404 en proyecto | Path mal codificado | Usar `dolibarr%2Fdoligestion` |
| Error SSL | Certificado interno | Pedir al usuario el certificado raíz |
| `glab` ausente | No instalado | Usar curl/Node (no requiere glab) |
