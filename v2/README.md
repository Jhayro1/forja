# Forja · Plan y especificación v2

Fecha de revisión: **24 de septiembre de 2026**. Estado: **propuesta de diseño para implementar**, sin código ni validaciones experimentales ejecutadas. Esta versión es autónoma y sustituye las recomendaciones de v1 para el desarrollo futuro; los originales permanecen intactos.

Forja será un orquestador local y abierto que convierte una idea o mejora en un plan aprobado, ejecuta tareas con agentes de código, verifica sus resultados y prepara una rama integrada. Su valor es controlar el trabajo, recuperarlo y demostrar qué quedó hecho, con uso eficiente de modelos y contexto.

La idea original es viable como dirección de producto. Antes de desarrollar la ejecución real hay que demostrar aislamiento, autenticación de los CLI y recuperación de procesos. No basta con envolver comandos y ponerles una cola.

> **Estado:** M0 en curso. Resultados reales en [../m0/RESULTADOS.md](../m0/RESULTADOS.md).

> **¿Primera vez? Empieza por [LEEME-PRIMERO.md](LEEME-PRIMERO.md)**: todo el plan en lenguaje llano, en 5 minutos.

## Ruta de lectura

| Documento | Contenido |
|---|---|
| [Léeme primero](LEEME-PRIMERO.md) | Resumen legible de todo el plan |
| [00 · Diagnóstico](00-diagnostico.md) | Qué conservar, errores concretos y correcciones priorizadas |
| [01 · Investigación](01-investigacion-y-fuentes.md) | Prácticas actuales y fuentes primarias consultadas |
| [02 · Producto y alcance](02-producto-y-alcance.md) | Visión completa, MVP, glosario y métricas |
| [03 · Arquitectura](03-arquitectura.md) | Componentes, decisiones tecnológicas, almacenamiento y proyectos |
| [04 · Flujo](04-flujo-y-especificacion.md) | Planificación, generación, aprobaciones y cambios |
| [05 · Ejecución](05-ejecucion-y-recuperacion.md) | Estados, procesos, concurrencia, recuperación y merge |
| [06 · Seguridad](06-seguridad-y-conexiones.md) | Fronteras de confianza, bóveda, MCP y acciones externas |
| [07 · Proveedores y costos](07-proveedores-y-costos.md) | Adaptadores, capacidades, medición y presupuestos |
| [08 · Contexto](08-contexto-y-memoria.md) | Análisis existente, memoria, paquetes e invalidación |
| [09 · Calidad](09-verificacion-y-evaluaciones.md) | Pruebas, criterios de entrega y evaluación económica |
| [10 · Interfaz](10-cli-ui-y-api.md) | CLI, UI, API local, SSE y errores |
| [11 · Roadmap](11-roadmap-y-backlog.md) | Hitos, dependencias y tareas verificables |
| [12 · Riesgos](12-riesgos-y-listo-para-empezar.md) | Bloqueos, decisiones pendientes y primer trabajo autorizado futuro |
| [13 · Planeador proactivo](13-planeador-proactivo-y-prompts.md) | Acompañamiento de ideas y mejoras, prompts internos, cobertura y ejemplos de conversación |
| [Casos de uso](casos-de-uso.md) | Los 14 casos originales revisados y casos adicionales |
| [Decisiones](decisiones.md) | ADR v2, alternativas y consecuencias |
| [Formatos](formatos/README.md) | Contratos de documentos, ejecución y protocolos |
| [Trazabilidad](trazabilidad.md) | Correspondencia completa con los documentos v1 |

## Cambios esenciales

1. Seguridad desde el primer trabajador: un worktree organiza archivos, no constituye un sandbox.
2. Recuperación con intención, confirmación y reconciliación; se reconoce el resultado desconocido y el posible costo repetido.
3. Dependencias disponibles sólo después de integrar y verificar su commit.
4. Aprobaciones vinculadas a hashes de contenido, política y revisión; ningún resultado obsoleto se integra.
5. Secretos externos en un ejecutor separado, fuera del entorno del agente.
6. Enrutamiento por calidad, riesgo y costo total observado; los nombres de modelos son configuración validada.
7. MVP acotado: Linux, un usuario, proyectos TS/JS, **Claude y Codex con su catálogo de modelos**, **varias tareas en paralelo**, **tablero de terminal detallado**, contexto simple. Panel web en M4.
8. Proveedor simulado, pruebas de caída y límites de recursos desde el núcleo.
9. Planeador proactivo desde el MVP: descubre omisiones, propone alternativas y ayuda a aclarar la idea con prompts versionados y criterios de evaluación.

## Ajustes pedidos por el usuario (2026-09-24)

| # | Ajuste | Dónde |
|---|---|---|
| A1 | Paralelismo **entre tareas** desde el MVP (N=3 por defecto); distinto de los subagentes que un CLI lanza dentro de una sola tarea | [05](05-ejecucion-y-recuperacion.md#paralelismo-entre-tareas-mvp-d2-16), D2-16, V2-007, V2-033 |
| A2 | Terminal primero, con tablero detallado y fácil de usar; web en M4 | [10](10-cli-ui-y-api.md#tablero-de-terminal-mvp), D2-17, V2-039 |
| A3 | Resumen legible | [LEEME-PRIMERO.md](LEEME-PRIMERO.md) |
| A4 | Claude **y** Codex funcionales desde el MVP con todos sus modelos (fable, opus, sonnet, haiku; gpt-6-astra, gpt-6-sol, gpt-6-luna) | [07](07-proveedores-y-costos.md#catálogo-inicial-de-modelos), D2-18, V2-006, V2-018 |

El resto de elecciones de alcance son recomendaciones de la revisión v2, no preferencias atribuidas al usuario. Los contratos están definidos para comenzar por M0; los resultados de ese hito decidirán qué adaptadores y aislamiento pueden habilitarse.
