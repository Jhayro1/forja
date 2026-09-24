# UC-10 · Recuperar tras una interrupción

**Actor:** Daemon · **Reglas:** R-06, R-09

**Precondiciones:** el daemon arranca y existen proyectos con trabajo sin terminar.

## Flujo principal
1. El daemon adquiere el lock de cada proyecto activo.
2. Reconstruye las proyecciones si hace falta.
3. Para cada tarea en `corriendo`, `verificando` o `uniendo`:
   1. comprueba si el PID vive y es el mismo proceso (comando y hora de inicio);
   2. si vive, vuelve a vincularse a su salida;
   3. si no, registra `tarea.interrumpida` y la reanuda (sesión del CLI) o la relanza (paquete + diff de la rama + «continúa»).
4. Retoma la cola de merge comprobando en git si el último merge terminó.
5. Retoma la sesión del planeador si había una conversación abierta.
6. Informa: «Recuperado: N tareas retomadas, M reanudadas, 0 perdidas».

## Flujos alternos
- **A1 · Parada ordenada previa (`forja parar`):** no hay procesos huérfanos; sólo se relanza lo pendiente.
- **A2 · Worktree sin tarea conocida:** se lista en el informe como huérfano; **no se borra**.
- **A3 · El usuario prefiere no retomar:** `forja serve --sin-reanudar` deja todo en `pausada`.

## Excepciones
- **E1 · `estado.db` dañado:** se abre en solo lectura, se intenta recuperar desde el WAL y, si no se puede, se informa con el error tal cual y se sugiere restaurar la copia automática diaria.
- **E2 · Lock en poder de otro proceso vivo:** no se toca ese proyecto y se avisa del PID.
- **E3 · La rama de la tarea desapareció:** la tarea vuelve a `lista` desde cero, y se registra el motivo.

## Criterios de aceptación
- **CA-1** Dadas 3 tareas corriendo, cuando hago `kill -9` al daemon y lo vuelvo a levantar, entonces las 3 terminan y ninguna repite el trabajo desde cero si tenía commits `wip`.
- **CA-2** Dada una interrupción, cuando se relanza la tarea, entonces su contador de intentos no aumenta.
- **CA-3** Dado un worktree huérfano, cuando arranca el daemon, entonces sigue existiendo y aparece en el informe.
