# @dsalazardev/ai-hub-cli

Arnés agéntico instalable para repositorios de software. Instala un motor común
—CLI, reglas, agentes, skills, guardias— y lo proyecta hacia las herramientas que
el proyecto ya usa, sin acoplarse a un lenguaje ni a un dominio concreto.

## Requisitos

- Node.js >= 22

## Uso rápido

En un repositorio vacío o existente:

```bash
npx @dsalazardev/ai-hub-cli init --yes
npx @dsalazardev/ai-hub-cli install
npx @dsalazardev/ai-hub-cli doctor
```

`init` detecta el preset según el stack del repositorio y materializa `.ai-hub/`,
que es obligatoria. `install` proyecta reglas, agentes y skills a los destinos
declarados en `targets`. `doctor` valida motor, preset, manifiesto y deriva.

Si la detección es ambigua, el preset se elige explícitamente:

```bash
npx @dsalazardev/ai-hub-cli init --preset angular-express --yes
```

Destinos admitidos: `claude`, `opencode`, `pi`, `cursor`, `copilot`. Se pueden
limitar:

```bash
npx @dsalazardev/ai-hub-cli install --targets claude
```

## Comandos

| Comando | Qué hace |
|---|---|
| `init` | Detecta el repo, elige preset e imprime el plan; `--yes` lo aplica |
| `install` | Materializa el preset y sincroniza destinos |
| `sync` | Reproyecta; `--check` no escribe, `--check-lock` verifica integridad |
| `drift` | Informa diferencias entre fuentes y destinos |
| `doctor` / `check` | Diagnóstico completo del arnés |
| `add` | Añade una skill o agente del catálogo al proyecto |
| `context` | Regenera `.planning/context-next.md` |
| `purge` | Retira los destinos generados, con snapshot previo |

## Estructura instalada

```
.ai-hub/            preset materializado, manifiesto y configuración (obligatoria)
.planning/          estado, hallazgos y ledger de la sesión
.claude/ .opencode/ .pi/ .cursor/ .github/   destinos generados según targets
```

## Procedencia de activos

Ver `NOTICE.md` para el origen de skills y agentes reutilizados.

## Licencia

MIT. Copyright (c) 2026 Daner Alejandro Salazar Colorado.
