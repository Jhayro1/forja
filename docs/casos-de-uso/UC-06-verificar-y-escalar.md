# UC-06 · Verificar y escalar una tarea

**Actor:** Verificador · **Reglas:** R-02, R-03, R-04

**Precondiciones:** el proceso de la tarea terminó.

## Flujo principal
1. Comprueba que el diff sólo toque archivos permitidos.
2. Escanea el diff buscando secretos.
3. Corre build/typecheck, lint, los tests de la tarea y los tests afectados según el grafo.
4. Si todo pasa, el revisor barato evalúa el diff contra los criterios (respuesta con esquema).
5. Si el revisor aprueba, la tarea pasa a `aprobada`: se aplastan los `wip` y va a la cola de merge (UC-07).

## Flujos alternos
- **A1 · Falla un paso 1–4, primer fallo:** reintento en el mismo nivel con el error recortado como contexto.
- **A2 · Segundo fallo:** sube de nivel (barato → medio → planeador) con el diff y el historial.
- **A3 · Pasa tras fallar:** se pide la lección opcional (L-*).
- **A4 · La tarea tenía `complejidad: alta`:** empieza en `medio`.

## Excepciones
- **E1 · El diff modifica tests de aceptación:** se revierten esos archivos y se reintenta con el aviso (R-03).
- **E2 · Se detecta un secreto en el diff:** se bloquea el commit, se redacta el log y la tarea falla con el motivo.
- **E3 · Falla en el nivel `planeador` o se agota `max_intentos`:** `bloqueada`; notificación al usuario con el resumen y las opciones (reintentar, editar tarea, hacerlo a mano).
- **E4 · El comando de test del perfil no existe o falla por el entorno:** la tarea queda `bloqueada` con el tipo `entorno`; no se culpa al agente ni se escala.

## Criterios de aceptación
- **CA-1** Dado un diff que añade `.skip` a un test, cuando se verifica, entonces la tarea falla con el motivo «test saltado».
- **CA-2** Dados dos fallos en el nivel barato, cuando se reintenta, entonces el tercer intento usa el nivel medio y recibe el diff anterior.
- **CA-3** Dado que el build falla, cuando se verifica, entonces no se llama al revisor (0 tokens gastados en revisión).
