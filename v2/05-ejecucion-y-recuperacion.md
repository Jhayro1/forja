# Ejecución, recuperación e integración

## Invariantes

I01: una tarea tiene como máximo un lanzamiento aceptable activo. I02: todo lanzamiento está vinculado a aprobación, revisión, contexto y base Git. I03: sólo un integrador puede actualizar una rama de run. I04: una dependencia se considera disponible cuando su resultado está integrado y verificado. I05: resultado recibido no significa código correcto. I06: ninguna duda sobre un proceso autoriza lanzar otro escritor sobre el mismo workspace.

## Estados separados

| Objeto | Estados principales |
|---|---|
| Run | borrador, aprobado, ejecutando, pausado, bloqueado, completado, cancelado |
| Tarea | pendiente, lista, reservada, ejecutando, verificando, verificada, integrando, integrada; esperando_respuesta, pausada, bloqueada, invalidada, cancelada |
| Lanzamiento | solicitado, preparando, iniciado, terminado, interrumpido, resultado_desconocido |
| Verificación | pendiente, ejecutando, aprobada, rechazada, error_entorno |

Fallo de calidad pertenece a un intento; la tarea vuelve a lista si tiene reintento permitido. Una tarea invalidada conserva evidencia histórica. `completado` exige que todos los criterios del alcance aprobado estén cubiertos por evidencia vigente; canceladas o bloqueadas no cuentan como completadas.

| Transición de tarea | Guarda obligatoria | Autoridad |
|---|---|---|
| pendiente → lista | Dependencias integradas y entradas válidas | Scheduler |
| lista → reservada | Aprobación vigente, recursos y presupuesto reservados | Scheduler transaccional |
| reservada → ejecutando | Runner confirmó inicio para generación actual | Controlador de runtime |
| ejecutando → verificando | Proveedor terminó y árbol quedó sin escritores | Runtime/verificador |
| verificando → verificada | Todos los controles obligatorios aprobados para ese árbol | Verificador |
| verificada → integrando → integrada | Candidato válido, suite completa y CAS confirmado | Integrador |
| ejecutando → esperando_respuesta | Pregunta estructurada; worker detenido o espera certificada | Controlador |
| estado activo → pausada | Parada confirmada, sin escritor incierto | Controlador |
| verificando → lista | Fallo de calidad clasificado y nuevo intento dentro del límite | Política de reintentos |
| cualquier estado no terminal → bloqueada | Precondición no recuperable automáticamente | Controlador con motivo |
| pendiente/lista/reservada/activa → invalidada | Nueva revisión revoca aceptación; detener escritor si existe | Gestor de revisiones |
| estado no integrado → cancelada | Solicitud autorizada y parada reconciliada | Usuario/controlador |

Un resultado ya integrado permanece como hecho histórico al invalidarse su criterio: la nueva revisión crea corrección y no borra el commit. Una tarea pausada/bloqueada/esperando respuesta vuelve a lista sólo tras resolver su causa y revalidar todas las guardas. Intentos antiguos no pueden ejecutar transiciones de una revisión nueva.

## Paralelismo entre tareas (MVP, D2-16)

**Qué se paraleliza.** Claude Code o Codex pueden lanzar subagentes *dentro* de una tarea (explorar, buscar, revisar), pero todos trabajan para ese único objetivo y comparten su contexto. Forja paraleliza **tareas distintas**: T-014 (API), T-015 (pantalla) y T-016 (validaciones) avanzan a la vez, cada una en su proceso, workspace, rama candidata y modelo. Ambos niveles se suman; Forja no desactiva los subagentes del CLI, sólo los cuenta en el consumo de la tarea.

**Cuántas.** `paralelo` por proyecto (defecto 3, `forja run --paralelo N`), tope por máquina (según CPU/RAM medidos en M0) y cupo por proveedor/cuenta. Con Claude y Codex configurados, el scheduler reparte entre ambos: dos cuotas independientes permiten más trabajo simultáneo.

**Cuáles.** Cualquier tarea `lista` (dependencias integradas, recursos libres, presupuesto reservado). No hay barrera por olas: si T-020 depende sólo de T-014, arranca cuando T-014 se integra aunque T-015 siga corriendo. Orden: prioridad, camino crítico del DAG (la que más tareas desbloquea primero) y antigüedad.

**Qué evita que se pisen.** Recursos exclusivos (lockfile, migraciones, archivos compartidos, generación de clientes) se reservan en la misma transacción que la tarea; dos tareas con globs que podrían solaparse no corren juntas. Cada una nace del SHA integrado vigente y el integrador único las integra de a una (I03, I04). Si la integración de una invalida la base de otra que sigue corriendo, ésta se re-verifica sobre la nueva base antes de integrarse.

**Visibilidad.** El tablero de terminal (ver [10](10-cli-ui-y-api.md#tablero-de-terminal-mvp)) muestra cada trabajador con su tarea, proveedor, modelo, fase, tiempo, consumo y última acción.

## Protocolo de lanzamiento

1. En una transacción, comprobar revisión y aprobación, dependencias integradas, reserva de presupuesto, cupos y recursos; crear `launch_id` único, lease y `fencing_token`; persistir intención y orden pendiente en outbox.
2. Un despachador toma la orden. Preparar worktree desde el SHA de integración aceptado, manifiesto de contexto y sandbox. Los recursos se nombran por run/tarea/lanzamiento y la preparación es repetible.
3. Iniciar runner. Éste adquiere una exclusión local por `launch_id`, escribe identidad durable, establece canal de control privado y confirma disponibilidad. Una orden repetida se conecta al mismo runner o informa estado, nunca lanza otro worker.
4. El runner inicia el CLI después de persistir sus entradas; registra PID, identidad de proceso, sesión si existe, hora, política y versión. El evento `lanzamiento.iniciado` se emite después del spawn, no antes.
5. Redactar salida antes de spool; conservar secuencia local, offsets y límites de tamaño. Enviar heartbeats y resultados al daemon. Guardar resultado de manera atómica antes de anunciar finalización.
6. Daemon ingiere eventos de manera idempotente por lanzamiento/secuencia, confirma offsets y actualiza proyección. El verificador recibe un árbol congelado, nunca un workspace todavía en escritura.

La transacción DB no incluye spawn ni Git. Outbox evita perder intenciones; runner y reconciliación reducen duplicados. No se promete ejecución exactamente una vez de llamadas remotas.

## Propiedad y parada

Heartbeat propuesto cada 5 s, lease 30 s; son valores iniciales a probar. Cuando expira la comunicación, el runner deja de aceptar trabajo y detiene su árbol según protocolo. El daemon no toma un lease expirado como prueba de que el worker murió: confirma parada del grupo de procesos o deja `resultado_desconocido` y bloquea el workspace.

Fencing sólo impide aceptar resultados antiguos; no detiene escrituras del SO. Por eso se exige exclusión real y confirmación de quiescencia. El runner supervisa también nietos, procesos en background y límites de CPU/RAM/tiempo/disco. M0 elegirá y documentará mecanismo Linux (por ejemplo grupo de procesos y cgroup) compatible con el aislamiento.

Pausa ordenada: no lanzar nuevos trabajos, solicitar interrupción soportada, esperar límite, terminar grupo si hace falta, comprobar ausencia de escritores y capturar diff. Parada inmediata puede perder buffers no confirmados. Nunca hacer `git add -A` mientras otro proceso escribe.

Los checkpoints son capturas de archivos permitidos con hash, escaneo y manifiesto, en puntos seguros. Commits WIP son opcionales y los crea el controlador, no se confunden con resultados aprobados. Si un proceso no ofrece un punto seguro, se preserva el workspace y se captura tras detenerlo; no se prometen checkpoints periódicos consistentes durante escritura activa.

## Reconciliación al arrancar

| Situación observable | Acción |
|---|---|
| Intención durable sin runner ni recursos | Reenviar la misma orden identificada |
| Runner vivo con identidad válida | Reconectar a su socket y leer spool desde último offset confirmado |
| PID existe pero identidad no coincide | No adoptarlo; tratar lanzamiento original como interrumpido y verificar recursos |
| Runner murió, resultado durable existe | Ingerir resultado una vez y verificar árbol |
| Worker podría seguir vivo | Aislar/bloquear workspace; no iniciar sustituto hasta confirmar su parada |
| Árbol conservado sin resultado | Nuevo lanzamiento de recuperación, con diff inspeccionado; mismo intento de calidad |
| CLI admite resume con sesión compatible | Usar ID exacto, nunca `--last`; verificar política y revisión antes |
| No hay sesión compatible | Continuar con resumen y diff; registrar posible costo repetido |
| Archivo de resultado o spool incompleto | Ignorar cola parcial no confirmada, informar pérdida acotada; no inventar éxito |
| Worktree sin registro | Reportar y conservar para recuperación manual |
| DB dañada | Detener nuevas escrituras, preservar evidencia y restaurar copia verificada; no improvisar reparación automática |

El cache de respuestas usa hash de proveedor, modelo, opciones, prompt, esquema, herramientas, política y entradas del repo. Sólo reutiliza resultados completos de operaciones de planificación/análisis compatibles. Nunca se usa cache de texto para simular que herramientas con efectos ya se ejecutaron.

## Cola de integración

Cada run tiene `forja/run/<run_id>/integracion`. La tarea registra `base_sha`, `result_tree_hash` y evidencia. Integración:

1. Reservar bloqueo único y persistir `merge.preparado` con base aceptada y candidato.
2. Crear candidato en workspace de integración privado, sin modificar la rama principal del usuario.
3. Si hay conflicto, conservar candidatos y crear tarea de resolución. No resolver lockfiles por mezcla textual; si procede regenerar, usar herramienta/versión aprobada.
4. Ejecutar verificación completa sobre el candidato; registrar SHA/tree, perfil, pruebas y resultado.
5. Publicar ref de integración mediante compare-and-swap sobre el SHA esperado; persistir `merge.confirmado` e integrar tarea.
6. Si la DB cae después de mover la ref, reconciliar comparando ref, marcador del merge y artefactos antes de repetir.

Un candidato rechazado no avanza la ref aceptada, por lo que normalmente no hace falta revertir un merge publicado. Si el destino avanzó, repetir integración y pruebas; no reutilizar una aprobación de pruebas para otro árbol. Actualizar desde main genera nuevo candidato, no reescribe silenciosamente evidencia aprobada.

## Durabilidad y respaldos

Garantía objetivo: conservar eventos y artefactos confirmados dentro de los supuestos de disco local y sincronización probados. Un corte eléctrico, disco perdido o llamada remota sin respuesta no permiten garantizar cero pérdidas o cero cobros duplicados.

Backup coordinado en punto seguro: snapshot consistente de DB, refs/objetos Git necesarios, artefactos referenciados y manifiesto con hashes. Índices se reconstruyen; bóveda se respalda cifrada aparte. Snapshot diario implica RPO de hasta 24 h ante pérdida total del disco; para menor RPO configurar otra frecuencia/destino. Restauración se ensaya antes de considerar válida la política. Copiar sólo el archivo `.db` activo no constituye el procedimiento de backup.
