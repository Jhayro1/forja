# UC-05 · Ejecutar tareas en paralelo

**Actor:** Orquestador · **Reglas:** R-02, R-04, R-06, R-10

**Precondiciones:** plan aprobado; daemon corriendo.

## Flujo principal
1. El orquestador calcula las tareas **listas** (dependencias aprobadas y conexiones disponibles).
2. Mientras haya cupo (`paralelo_max` del proyecto, tope global y cupo del proveedor):
   1. registra `tarea.lanzada`;
   2. crea el worktree y la rama `forja/T-xxx` desde la integración actual;
   3. arma el paquete de contexto;
   4. prepara el entorno (secretos permitidos y MCP temporal);
   5. lanza el adaptador con el nivel y el modelo elegidos.
3. Transmite los eventos del proceso a los logs (redactados), a la UI (SSE) y al estado (uso).
4. Hace checkpoints `wip` por turno o cada N minutos.
5. Al terminar el proceso, pasa la tarea a Verificar (UC-06).
6. Cuando se aprueba una tarea, recalcula las listas y vuelve a 1.

## Flujos alternos
- **A1 · El trabajador pregunta algo:** UC-09.
- **A2 · Límite del proveedor:** evento `proveedor.limitado`; la tarea vuelve a la cola sin contar como fallo; se reasigna a otro proveedor del mismo nivel si lo hay.
- **A3 · Bóveda cerrada y la tarea necesita una conexión:** estado `esperando_boveda`.
- **A4 · `forja run --solo T-014`:** ejecuta sólo esa tarea (si sus dependencias están listas).
- **A5 · El usuario pausa una tarea:** checkpoint y SIGTERM; queda `pausada`.

## Excepciones
- **E1 · El proceso termina con error no reintentable** (CLI no instalado, sesión expirada): la tarea queda `bloqueada` con el mensaje tal cual; el proveedor se marca con problema.
- **E2 · Se agota el presupuesto de la tarea:** se detiene el intento; cuenta como fallo (UC-06).
- **E3 · Disco lleno al crear el worktree:** se pausa el proyecto y se avisa (no se borra nada automáticamente).

## Criterios de aceptación
- **CA-1** Dadas 6 tareas listas y `paralelo_max: 4`, cuando ejecuto, entonces hay como máximo 4 procesos trabajadores a la vez.
- **CA-2** Dada una tarea sin conexiones declaradas, cuando su proceso ejecuta `env`, entonces no aparece ninguna variable de la bóveda.
- **CA-3** Dado un proveedor que responde «límite alcanzado», cuando ocurre, entonces el intento no suma a la escalera y la tarea vuelve a la cola.
