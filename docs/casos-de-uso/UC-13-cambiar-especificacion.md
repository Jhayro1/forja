# UC-13 · Cambiar la especificación a mitad de camino

**Actor:** Usuario · **Reglas:** R-01

**Precondiciones:** plan aprobado, ejecución en curso o terminada.

## Flujo principal
1. El usuario pide el cambio al planeador (o edita `spec.json` o un documento generado).
2. El planeador produce el nuevo `spec.json`; se valida.
3. Forja calcula la diferencia por ID (UC, reglas, entidades, criterios añadidos, cambiados o quitados).
4. La memoria encuentra las tareas afectadas (aristas `implementa`, `aplica_regla`, `usa_entidad`, `verifica`).
5. Las tareas afectadas no iniciadas se regeneran; las corriendo se pausan; las ya unidas generan tareas de corrección.
6. Se regeneran los documentos cambiados.
7. Mini puerta: el usuario aprueba sólo lo que cambió.
8. La ejecución continúa.

## Flujos alternos
- **A1 · Cambio sólo de texto** (sin cambios de estructura): se regeneran los documentos; no se invalida ninguna tarea.
- **A2 · Caso de uso eliminado:** sus tareas pendientes se cancelan; las ya unidas generan una tarea de retiro, que también se aprueba.

## Excepciones
- **E1 · El cambio rompe contratos de la ola 0:** se avisa del alcance (n.º de tareas afectadas y costo estimado) antes de aprobar.

## Criterios de aceptación
- **CA-1** Dado un cambio en la regla R-03, cuando se calcula el impacto, entonces sólo se invalidan las tareas conectadas a R-03.
- **CA-2** Dado un cambio sólo de redacción, cuando se aplica, entonces ninguna tarea cambia de estado.
