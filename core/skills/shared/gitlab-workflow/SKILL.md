---
name: gitlab-workflow
description: "Daily GitLab operations for the self-managed instance via REST API v4: my assigned issues, issue detail and comments, labels and state, merge requests and pipelines."
license: MIT
compatibility: Requires gitlab-auth (GITLAB_URL/GITLAB_TOKEN/GITLAB_PROJECT_PATH in environment) and curl or Node.
metadata:
  author: ai-hub
  version: "1.0"
origin: dsalazardev
---

# GitLab Workflow — operación diaria contra la API v4

## Prerrequisito

`gitlab-auth`: entorno cargado y prueba de humo (`GET /api/v4/user`) en verde.

Constantes:

- `BASE = {GITLAB_URL}/api/v4`
- Header: `PRIVATE-TOKEN: {GITLAB_TOKEN}`
- Proyecto: `$GITLAB_PROJECT_PATH` (path URL-encoded, por ejemplo `group%2Fproject`)

## Reglas

- Lecturas primero. Operaciones de escritura (comentar, etiquetar, cerrar) solo cuando el usuario lo pida, con SU texto y SUS valores.
- Nada destructivo sin confirmación explícita (cerrar/reabrir, borrar, force).
- Paginar con `per_page` (máx 100) y `page`; no asumir que la primera página lo tiene todo.
- Parsear JSON con python3 o Node; nunca `grep` frágil sobre la respuesta.
- Nunca incluir el token en URLs, logs ni mensajes de error.

## Recetas (bash / git-bash)

Mis issues asignadas:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/issues?scope=assigned_to_me&state=opened&per_page=50"
```

Issues abiertas del proyecto:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/issues?state=opened&per_page=100"
```

Detalle de una issue:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/issues/<iid>"
```

Comentarios (notas) de una issue:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/issues/<iid>/notes?sort=asc&per_page=100"
```

Comentar una issue (cuerpo aprobado por el usuario):

```
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "body=<texto>" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/issues/<iid>/notes"
```

Etiquetas y estado:

```
curl -s -X PUT -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "labels=En curso" \
  --data-urlencode "state_event=close" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/issues/<iid>"
```

(`state_event` admite `close` o `reopen`; omitirlo si solo se cambian etiquetas.)

Merge requests asignadas:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/merge_requests?scope=assigned_to_me&state=opened&per_page=50"
```

MR de una rama:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/merge_requests?source_branch=<rama>&state=opened"
```

Pipelines del proyecto:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/pipelines?per_page=10"
```

Jobs de un pipeline:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/pipelines/<id>/jobs"
```

Crear MR (solo con confirmación; sin merges automáticos):

```
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "source_branch=<rama>" \
  --data-urlencode "target_branch=main" \
  --data-urlencode "title=<titulo aprobado>" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_PATH/merge_requests"
```

## Variante PowerShell

```
$h = @{ "PRIVATE-TOKEN" = $env:GITLAB_TOKEN }
Invoke-RestMethod -Headers $h -Uri "$env:GITLAB_URL/api/v4/issues?scope=assigned_to_me&state=opened"
```

Para POST con cuerpo:

```
Invoke-RestMethod -Method Post -Headers $h -Body @{ body = "<texto>" } `
  -Uri "$env:GITLAB_URL/api/v4/projects/$env:GITLAB_PROJECT_PATH/issues/<iid>/notes"
```

## Presentación al usuario

- Issues: proyecto, `#iid`, título, etiquetas, assignee y URL web.
- Notas: fecha, autor y primeras líneas; enlazar a la issue.
- MRs: título, rama origen → destino, estado y URL.
- Pipelines: estado, ref, duración y URL.
