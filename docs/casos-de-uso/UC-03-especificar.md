# UC-03 · Generar la especificación

**Actores:** Planeador, Generador · **Reglas:** R-06

**Precondiciones:** `descubrimiento.md` aprobado.

## Flujo principal
1. Forja pide al planeador `spec.json` con el esquema de [formatos/spec-json.md](../formatos/spec-json.md) (salida estructurada).
2. El generador valida tipos y reglas de completitud.
3. Sin huecos: renderiza documentos, `.feature`, trazabilidad, glosario, modelo de datos y plan de pruebas.
4. Crea o actualiza los nodos de especificación en la memoria.
5. Muestra un resumen: n.º de casos de uso, reglas, entidades y criterios, más los enlaces a los documentos.

## Flujos alternos
- **A1 · Hay huecos:** el generador envía al planeador sólo la lista de huecos con su fragmento; fusiona la respuesta; vuelve a 2 (máximo 3 vueltas).
- **A2 · Regenerar sin cambios:** los hashes coinciden y no se toca ningún archivo (0 tokens).
- **A3 · Un documento fue editado a mano:** se escribe `archivo.nuevo.md` y se avisa.
- **A4 · `--con-prosa`:** se pide además la prosa de visión e introducción.

## Excepciones
- **E1 · Tras 3 vueltas siguen los huecos:** se listan al usuario para que decida o complete.
- **E2 · JSON inválido dos veces seguidas:** se guarda la respuesta cruda para depurar y se informa el error tal cual.

## Postcondiciones
`spec.json` válido y documentos generados, trazables por ID.

## Criterios de aceptación
- **CA-1** Dado un spec con un caso de uso sin excepciones, cuando se valida, entonces se pide al planeador sólo ese hueco y el prompt enviado no incluye el resto del spec.
- **CA-2** Dado un spec sin cambios, cuando ejecuto `forja especificar` otra vez, entonces no se llama a ningún modelo y no cambia ningún archivo.
- **CA-3** Dado un criterio CA en el spec, cuando se generan los documentos, entonces existe un escenario `.feature` y un test pendiente con su ID.
