# ADR-005 · Memoria en grafo sobre SQLite

**Estado:** aceptada · 2026-09-24

## Contexto

Cada trabajador necesita un contexto pequeño y preciso. Buscar sólo por texto o por
embeddings mezcla cosas parecidas pero irrelevantes; un grafo sigue relaciones reales
(esta tarea implementa este caso de uso, que aplica esta regla, sobre la que se tomó esta
decisión).

## Decisión

Grafo de nodos y aristas tipadas en **SQLite** (`memoria.db`), recorrido con CTE
recursivas, relevancia por peso de arista × distancia × centralidad × utilidad aprendida.
Construido casi sin tokens: spec, tareas y decisiones (ya estructurados) y código vía
tree-sitter. Embeddings (`sqlite-vec`) opcionales en una fase posterior.

## Alternativas descartadas

- **Neo4j u otra base de grafos**: otro servicio que instalar; innecesario para miles o
  decenas de miles de nodos.
- **Sólo embeddings**: sin relaciones explícitas, peor precisión, y cuesta tokens de embedding.
- **Construir el grafo con un LLM** que extraiga entidades de todo: caro y ruidoso cuando la
  mayor parte ya viene estructurada.

## Consecuencias

- La memoria es un **índice reconstruible**; la verdad sigue en el repo (ADR-008).
- Los paquetes de contexto son explicables: se puede ver por qué entró cada nodo.
