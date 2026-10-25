# Workflow — Spec Kit + Harness

## Principio

Cada petición recorre un carril distinto según su tamaño. El orquestador decide el carril y lo dice en una línea; no hay proceso único para todo.

| Petición | Carril | Salida |
|---|---|---|
| Duda o investigación | Answer (solo lectura) | `.planning/findings.md` |
| Cambio pequeño y acotado | Bug Fix o Feature corta | `fix.md` / `tasks.md` |
| Feature compleja | Feature SDD completo | `spec.md`, `plan.md`, `tasks.md`, `convergence.md` |

## Ciclo

```text
ai::todo
   │  spec-start
   ▼
ai::in-spec ── Assessment (5 comandos)
   │  spec-ready
   ▼
ai::spec-ready ── HUMAN GATE (hash)
   │  approve
   ▼
ai::in-dev ── implement (9 comandos Feature)
   │  review-start
   ▼
ai::in-review ── reviewers
   │  review-pass
   ▼
ai::done
```

Cualquier estado puede pasar a `ai::blocked`. `unblock` vuelve a `ai::todo` para reencauzar.

## Fases

1. **Exploración** — `explorer-domain` responde con evidencia y escribe `.planning/findings.md`.
2. **Assessment** — `spec-explorer` ejecuta los 5 comandos y termina en `GO`, `KILL` o `NEEDS_CLARIFICATION`.
3. **Autoría** — `spec-author` produce `spec.md`, `plan.md`, `tasks.md` y `analysis.md`.
4. **Aprobación** — el humano aprueba el SHA-256 del conjunto; sin aprobación no se implementa.
5. **Implementación** — cada implementer trabaja en su rama/worktree y verifica cada tarea.
6. **Revisión** — arquitectura y tests emiten veredicto independiente.
7. **Convergencia** — `converge` mapea requisito → código → test y declara `CONVERGED`.
8. **Cierre** — se actualiza `.planning/history.md` y se archiva el cambio.

## Handoff en disco

`findings.md` → `impl_<name>.md` → `review_arch_<name>.md` / `review_tests_<name>.md` → `history.md`.
`state.json` guarda cambio, fase y tareas; `memory.jsonl` guarda decisiones y checkpoints.

## Recuperación

Si se pierde el contexto:

1. `ai-hub context`.
2. Leer `.planning/state.json` y `.planning/current.md`.
3. `ai-hub memory resume`.
4. Retomar según la fase: spec → aprobación, implement → implementers, review → reviewers, done → archivar.
