# 16 · Backlog del MVP

Formato: **ID · título** — qué incluye · *depende de* · nivel sugerido · criterio de listo.
Cuando Forja pueda ejecutarse a sí misma (M3), cada fila se convierte en `tareas/T-xxx.yaml`.

## M0 · Spike

- **T-001 · Adaptador Claude de prueba** — `claude -p --output-format stream-json`, `--model`, `--resume`, `--json-schema`, `--mcp-config`; grabar salidas reales en `fixtures/`; identificar eventos de uso, fin, error y límite; modo de permisos no interactivo. · — · planeador · un documento `docs/spike-claude.md` + fixtures.
- **T-002 · Adaptador Codex de prueba** — `codex exec --json`, `-m`, `--output-schema`, `-C`, `-s`, `exec resume`; cómo pasar MCP por ejecución; uso y límites. · — · planeador · `docs/spike-codex.md` + fixtures.
- **T-003 · Decisiones del spike** — actualizar [11-proveedores.md](11-proveedores.md) y [17-riesgos-y-preguntas.md](17-riesgos-y-preguntas.md) con lo aprendido; confirmar o cambiar ADR-003. · T-001, T-002 · planeador.

## M1 · Núcleo

- **T-010 · Monorepo** — pnpm workspaces, TS estricto, vitest, eslint, tsup, CI básico. · — · barato · `pnpm -r build test` en verde.
- **T-011 · Esquemas base (contratos)** — zod para `forja.yaml`, eventos, tarea y spec.json (ver [formatos/](formatos/)); exportar JSON Schema. · T-010 · medio · tests de validación con ejemplos válidos e inválidos.
- **T-012 · Almacén de eventos** — `node:sqlite` WAL, `agregar(evento)` transaccional, proyecciones (proyecto, fases, tareas, uso). · T-011 · medio · reconstruir proyecciones desde cero da el mismo resultado.
- **T-013 · HOME y registro de proyectos** — `~/.forja`, `registro.db`, `nuevo`, `importar`, `proyectos`, `usar`, resolución del proyecto actual. · T-012 · barato.
- **T-014 · Daemon y CLI** — `serve`, levantar en segundo plano, lock por proyecto, API local con token, `estado`, `parar`. · T-012 · medio.
- **T-015 · Doctor** — node, git, claude y codex instalados y con sesión, permisos, disco. · T-014 · barato.
- **T-016 · Adaptadores reales** — `Proveedor` para Claude y Codex desde el spike, con tests sobre fixtures. · T-003, T-011 · medio.

## M2 · Planear

- **T-020 · Sesión del planeador** — conversación persistente (reanudar sesión), preguntas abiertas, guardado por turno, en la terminal. · T-014, T-016 · medio.
- **T-021 · Prompts del planeador** — Descubrir (checklist), Especificar (a JSON), Dividir (ajuste de borrador); versionados con hash. · T-020 · planeador.
- **T-022 · Validación y huecos** — reglas de completitud y petición sólo de huecos. · T-011, T-020 · medio.
- **T-023 · Plantillas de documentos** — UC, `.feature`, reglas, modelo de datos (Mermaid), trazabilidad, glosario, plan de pruebas; hash en la cabecera; regla de editado a mano. · T-011 · barato.
- **T-024 · Borrador de tareas por reglas** — tabla de [05](05-generacion-barata.md). · T-011 · medio.
- **T-025 · Olas y validación del grafo** — ciclos, archivos compartidos en una misma ola, orden topológico. · T-024 · barato.
- **T-026 · Estimación de costo** — por tarea, por nivel y total; `precios.yaml`. · T-025 · barato.
- **T-027 · Puertas** — `aprobar spec|plan`; eventos; bloqueo de `run` sin aprobación. · T-012 · barato.

## M3 · Ejecutar

- **T-030 · Worktrees y ramas** — crear, reutilizar, checkpoints `wip`, aplastar al aprobar. · T-013 · medio.
- **T-031 · Scheduler** — olas, `paralelo_max` por proyecto y global, cupos por proveedor, pausa por límite. · T-012, T-016 · medio.
- **T-032 · Paquete de contexto v1** — prefijo estable + tarea + fragmentos del spec + archivos permitidos (sin grafo todavía). · T-011 · barato.
- **T-033 · Perfil del proyecto** — detectar comandos para Node, Go y Python; probarlos. · T-013 · barato.
- **T-034 · Verificador** — tubería de 7 pasos, antitrampas, revisor con esquema. · T-033, T-016 · medio.
- **T-035 · Escalera y reintentos** — contexto del fallo, subir de nivel, bloquear. · T-031, T-034 · medio.
- **T-036 · Preguntas que suben** — memoria (v1: búsqueda de texto en `.forja/`) → planeador → usuario; guardar `D-*`. · T-020, T-031 · medio.
- **T-037 · Cola de merge** — orden topológico, suite completa, revertir y tarea de arreglo. · T-030, T-034 · medio.
- **T-038 · Reconciliación al arrancar** — PIDs, reanudar o relanzar, test con `kill -9`. · T-031, T-030 · planeador.
- **T-039 · Informe final** — tareas, intentos, escalados, costo, tests. · T-037 · barato.

## M4 · UI

- **T-040 · Servidor y layout** — Hono, JSX, htmx, SSE, token de sesión, modo oscuro, móvil. · T-014 · barato.
- **T-041 · Vista Flujo + Pendiente de ti** · T-040 · barato.
- **T-042 · Vista Planear** (chat + preguntas abiertas + visor de docs) · T-040, T-020 · medio.
- **T-043 · Vista Agentes** (tablero en vivo + detalle con log, paquete y diff) · T-040, T-031 · medio.
- **T-044 · Vista Tareas** (grafo por olas) · T-040, T-025 · barato.
- **T-045 · Vista Costos** · T-040, T-026 · barato.

## M5 · Bóveda

- **T-050 · Cifrado y archivos** — scrypt + AES-256-GCM, permisos 600, llavero del sistema o `FORJA_CLAVE_MAESTRA`, abrir y cerrar. · T-011 · planeador.
- **T-051 · Redactor** — valores, base64 y URL-encoded; en toda la salida; test de 0 fugas. · T-050 · medio.
- **T-052 · Conexiones y tipos** — cloudflare, smtp, postgres, ssh, http-api, github, genérico; probar. · T-050 · barato por tipo.
- **T-053 · Inyección por tarea** — entorno filtrado, políticas, `esperando_boveda`. · T-052, T-031 · medio.
- **T-054 · MCP por tarea** — config temporal para Claude y Codex; borrar al terminar. · T-053 · medio.
- **T-055 · Acciones externas** — propuesta, vista previa (dns.cambiar, correo.enviar primero), aprobación, ejecución, deshacer. · T-052 · planeador.
- **T-056 · Auditoría** · T-012 · barato.
- **T-057 · Vistas Bóveda y Auditoría en la UI** · T-040, T-052, T-056 · barato.

## M6 · Memoria

- **T-060 · Grafo en SQLite** — nodos, aristas, CTE de recorrido, PageRank. · T-012 · medio.
- **T-061 · Nodos desde spec, tareas, decisiones y lecciones** · T-060 · barato.
- **T-062 · tree-sitter** — archivos, símbolos, imports y llamadas para TS/JS, Go y Python; firmas. · T-060 · medio.
- **T-063 · Relevancia y paquete v2** — puntaje, presupuesto de tokens, refuerzo por utilidad. · T-061, T-062, T-032 · planeador.
- **T-064 · Lecciones** · T-035, T-061 · barato.
- **T-065 · Fase Analizar** — resúmenes incrementales por módulo, arquitectura actual. · T-062 · medio.
- **T-066 · Vista Memoria en la UI** · T-040, T-063 · barato.

## M7 · Publicar

- **T-070 · README y docs en inglés** (los de español se mantienen) · planeador.
- **T-071 · Ejemplo end-to-end** (`ejemplos/todo-api`) usado en CI con proveedores simulados · medio.
- **T-072 · Proveedor simulado** — reproduce fixtures para tests sin gastar tokens · barato.
- **T-073 · Empaquetado** — `npx forja`, binario opcional con bun · barato.
- **T-074 · CONTRIBUTING, código de conducta, plantillas de issue** · barato.
- **T-075 · Demo grabada** (GIF del tablero con 4 agentes) · —.
