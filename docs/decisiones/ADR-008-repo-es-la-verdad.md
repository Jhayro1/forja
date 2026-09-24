# ADR-008 · El repo es la verdad

**Estado:** aceptada · 2026-09-24

## Decisión

- Lo que se **decide** (spec.json, documentos, tareas, decisiones, lecciones, `forja.yaml`
  sin secretos) vive en `<repo>/.forja/` y se versiona con git.
- Lo que es **ejecución** (eventos, logs, sesiones, worktrees, costos, bóveda) vive en
  `~/.forja/proyectos/<id>/`.
- Lo que es **índice** (memoria.db) se puede reconstruir desde las dos anteriores.

## Consecuencias

- Clonar el repo en otra máquina trae toda la especificación y el plan; sólo falta el historial de ejecución.
- Las revisiones de especificación se hacen con PRs normales.
- Nunca hay secretos ni datos de ejecución en el repo (`.gitignore` generado por `forja nuevo`).
