# ADR-001 · Lenguaje: TypeScript sobre Node 24

**Estado:** aceptada · 2026-09-24

## Contexto

Se evaluaron Go, Rust y TypeScript. Lo que hace Forja es **esperar**: lanza procesos que
tardan minutos, lee su salida, guarda eventos y sirve una UI. El trabajo pesado lo hacen
los modelos. No hay cálculo intensivo en la herramienta.

## Decisión

**TypeScript sobre Node 24 LTS.**

## Por qué no Go ni Rust

| Criterio | TypeScript | Go | Rust |
|----------|-----------|----|------|
| Velocidad en lo que importa (I/O, procesos) | Suficiente | Suficiente | Suficiente |
| SDK oficiales del ecosistema (Claude Agent SDK, Codex SDK, MCP SDK) | **Primera clase** | Parcial o de la comunidad | Parcial o de la comunidad |
| Validar la salida del LLM con esquemas y generar JSON Schema | **zod**, muy maduro | Posible, con más código | Posible, con más código |
| UI web en el mismo lenguaje | **Sí** | No (plantillas aparte) | No |
| Contribuidores potenciales en herramientas de IA | **Los más numerosos** | Muchos | Menos |
| Lo que ya conoce el autor (ERP en TS) | **Sí** | No | No |
| Distribución | npm/npx (quien usa Claude Code o Codex ya tiene Node); binario opcional con `bun build --compile` | Binario único | Binario único |
| Velocidad de desarrollo | **Alta** | Alta | Media-baja |

Rust no aporta nada medible aquí y duplica el tiempo de desarrollo. Go gana sólo en
distribución (un binario), y eso se cubre razonablemente con `npx` y con un binario
compilado con Bun.

## Consecuencias

- SQLite con `node:sqlite` (incluido en Node, **sin dependencias nativas**). Comprobado en
  el servidor de desarrollo: Node v24.18.0 trae SQLite 3.53.1.
- Evitar dependencias nativas en general (tree-sitter en WASM y cifrado con `node:crypto`),
  para que `npx forja` funcione en cualquier sistema sin compilar.
- Requisito mínimo: Node 24. `forja doctor` lo verifica.
- Si algún componente llega a necesitar rendimiento (por ejemplo, indexar repos enormes), se
  puede aislar como binario auxiliar sin cambiar el resto.
