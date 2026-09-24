# UC-08 · Analizar código existente

**Actor:** Usuario · **Reglas:** R-06

**Precondiciones:** proyecto importado (UC-01 A1).

## Flujo principal
1. El usuario ejecuta `forja analizar`.
2. tree-sitter indexa archivos, símbolos, imports y llamadas → grafo de código (0 tokens).
3. Se detecta el perfil (stack y comandos) y se prueban build y test.
4. Un modelo barato resume cada módulo cuyo hash cambió (≤ 5 líneas cada uno).
5. El planeador lee los resúmenes y el grafo agregado, y devuelve (en JSON) la arquitectura, las convenciones y la deuda técnica.
6. Se generan `arquitectura-actual.md` y `convenciones.md`, y el perfil se guarda en `forja.yaml`.
7. Se ofrece `forja planear` para definir la mejora (UC-02 A2).

## Flujos alternos
- **A1 · Análisis repetido:** sólo se resumen los módulos cambiados; si ninguno cambió, 0 tokens.
- **A2 · Lenguaje sin gramática tree-sitter disponible:** se indexa a nivel de archivo (sin símbolos) y se avisa.
- **A3 · Repo enorme:** se respetan `.gitignore` y `forja.yaml › analizar.excluir`; se muestra el progreso.

## Excepciones
- **E1 · Los comandos de build o test del perfil fallan:** se registra como deuda técnica y se pregunta al usuario el comando correcto; no bloquea el análisis.
- **E2 · Archivos que parecen secretos (`.env`, llaves):** no se leen ni se resumen; se avisa.

## Criterios de aceptación
- **CA-1** Dado un repo ya analizado sin cambios, cuando ejecuto `forja analizar`, entonces no se llama a ningún modelo.
- **CA-2** Dado un `.env` en el repo, cuando se analiza, entonces su contenido no aparece en ningún resumen ni prompt.
- **CA-3** Dado un repo TypeScript, cuando se analiza, entonces `forja memoria buscar <función>` devuelve el archivo que la define.
