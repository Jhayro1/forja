# Producto, alcance y vocabulario

## Objetivo y experiencia completa

Un desarrollador crea o importa un proyecto, describe una necesidad y conversa con un planeador. Forja mantiene decisiones y dudas, genera una especificación revisable, propone un plan y su consumo esperado. Tras aprobarlo, ejecuta tareas aisladas, pide aclaraciones cuando faltan decisiones y entrega una rama con evidencia de verificación. El usuario puede observar, detener y recuperar el trabajo.

La selección de modelos favorece el menor costo total que cumpla la calidad necesaria. El planeador puede consultar código o ejemplos cuando hacen falta; los workers pueden pedir más contexto. Un modelo de mayor capacidad puede programar si la evidencia lo justifica.

## Entregas

| Entrega | Incluye | Deja para después |
|---|---|---|
| MVP usable, M0–M3 | Linux local, un usuario, TS/JS, proyectos separados, crear/importar, planificación incremental, documentos, CLI con tablero de terminal detallado, proveedor simulado, **Claude y Codex certificados con su catálogo de modelos**, **varias tareas en paralelo (N=3 por defecto)**, verificación, integración y recuperación | Panel web, producción externa, lenguajes adicionales, grafo de código avanzado |
| Beta funcional, M4 | Panel web local, presupuestos visibles, piloto de rendimiento y empaquetado | Conectores privilegiados y búsqueda semántica |
| Ampliación M5 | Bóveda y ejecutor aislado, un conector externo de prueba, aprobación y reconciliación | SSH arbitrario, migraciones productivas y catálogo amplio |
| Ampliación M6 | Índice sintáctico, grafo, análisis incremental ampliado, más lenguajes | Embeddings y utilidad aprendida si no muestran mejora |
| Futuro | Más conectores, extensión de editor, notificaciones opcionales, proveedores locales, equipos | No comprometer fechas antes de validar la beta |

Claude y Codex, con todos los modelos del catálogo inicial, forman parte del MVP (decisión del usuario, 2026-09-24). Si en M0 un proveedor no cumple autenticación y aislamiento, ese proveedor queda bloqueado con diagnóstico y alternativa, y el otro sigue; si ninguno cumple, sólo se entrega planificación y simulación hasta resolverlo. macOS, Windows nativo y WSL no se anuncian soportados sin su matriz de pruebas.

## Reglas de producto

El planeador acompaña activamente al usuario: explora cómo trabaja, identifica huecos y contradicciones y propone mejoras con sus consecuencias. Aplica tanto a ideas nuevas como a cambios existentes. El contrato y los prompts base están en [13 · Planeador proactivo](13-planeador-proactivo-y-prompts.md); una sugerencia sólo entra al alcance tras aceptación o delegación aplicable.

- R01: ejecutar exige aprobación vigente del plan y de su política efectiva.
- R02: sólo se aceptan cambios dentro del alcance aprobado; el SO protege recursos fuera del workspace.
- R03: tests, configuración de verificación y contratos protegidos no quedan bajo control del implementador.
- R04: credenciales de servicios externos no se entregan al agente; redacción es defensa adicional.
- R05: toda escritura externa requiere autorización específica y verificación de precondiciones.
- R06: las intenciones se persisten antes de actuar y los resultados sólo después de observarlos.
- R07: Forja entrega una rama local. Publicar, push y PR son acciones distintas, con autorización explícita.
- R08: pausar o archivar conserva datos; limpieza tiene selección, vista previa y confirmación propia.
- R09: interrupciones, cuota y presupuesto no son fallos de calidad ni disparan escalado.
- R10: privilegios se conceden por tarea/recurso/operación, nunca por precio o inteligencia del modelo.
- R11: una migración externa exige restauración ensayada y estrategia de recuperación evaluada.
- R12: evidencia y aprobación quedan ligadas a revisiones y commits exactos.

## Glosario

| Concepto | Definición |
|---|---|
| Proyecto / checkout | Identidad lógica versionada / copia local concreta; pueden existir dos clones del mismo proyecto |
| Cambio | Incremento de producto con requisitos, plan y revisión propios |
| Plan / tarea | DAG aprobado / unidad con objetivo, alcance, dependencias y criterios |
| Run | Ejecución de una revisión del plan |
| Intento / lanzamiento | Ciclo de resolución de una tarea / proceso concreto; reanudar crea lanzamiento sin incrementar el fallo de calidad |
| Runner | Supervisor local de un lanzamiento, sus recursos, logs y resultado |
| Verificada / integrada | Pasó sus controles / su resultado está en la integración y pasó la suite correspondiente |
| Lease / fencing token | Propiedad temporal / generación monotónica que impide aceptar resultados de un propietario obsoleto |
| Artefacto | Evidencia persistida con hash: contexto, diff, informe o resultado |
| Capacidad | Función demostrada de un adaptador y modo de autenticación |
| Desconocido | No se puede afirmar si una operación terminó; no equivale a fallo ni autoriza repetirla |

## Métricas y objetivos propuestos

Las metas de −70 % de tokens caros, ≥75 % sin escalado y tiempo ≤40 % de v1 pasan a ser hipótesis, no promesas.

Medir costo total por cambio aceptado, tokens por categoría, duración hasta integración, minutos de intervención humana, tasa de éxito, defectos detectados después y trabajo repetido por recuperación. No contar sólo tareas fáciles terminadas.

Criterios duros de la beta: cero dobles integraciones en la matriz de fallos; cero lanzamientos con aprobación obsoleta; ningún bypass en las pruebas negativas de aislamiento; ninguna fuga de los secretos canario ensayados. Estos criterios describen pruebas finitas, no garantía absoluta frente a cualquier ataque.

Objetivos iniciales de experiencia: actualización local p95 menor a 1 s y reconciliación p95 menor a 30 s para 3 runners y 100 tareas en la máquina de referencia documentada. Medirlos antes de publicarlos como prestaciones.
