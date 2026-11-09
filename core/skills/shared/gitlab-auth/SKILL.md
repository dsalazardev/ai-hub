---
name: gitlab-auth
description: "GitLab self-managed authentication for agents: personal access token in .ai-hub/.env loaded with ai-hub env exec, smoke test with ai-hub doctor --online, security rules and a user-driven fallback for UI-only flows."
license: MIT
compatibility: Requires Node (no bash, curl or PowerShell needed) and a GitLab personal access token with the "api" scope.
metadata:
  author: ai-hub
  version: "2.0"
origin: dsalazardev
---

# GitLab Auth — self-managed con Personal Access Token

## Cuándo usar esta skill

- Antes de cualquier operación de GitLab (issues, MRs, pipelines): verificar identidad.
- Para diagnosticar 401/403 y para rotar tokens.
- El día a día de operaciones vive en `gitlab-workflow`.

## Contrato de credenciales

- Ruta: `.ai-hub/.env`. Es local: `ai-hub init` la añade a `.gitignore` antes de que exista.
- Plantilla versionada: `.ai-hub/.env.example` (valores `CHANGEME`).
- **El agente nunca pide, lee en voz alta ni escribe credenciales.** Quien crea `.ai-hub/.env` es
  la persona: a mano desde la plantilla, o en el paso opcional del asistente interactivo de
  `ai-hub init`, en su propia terminal.

| Variable | Obligatoria | Uso |
|---|---|---|
| `GITLAB_URL` | sí | Base de la instancia, sin `/api` |
| `GITLAB_TOKEN` | sí | PAT con scope `api` |
| `GITLAB_PROJECT_PATH` | sí (workflow) | Path URL-encoded del proyecto (por ejemplo, `group%2Fproject`) |

Para que `doctor` compruebe la presencia de las claves, declara el tracker en `manifest.yaml`:

```yaml
tracker:
  kind: gitlab
  urlEnv: GITLAB_URL
  tokenEnv: GITLAB_TOKEN
```

Crear el PAT (lo hace la persona): en GitLab, avatar → Edit profile → Access Tokens
(`${GITLAB_URL}/-/user_settings/personal_access_tokens`), nombre `ai-hub-agent`, expiración
90-180 días, scope `api`. El valor se muestra UNA sola vez.

## Ejecutar con el entorno cargado

`ai-hub env exec` carga `.ai-hub/.env` en el proceso hijo, en cualquier sistema operativo y sin
shell. Las variables no se expanden en la línea de comandos: léelas desde el propio proceso.

```
npx ai-hub env exec -- node -e "fetch(process.env.GITLAB_URL + '/api/v4/user', { headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN } }).then((r) => console.log(r.status))"
```

## Prueba de humo (obligatoria antes de operar)

```
npx ai-hub doctor --online
```

- `[OK] tracker:token` → token válido; la identidad sale redactada.
- `HTTP 401` → token inválido, revocado o caducado: la persona debe reponer uno nuevo.
- `HTTP 403` → falta scope `api` (o el usuario no tiene permiso en el recurso).
- `env:keys` en rojo → faltan claves en `.ai-hub/.env`; pídele a la persona que las complete.

## Reglas de seguridad (duras)

1. NUNCA imprimir, loggear, citar ni pegar el token en chats, prompts, informes o `.md`.
2. NUNCA pedir el token, la contraseña ni ningún secreto en el chat: la persona los escribe en
   `.ai-hub/.env` por su cuenta.
3. NUNCA escribirlos en archivos versionados; su único sitio es `.ai-hub/.env`.
4. No usar modos verbosos ni trazas que impriman cabeceras de autenticación.
5. Ante un error, reportar «token inválido o caducado» sin incluir su valor.
6. Rotación: la persona revoca el token en Access Tokens, lo sustituye en `.ai-hub/.env` y se
   repite la prueba de humo.

## Flujos solo de interfaz web

Cuando la operación no exista en la API (ajustes de UI o formularios sin endpoint), el agente no
inicia sesión con credenciales: describe a la persona los pasos en `${GITLAB_URL}` y espera su
confirmación. Si hay automatización de navegador disponible, la persona inicia sesión
manualmente (incluido 2FA/passkey) y solo entonces el agente continúa en esa sesión.

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| 401 en API | Token inválido o caducado | La persona repone el PAT en `.ai-hub/.env` |
| 403 en API | Scope insuficiente | PAT con scope `api` |
| 404 en proyecto | Path mal codificado | Codificar el path en `GITLAB_PROJECT_PATH` (por ejemplo, `group%2Fproject`) |
| Error SSL | Certificado interno | Pedir a la persona el certificado raíz |
| `env:ignored` en rojo | `.ai-hub/.env` sin ignorar o versionado | Seguir el remedio que imprime `doctor` y rotar el token |
