# ADR-006 · Estado por eventos en SQLite

**Estado:** aceptada · 2026-09-24

## Contexto

Si el CLI o el daemon se detienen (cierre, caída, reinicio), Forja debe retomar sin
perder trabajo ni repetir lo que ya se pagó.

## Decisión

Cada cambio de estado es un **evento inmutable** en `estado.db` (SQLite, WAL), escrito en
una transacción **antes** de actuar. Las tablas de estado actual (tareas, agentes, uso)
son proyecciones que se pueden reconstruir desde los eventos. Al arrancar, un proceso de
**reconciliación** compara el estado con la realidad (PIDs, ramas, worktrees) y retoma.

## Consecuencias

- Recuperación completa tras `kill -9`, con checkpoints `wip` en git para el código.
- Historial completo para la UI, la auditoría y el cálculo de costos.
- Las proyecciones deben ser deterministas y estar probadas: reconstruirlas da lo mismo.
- Las respuestas de LLM ya recibidas se guardan con el hash del prompt, para no pagar dos veces.
