# ADR-002 · El orquestador es código, no un LLM

**Estado:** aceptada · 2026-09-24

## Contexto

En herramientas como OpenSpec, o con subagentes de Claude Code, el propio modelo decide
cuándo y cómo lanzar agentes. Eso gasta tokens caros en coordinación, es lento (un turno
del modelo por cada decisión de coordinación) y no es reproducible.

## Decisión

La coordinación (qué tarea sigue, cuántas en paralelo, reintentos, escalado, merge,
recuperación) la hace **código determinista** que lee el grafo de tareas y el estado.
Los modelos sólo reciben trabajo que requiere juicio.

## Consecuencias

- Coordinar cuesta 0 tokens y es instantáneo.
- El comportamiento es predecible y se puede probar con un proveedor simulado.
- El planeador debe dejar las tareas **bien formadas** (dependencias, archivos, tests); el
  código valida lo que puede (ciclos, archivos compartidos en una ola).
- Si una situación no está prevista, el orquestador no «improvisa»: pregunta al planeador o
  al usuario.
