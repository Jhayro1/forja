# Casos de uso de Forja

Formato de cada caso: actor, precondiciones, flujo principal, flujos alternos (A),
excepciones (E), postcondiciones y criterios de aceptación (CA) en Given/When/Then.
Cuando exista el generador, estos archivos saldrán de `spec.json` con plantillas.

| ID | Caso de uso | Actor | Hito |
|----|-------------|-------|------|
| [UC-01](UC-01-crear-o-importar-proyecto.md) | Crear o importar un proyecto | Usuario | M1 |
| [UC-02](UC-02-descubrir.md) | Descubrir con el planeador | Usuario, Planeador | M2 |
| [UC-03](UC-03-especificar.md) | Generar la especificación | Planeador, Generador | M2 |
| [UC-04](UC-04-dividir-y-aprobar.md) | Dividir en tareas y aprobar el plan | Planeador, Usuario | M2 |
| [UC-05](UC-05-ejecutar.md) | Ejecutar tareas en paralelo | Orquestador | M3 |
| [UC-06](UC-06-verificar-y-escalar.md) | Verificar y escalar una tarea | Verificador | M3 |
| [UC-07](UC-07-unir.md) | Unir resultados | Cola de merge | M3 |
| [UC-08](UC-08-analizar-codigo-existente.md) | Analizar código existente | Usuario | M6 |
| [UC-09](UC-09-preguntas-que-suben.md) | Responder preguntas que suben | Trabajador, Planeador, Usuario | M3 |
| [UC-10](UC-10-recuperar.md) | Recuperar tras una interrupción | Daemon | M3 |
| [UC-11](UC-11-gestionar-conexiones.md) | Gestionar conexiones, secretos y MCP | Usuario | M5 |
| [UC-12](UC-12-aprobar-accion-externa.md) | Aprobar una acción externa | Usuario | M5 |
| [UC-13](UC-13-cambiar-especificacion.md) | Cambiar la especificación a mitad de camino | Usuario | M3 |
| [UC-14](UC-14-ver-agentes-y-costos.md) | Ver agentes, flujo y costos | Usuario | M4 |

## Reglas de negocio transversales

| ID | Regla |
|----|-------|
| R-01 | Nada pasa a Ejecutar sin aprobación explícita del plan. |
| R-02 | Un trabajador sólo puede modificar los archivos que su tarea declara. |
| R-03 | Las tareas de implementación no pueden modificar los tests de aceptación. |
| R-04 | Un secreto nunca aparece en un prompt, log, transcripción, commit ni en la UI. |
| R-05 | Una acción externa se ejecuta sólo tras aprobación explícita, válida para esa acción concreta. |
| R-06 | Todo cambio de estado se persiste como evento antes de tener efecto. |
| R-07 | Nunca se hace merge ni push a la rama principal sin aprobación. |
| R-08 | Ningún comando borra datos de un proyecto; archivar no borra. |
| R-09 | Una interrupción no cuenta como fallo ni sube la escalera. |
| R-10 | Un trabajador no recibe ninguna conexión que su tarea no declare. |
| R-11 | Las migraciones de base de datos externas exigen copia verificada y plan de vuelta atrás. |
