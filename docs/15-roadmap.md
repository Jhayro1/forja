# 15 · Roadmap

Cada hito termina con algo que se puede **usar y demostrar**. El estado por eventos y la
redacción de secretos están desde el primer hito: agregarlos después cuesta mucho más.

| Hito | Nombre | Resultado demostrable | Tareas |
|------|--------|------------------------|--------|
| **M0** | Spike | Script que lanza `claude -p` y `codex exec` con stream JSON, parsea uso, reanuda sesión, detecta límite y usa `--json-schema` / `--output-schema`. Documento con los hallazgos. | T-001 … T-003 |
| **M1** | Núcleo | `forja nuevo`, daemon, eventos en SQLite, registro de proyectos, `forja estado`, `forja doctor`. Matar y relanzar sin perder estado. | T-010 … T-016 |
| **M2** | Planear | `forja planear` en la terminal: entrevista → `spec.json` validado → documentos con plantillas → tareas + plan con estimación → puerta. | T-020 … T-027 |
| **M3** | Ejecutar | `forja run`: worktrees, olas, N trabajadores, paquete de contexto simple (sin grafo), verificación por tests, escalera, cola de merge, recuperación tras `kill -9`. | T-030 … T-039 |
| **M4** | UI | Flujo, Planear, Agentes (en vivo), Tareas (grafo), Costos. | T-040 … T-045 |
| **M5** | Bóveda | Conexiones cifradas, tipos Cloudflare/SMTP/Postgres/genérico, MCP por tarea, redactor, acciones externas con vista previa, auditoría. | T-050 … T-057 |
| **M6** | Memoria | Grafo en SQLite, tree-sitter, relevancia, paquete de contexto por grafo, lecciones, fase Analizar para repos existentes. | T-060 … T-066 |
| **M7** | Publicar | README en inglés, demo grabada, `npx forja`, CI, guía de contribución, lanzamiento. | T-070 … T-075 |
| Después | — | Extensión de VS Code, embeddings, más proveedores, plantillas por stack, modo equipo | — |

## Primer uso real (dogfooding)

Desde M3, Forja se usa para construirse a sí misma: estas mismas tareas de
[16-backlog.md](16-backlog.md) se convierten en `tareas/*.yaml`.

## Orden recomendado

```
M0 ─► M1 ─► M2 ─► M3 ─┬─► M4 ─┐
                      ├─► M5 ─┼─► M7
                      └─► M6 ─┘
```
M4, M5 y M6 son independientes entre sí después de M3 y pueden avanzar en paralelo.
