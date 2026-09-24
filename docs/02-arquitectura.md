# 02 · Arquitectura

## Vista general

```
                         ┌───────────────────────────────┐
  tú ── terminal ──────► │  forja (CLI)                  │
  tú ── navegador ─────► │  UI web  http://localhost:7777│
  (futuro) VS Code ────► │  extensión = otra vista        │
                         └──────────────┬────────────────┘
                                        │ HTTP + SSE (local, token de sesión)
                         ┌──────────────▼────────────────┐
                         │  forja serve  (daemon)         │
                         │                                │
                         │  ┌──────────┐  ┌────────────┐  │
                         │  │Orquestador│  │ Planeador  │  │  ← conversación con modelo caro
                         │  │(scheduler)│  │ (sesiones) │  │
                         │  └────┬─────┘  └─────┬──────┘  │
                         │       │              │         │
                         │  ┌────▼──────────────▼──────┐  │
                         │  │ Adaptadores de proveedor │  │  claude -p │ codex exec
                         │  └────┬─────────────────────┘  │
                         │       │ procesos hijos          │
                         │  ┌────▼───┐ ┌────────┐ ┌─────┐  │
                         │  │ W1 wt1 │ │ W2 wt2 │ │ ... │  │  un worktree por tarea
                         │  └────────┘ └────────┘ └─────┘  │
                         │                                │
                         │  Estado (eventos)  Memoria (grafo)  Bóveda (cifrada)
                         │  estado.db         memoria.db       boveda.enc
                         └────────────────────────────────┘
```

## Componentes

| Componente | Responsabilidad | Usa LLM |
|-----------|-----------------|---------|
| **CLI** | Comandos del usuario; habla con el daemon y lo levanta si no está corriendo. | No |
| **Daemon** (`forja serve`) | Aloja todo lo demás; un solo proceso por máquina, con varios proyectos. | No |
| **Planeador** | Gestiona las conversaciones con el modelo caro (Descubrir, Especificar, Dividir, preguntas que suben). | Sí, nivel alto |
| **Generador** | Valida `spec.json` con esquemas y renderiza plantillas a `.md`, `.feature` y `.yaml`. | No |
| **Orquestador** | Calcula olas, lanza trabajadores, vigila, reintenta, escala y encola merges. | No |
| **Adaptadores** | Traducen «ejecuta esta tarea con este nivel» a un comando de CLI concreto y leen su salida en streaming (tokens, costo, herramientas usadas, fin, error, límite). | — |
| **Verificador** | Corre build, lint y tests; lanza el revisor barato; decide si la tarea pasa, reintenta o escala. | Sólo el revisor |
| **Cola de merge** | Integra ramas en orden, resuelve conflictos triviales y pide ayuda si no puede. | Sólo si hay conflicto |
| **Memoria** | Grafo de conocimiento; arma paquetes de contexto; indexa código con tree-sitter. | No (salvo nodos de decisión) |
| **Estado** | Guarda los eventos y las proyecciones (tareas, agentes, costos) en SQLite. | No |
| **Bóveda** | Guarda secretos y conexiones cifrados; los resuelve e inyecta al lanzar procesos; redacta la salida. | No |
| **Servidor web** | API, SSE para lo que ocurre en vivo, y la UI renderizada en el servidor. | No |

## Tecnología

| Pieza | Elección | Motivo |
|------|----------|--------|
| Lenguaje | TypeScript, Node 24 LTS | [ADR-001](decisiones/ADR-001-lenguaje.md) |
| Base de datos | `node:sqlite` (incluido en Node, sin dependencias nativas), modo WAL | Comprobado en este servidor: Node v24.18.0 → SQLite 3.53.1 |
| Servidor HTTP | Hono | Ligero, tipado, JSX en el servidor |
| UI | JSX renderizado en el servidor + htmx + SSE | Sin build de SPA; fácil de contribuir |
| Esquemas | Zod → JSON Schema | Una sola definición valida la salida del LLM y genera la documentación de formatos |
| Plantillas | Funciones TS con template literals (o Eta) | Sin lenguaje extra |
| Análisis de código | `web-tree-sitter` (WASM) | Sin compilación nativa, muchos lenguajes |
| Cifrado | `node:crypto`: scrypt + AES-256-GCM | Sin dependencias |
| Git | `git` del sistema (worktree, branch, merge) | Lo que ya usa cualquiera |
| Distribución | `npm i -g forja` / `npx forja`; binario opcional con `bun build --compile` | Quien usa Claude Code o Codex ya tiene Node |

## Estructura del repositorio (monorepo pnpm)

```
forja/
  packages/
    core/          eventos, estado, proyecciones, scheduler, escalera, presupuestos
    planeador/     sesiones con el modelo caro, prompts versionados
    generador/     esquemas zod, plantillas, render de docs
    proveedores/   claude/, codex/, interfaz común, parser de stream-json
    memoria/       grafo, tree-sitter, armado de paquetes de contexto
    boveda/        cifrado, conexiones, MCP, redactor
    verificador/   perfiles de proyecto, runners, revisor
    servidor/      API Hono, SSE, UI (JSX + htmx)
    cli/           comandos, arranque del daemon
  prompts/         prompts del planeador y de los trabajadores (versionados, con hash)
  plantillas/      plantillas de documentos
  docs/            esta documentación
  ejemplos/        proyectos de ejemplo para demos y pruebas end-to-end
```

## Dónde vive cada cosa

```
~/.forja/                          ← HOME de Forja (fuera de cualquier repo)
  config.yaml                      preferencias globales (puerto, idioma, notificaciones)
  registro.db                      proyectos conocidos: id, nombre, ruta
  boveda/global.enc                secretos globales (cifrados)
  proyectos/<id>/
    estado.db                      eventos + proyecciones del proyecto
    memoria.db                     grafo (reconstruible)
    boveda.enc                     secretos del proyecto (cifrados)
    sesiones/                      transcripciones del planeador (redactadas)
    logs/<tarea>/<intento>.jsonl   salida de cada trabajador (redactada)
    worktrees/<tarea>/             worktrees de git
    auditoria.jsonl                acciones externas y uso de secretos

<repo>/                            ← TU proyecto
  forja.yaml                       configuración del proyecto (sin secretos)
  .forja/
    spec.json                      decisiones estructuradas (la verdad)
    docs/                          documentos generados desde spec.json
    tareas/T-*.yaml                tareas generadas
    decisiones/D-*.md              decisiones tomadas durante la ejecución
    lecciones/L-*.md               lecciones aprendidas
```

La razón de esta división está en [ADR-008](decisiones/ADR-008-repo-es-la-verdad.md):
lo que se **decide** va al repo y se versiona; lo que es **ejecución**
(estado, logs, worktrees, secretos) va al HOME de Forja.

## Procesos

- **Un daemon por máquina.** Si el CLI no lo encuentra, lo levanta en segundo plano. En
  servidores se puede instalar como unidad de systemd (`forja servicio instalar`).
- **Un proceso hijo por trabajador**, con su propio `cwd` (el worktree), su entorno
  (secretos permitidos) y su configuración MCP temporal.
- **Un bloqueo por proyecto** (`estado.db` + archivo lock con PID) impide que dos
  orquestadores ejecuten el mismo proyecto a la vez.
