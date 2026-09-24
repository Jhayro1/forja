# UC-12 · Aprobar una acción externa

**Actor:** Usuario · **Reglas:** R-05, R-11

**Precondiciones:** una tarea o el planeador propuso una acción (`dns.cambiar`, `correo.enviar`, `db.migrar`, `deploy`, `ssh.ejecutar`…).

## Flujo principal
1. Forja recibe la propuesta y la valida contra los permisos de la conexión.
2. Genera una **vista previa real**: por ejemplo, lee los registros DNS actuales y calcula el antes y después.
3. La pone en «Pendiente de ti» y envía una notificación.
4. El usuario revisa y aprueba.
5. Forja guarda el estado anterior (para deshacer), ejecuta la acción y **verifica** el resultado (p. ej. vuelve a leer el registro).
6. Registra todo en la auditoría y avisa del resultado a la tarea.

## Flujos alternos
- **A1 · Rechazar:** la tarea recibe el rechazo con el motivo y decide otra vía o se bloquea.
- **A2 · Editar antes de aprobar:** el usuario ajusta un valor; se regenera la vista previa.
- **A3 · Deshacer:** `forja accion deshacer <id>` restaura el estado guardado (si el tipo lo permite) y también pide aprobación.

## Excepciones
- **E1 · `db.migrar` sin copia de seguridad verificada o sin plan de vuelta atrás:** la acción no se ofrece para aprobar; se indica qué falta.
- **E2 · El estado externo cambió entre la vista previa y la ejecución:** se aborta y se regenera la vista previa.
- **E3 · Falla la ejecución:** se informa el error tal cual; si hubo un cambio parcial, se ofrece deshacer.
- **E4 · La acción borra algo:** siempre pide aprobación aunque la política diga otra cosa.

## Criterios de aceptación
- **CA-1** Dada una propuesta `dns.cambiar`, cuando la veo, entonces aparece una tabla con los registros actuales y los propuestos.
- **CA-2** Dada una aprobación de la acción A, cuando la tarea propone otra acción B del mismo tipo, entonces B también pide aprobación.
- **CA-3** Dada una propuesta `db.migrar` sin copia verificada, cuando intento aprobarla, entonces no hay botón de aprobar y se indica que falta la copia.
