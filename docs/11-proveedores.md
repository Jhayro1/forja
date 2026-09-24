# 11 · Proveedores (adaptadores)

Forja no llama a las APIs de los modelos: **maneja los CLI oficiales** que el usuario ya
tiene instalados y logueados con su suscripción. Ver [ADR-003](decisiones/ADR-003-suscripciones-via-cli.md).

## Interfaz común

```ts
interface Proveedor {
  id: 'claude' | 'codex' | string;
  detectar(): Promise<{ instalado: boolean; version?: string; sesionActiva: boolean }>;
  modelos(): Promise<string[]>;                       // los que acepta --model
  ejecutar(p: Peticion, señal: AbortSignal): AsyncIterable<Evento>;
  reanudar(sesionId: string, p: Peticion, señal: AbortSignal): AsyncIterable<Evento>;
}

interface Peticion {
  modelo: string;
  cwd: string;                     // worktree de la tarea
  prompt: string;                  // paquete de contexto + instrucción
  esquemaSalida?: JSONSchema;      // para planeador / revisor
  herramientas: { permitir: string[]; denegar: string[] };
  red: boolean;
  mcpConfig?: string;              // ruta temporal (600)
  entorno: Record<string, string>; // ya filtrado por la bóveda
  presupuestoUsd?: number;
}

type Evento =
  | { t: 'inicio'; sesionId: string }
  | { t: 'texto'; delta: string }
  | { t: 'herramienta'; nombre: string; resumen: string }
  | { t: 'uso'; entrada: number; salida: number; cacheLeida: number; cacheEscrita: number; costoEq?: number }
  | { t: 'limite'; hastaAprox?: string }   // límite de suscripción alcanzado
  | { t: 'fin'; ok: boolean; salidaFinal?: string; json?: unknown }
  | { t: 'error'; mensaje: string; reintentable: boolean };
```

## Claude Code

Flags verificados en este servidor con `claude --help`:

| Necesidad | Flag |
|----------|------|
| No interactivo | `-p / --print` |
| Salida en streaming parseable | `--output-format stream-json` (+ `--verbose` si hace falta) |
| Salida estructurada (planeador, revisor) | `--json-schema <schema>` |
| Modelo | `--model <modelo>` |
| Reanudar sesión | `--resume <session-id>` |
| Herramientas | `--allowedTools`, `--disallowedTools` |
| MCP por tarea | `--mcp-config <archivo>` |
| Instrucciones de sistema | `--append-system-prompt` |
| Tope de gasto (sólo con API key) | `--max-budget-usd` |

Pendiente para el spike (T-001): modo de permisos no interactivo apropiado, formato
exacto de los eventos de uso y de «límite alcanzado», y evaluar el **Claude Agent SDK**
(TypeScript) como alternativa a parsear la salida del CLI.

## Codex

Flags verificados con `codex exec --help`:

| Necesidad | Flag |
|----------|------|
| No interactivo | `codex exec` |
| Salida en streaming parseable | `--json` |
| Salida estructurada | `--output-schema <archivo>` |
| Último mensaje a archivo | `-o / --output-last-message <archivo>` |
| Modelo | `-m / --model` (sol, Astra, etc.) |
| Directorio | `-C / --cd <dir>` |
| Sandbox | `-s / --sandbox <modo>` |
| Reanudar | subcomando `codex exec resume <id>` |

Pendiente para el spike: cómo pasar servidores MCP por ejecución (configuración con
`-c` o un `CODEX_HOME` temporal), formato de uso de tokens y de límites.

## Elección de proveedor por tarea

1. El nivel de la tarea da una lista ordenada de `proveedor:modelo`.
2. Se saltan los proveedores en pausa por límite o sin sesión activa.
3. Opcional: `preferir_diversidad: true` hace que el **revisor** sea de otro proveedor
   que el autor (Codex revisa a Claude y viceversa), porque así se detectan más errores.

## Añadir un proveedor

Un paquete que implemente `Proveedor`, más su parser de eventos y sus pruebas con
grabaciones reales (`fixtures/*.jsonl`). Candidatos de la comunidad: Gemini CLI,
OpenCode, Aider y modelos locales vía Ollama.
