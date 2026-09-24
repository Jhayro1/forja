# 06 · Memoria en grafo

## Para qué sirve

Para responder rápido y sin LLM a **«¿qué necesita saber este agente para hacer esta
tarea?»**. El grafo no hace más rápido al modelo: hace que reciba **menos y mejor**
contexto, y eso lo abarata y lo hace acertar más.

## Modelo

**Nodos** (cada uno es un tema):

| Tipo | Ejemplo | Origen | Tokens para crearlo |
|------|---------|--------|---------------------|
| `caso_uso` | UC-001 Registrar venta | spec.json | 0 |
| `regla` | R-03 IGV por ítem | spec.json | 0 |
| `entidad` | Venta, Cliente | spec.json | 0 |
| `criterio` | UC-001/CA-2 | spec.json | 0 |
| `tarea` | T-014 POST /ventas | tareas/*.yaml | 0 |
| `archivo` | src/ventas/crear.ts | tree-sitter | 0 |
| `simbolo` | función `crearVenta` | tree-sitter | 0 |
| `modulo` | src/ventas | tree-sitter + resumen barato | bajo |
| `decision` | D-07 redondeo mitad hacia arriba | conversación | bajo |
| `leccion` | L-02 los tests necesitan TZ=UTC | fallo resuelto | bajo |
| `termino` | «fiado» | spec.json | 0 |
| `conexion` | cloudflare-principal | bóveda (sólo el nombre, nunca el valor) | 0 |

**Aristas** (con nombre y peso base):

| Arista | De → a | Peso base |
|--------|--------|-----------|
| `aplica_regla` | caso_uso → regla | 1.0 |
| `decide_sobre` | decision → regla / caso_uso / archivo | 1.0 |
| `implementa` | tarea → caso_uso | 0.9 |
| `verifica` | criterio → caso_uso | 0.9 |
| `toca` | tarea → archivo | 0.9 |
| `usa_entidad` | caso_uso → entidad | 0.8 |
| `depende_de` | tarea → tarea | 0.7 |
| `define` | archivo → simbolo | 0.6 |
| `llama` | simbolo → simbolo | 0.5 |
| `importa` | archivo → archivo | 0.4 |
| `aprendida_en` | leccion → archivo / modulo | 0.8 |
| `requiere` | tarea / integración → conexion | 1.0 |

## Relevancia

Para una tarea `t`, el puntaje de un nodo `n` alcanzado por el camino `c`:

```
puntaje(n) = Π peso(aristas de c)       ← el camino: más saltos y aristas débiles restan
           × (1 + 0.5·centralidad(n))   ← PageRank precalculado: lo que todo el mundo usa importa
           × (1 + utilidad(n))          ← refuerzo: nodos presentes cuando una tarea pasó sus tests
           × fijado(n) ? 3 : 1          ← el usuario o el planeador pueden fijar nodos
```

- Recorrido de 2 saltos por defecto (3 para tareas de nivel medio o superior).
- `utilidad` sube cuando un nodo estaba en el paquete de una tarea aprobada al primer
  intento, y baja lentamente con el tiempo.
- Todo se calcula en SQLite con CTE recursivas: milisegundos para grafos de decenas de
  miles de nodos. No hace falta Neo4j.

## El paquete de contexto

```
┌─ PREFIJO ESTABLE (se cachea en el proveedor) ────────────────┐
│ convenciones del proyecto · perfil (comandos) · glosario       │
├─ TAREA ───────────────────────────────────────────────────────┤
│ T-014: objetivo, archivos permitidos, tests que deben pasar    │
├─ CONOCIMIENTO (ordenado por puntaje, hasta el presupuesto) ───┤
│ UC-001 (pasos, excepciones) · R-03 · D-07 · L-02               │
├─ CÓDIGO ──────────────────────────────────────────────────────┤
│ firmas de los contratos de los que depende (no archivos enteros)│
│ archivos a modificar (completos, si caben)                      │
└────────────────────────────────────────────────────────────────┘
          presupuesto por defecto: 12k tokens (barato), 25k (medio)
```

Reglas:
- De los archivos que **no** toca, sólo van **firmas**, extraídas con tree-sitter.
- Si algo no cabe, se incluye su **resumen** y el trabajador puede leerlo si lo necesita.
- El paquete se guarda por intento (hash) para depurar «¿qué sabía el agente?».

## Búsqueda por significado (fase posterior)

Cuando la pregunta no nombra un nodo («¿dónde se calcula el descuento?»), se usan
embeddings con `sqlite-vec` para encontrar los nodos de entrada y desde ahí se
recorre el grafo. Es opcional; el MVP funciona sin esto.

## Reconstrucción

`memoria.db` es un **índice**: se reconstruye con `forja memoria reconstruir` desde
`spec.json`, `tareas/`, `decisiones/`, `lecciones/` (todo en el repo) y el código
(tree-sitter). Lo único que no se reconstruye es la `utilidad` aprendida, y se puede
exportar a `memoria-pesos.json` si se quiere versionar.
