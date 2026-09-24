# UC-07 · Unir resultados

**Actor:** Cola de merge · **Reglas:** R-07

**Precondiciones:** tareas aprobadas en la cola.

## Flujo principal
1. Toma la siguiente tarea aprobada en orden topológico.
2. Hace merge de `forja/T-xxx` en `forja/integracion`.
3. Corre la suite completa del perfil.
4. Si pasa: evento `tarea.unida`; se desbloquean sus dependientes.
5. Al terminar todas: informe final y la opción de abrir un PR a la rama principal.

## Flujos alternos
- **A1 · Conflicto trivial** (imports, listas, lockfile): se resuelve con código y se vuelve a 3.
- **A2 · Conflicto real:** tarea `resolver-conflicto` de nivel medio con los dos lados y los criterios.
- **A3 · El usuario pide PR:** `gh pr create` desde `forja/integracion` con el informe como descripción.

## Excepciones
- **E1 · La suite se rompe tras el merge:** se revierte ese merge y se crea `arreglo-integracion` (nivel medio) con la salida del fallo.
- **E2 · La rama principal avanzó mientras tanto:** se hace rebase de `forja/integracion` antes del PR; si hay conflicto, sigue A2.

## Criterios de aceptación
- **CA-1** Dado un merge que rompe un test que antes pasaba, cuando se verifica la suite, entonces el merge se revierte y existe una tarea `arreglo-integracion`.
- **CA-2** Dado que terminan todas las tareas, cuando finaliza la cola, entonces la rama principal no fue modificada por Forja.
