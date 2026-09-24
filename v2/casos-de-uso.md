# Casos de uso v2

Los IDs UC-01…14 conservan intención de v1; sus contratos revisados son los de este archivo. CA son globalmente identificables. Precondición común: usuario local autenticado y versión del formato admitida. En todos los casos, errores y resultados persistidos se redactan y una operación con estado desconocido no se presenta como éxito.

## UC-01 · Crear o importar proyecto — M1/M3

Actor: usuario. Precondición: ruta accesible y Git disponible. Flujo: inspeccionar → crear o reconocer project_id → registrar checkout_id/ruta → guardar evento → mostrar estado y siguiente paso. Importar es estático; no ejecuta scripts. Postcondición: checkout identificable con estado propio.

Alternos: nuevo repo sin commits requiere base antes de ejecutar; traslado actualiza ruta tras distinguirlo de clon. Excepciones: ruta alias de checkout conocido, carpeta no vacía o repo sucio se muestran sin sobrescribir archivos.

- CA-UC-01-01: dado un project_id en dos clones, cuando importo ambos, entonces obtengo dos checkout_id y sus runs no se mezclan.
- CA-UC-01-02: dado un hook malicioso, cuando importo, entonces el hook no se ejecuta.

## UC-02 · Descubrir — M2

Actores: usuario y planeador. Precondición: proveedor de planificación disponible. Flujo: entender idea o mejora y trabajo actual → consultar evidencia disponible → detectar huecos/contradicciones → proponer alternativas justificadas y preguntas prioritarias → registrar respuestas, propuestas y decisiones por revisión → revisar cobertura → presentar resumen de alcance → aprobación de descubrimiento. Postcondición: necesidad, decisiones, propuestas y dudas persistidas, sin permiso de ejecución. Comportamiento y prompts normativos en [13 · Planeador proactivo](13-planeador-proactivo-y-prompts.md).

Alternos: repo existente aporta evidencia; usuario delega detalles dentro del alcance; cambio de proveedor autorizado utiliza resumen y fuentes. Excepciones: cuota pausa; secreto detectado bloquea envío; respuesta incompleta se conserva redactada sin confirmar turno.

- CA-UC-02-01: dadas tres dudas guardadas, cuando reinicio, entonces aparecen con el mismo estado.
- CA-UC-02-02: dado un descubrimiento aprobado, cuando intento ejecutar sin plan aprobado, entonces no se lanza worker.
- CA-UC-02-03: dada una idea vaga de pedidos, cuando comienza descubrimiento, entonces explora proceso/actores y propone al menos una necesidad pertinente omitida, explicando su motivo y sin asumir su aceptación.
- CA-UC-02-04: dada una descripción con información suficiente, cuando continúa el planeador, entonces reutiliza lo conocido y pregunta como máximo tres cuestiones prioritarias sin repetir las resueltas.
- CA-UC-02-05: dada una sugerencia rechazada, cuando reanudo o compacto contexto, entonces sigue rechazada y no aparece en el alcance aprobado.
- CA-UC-02-06: dadas dos respuestas incompatibles sobre quién puede cancelar, cuando se revisa cobertura, entonces se explica la contradicción y se solicita resolverla antes de cerrar.
- CA-UC-02-07: dada una mejora sin acceso al código, cuando se recomienda un cambio, entonces se distingue hipótesis de observación y no se inventan hallazgos o pruebas.
- CA-UC-02-08: dada delegación explícita de un detalle dentro del alcance, cuando el planeador elige una opción, entonces registra el motivo y la delegación, sin ampliar permisos ni presupuesto.

## UC-03 · Especificar y generar — M2

Actor: planeador/generador. Precondición: alcance acordado. Flujo: producir propuesta estructurada → validar contra revisión base y referencias → reparar huecos acotadamente → guardar spec → renderizar documentos/manifiesto. Postcondición: spec y documentos trazables.

Alternos: excepción no aplicable justificada; evidencia manual declarada. Excepciones: edición manual genera diff separado; parche obsoleto se rechaza; validación reiterada falla con diagnóstico.

- CA-UC-03-01: dada una referencia E-999 inexistente, cuando valido, entonces se rechaza con ubicación exacta.
- CA-UC-03-02: dadas entradas/plantillas iguales, cuando regenero, entonces no cambia ningún archivo ni se llama a un modelo.

## UC-04 · Dividir y aprobar — M2

Actores: planeador y usuario. Precondición: spec válida. Flujo: proponer incrementos/contratos/pruebas → validar DAG y recursos → estimar → mostrar alcance, permisos y límites → aprobar hashes. Postcondición: plan autorizado en revisión concreta.

Alternos: aprobación de subconjunto cerrado sobre dependencias; conexiones futuras dejan tareas bloqueadas. Excepciones: ciclos, criterios huérfanos, dependencias ausentes y solapamiento no resuelto impiden aprobar.

- CA-UC-04-01: dado un plan aprobado, cuando cambia su política, entonces la aprobación deja de habilitar lanzamientos afectados.
- CA-UC-04-02: dados globs potencialmente solapados, cuando se planifican tareas, entonces comparten bloqueo o se serializan.

## UC-05 · Ejecutar — M3

Actor: scheduler. Precondición: plan vigente, modo certificado y dependencias integradas. Flujo: reservar cupos/presupuesto/lease → intención/outbox → preparar → runner → observar → congelar resultado → verificar. Postcondición: lanzamiento finalizado o espera/bloqueo explícito.

Alternos: pregunta conserva trabajo; cuota abre circuito; pausa espera confirmación. Excepciones: disco/entorno/política bloquean sin escalado; runner incierto conserva exclusión.

- CA-UC-05-01: dada una dependencia verificada pero no integrada, cuando hay cupo, entonces su dependiente no se lanza.
- CA-UC-05-02: dada una orden duplicada, cuando llega dos veces, entonces no existen dos workers escribiendo el workspace.
- CA-UC-05-03: dado un presupuesto agotado, cuando termina la reserva, entonces se pausa y no se sube de modelo automáticamente.

## UC-06 · Verificar y escalar — M3

Actor: verificador. Precondición: árbol congelado y manifiesto vigente. Flujo: alcance → secretos → materialización limpia → controles/pruebas → revisión → evidencia por hash. Postcondición: tarea verificada o fallo clasificado.

Alternos: reintentar calidad dentro del límite; intervención humana aporta diff que se verifica igual. Excepciones: pruebas ausentes/skipped o configuración protegida alterada rechazan; entorno roto no escala.

- CA-UC-06-01: dado un script modificado para devolver cero sin tests, cuando verifico, entonces la tarea se rechaza.
- CA-UC-06-02: dado un build fallido, cuando avanza el pipeline, entonces no se gasta revisión LLM.

## UC-07 · Integrar — M3

Actor: integrador. Precondición: evidencia vigente y dependencia integrada. Flujo: reservar integración → preparar candidato contra SHA actual → comprobar conflictos → suite completa → CAS de ref → confirmar evento. Postcondición: nuevo SHA aceptado o candidato rechazado preservado.

Alternos: conflicto produce tarea explícita; main avanzado exige nuevo candidato/pruebas. Excepción: caída tras CAS se concilia por SHA/marcador. Publicar PR queda fuera de este caso hasta autorización propia.

- CA-UC-07-01: dado un candidato que rompe la suite, cuando se verifica, entonces la ref aceptada y main no cambian.
- CA-UC-07-02: dado un CAS exitoso y caída antes del evento, cuando reinicia, entonces se confirma esa integración sin duplicarla.

## UC-08 · Analizar código existente — M3 básico/M6 avanzado

Actor: usuario. Precondición: checkout registrado. Flujo: inventario/exclusiones → perfil propuesto → extracción/resúmenes de archivos permitidos → conclusiones con fuente/confianza → baseline dinámico sólo si se autoriza. Postcondición: informe y contexto versionados.

Alternos: lenguaje no soportado degrada a nivel de archivo; repo grande se analiza por módulos. Excepciones: symlink externo, archivos sensibles y exceso de tamaño quedan excluidos y reportados.

- CA-UC-08-01: dado un `.env` excluido y un symlink a él, cuando analizo, entonces su contenido no entra en prompts.
- CA-UC-08-02: dadas entradas y extractor sin cambios, cuando reanalizo, entonces reutilizo artefactos sin llamadas nuevas.

## UC-09 · Resolver preguntas — M3

Actores: worker, planeador y usuario. Precondición: solicitud estructurada con revisión. Flujo: decisión exacta vigente → si falta, planeador con evidencia → si requiere negocio/permiso, usuario → registrar decisión → reanudar bajo política vigente. Postcondición: respuesta con procedencia o espera explícita.

Alterno: CLI sin pausa termina con pregunta y se continúa en otro lanzamiento. Excepciones: coincidencia ambigua no se autoacepta; respuesta que cambia alcance pasa por UC-13.

- CA-UC-09-01: dada una decisión exacta vigente, cuando se repite la pregunta, entonces se cita sin nueva llamada de planeador.
- CA-UC-09-02: dada una duda de negocio sin respuesta, cuando pasa tiempo, entonces no se inventa decisión ni se integra tarea.

## UC-10 · Recuperar — M1/M3

Actor: daemon/runner. Precondición: lock exclusivo del checkout. Flujo: validar estado → reconciliar runners/resultados/refs → ingerir spool deduplicado → retomar lo comprobablemente seguro → informar incertidumbres. Postcondición: cada lanzamiento tiene estado sustentado por evidencia.

Alternos: `--sin-reanudar` deja pendientes; sesión compatible reanuda por ID; sin sesión, nuevo lanzamiento con diff. Excepciones: identidad PID distinta no se adopta; DB dañada detiene escrituras; workspace perdido bloquea y ofrece recuperación, no vuelve a cero silenciosamente.

- CA-UC-10-01: dado un runner vivo tras caída del daemon, cuando arranca otro daemon autorizado, entonces consume spool sin repetir sus eventos.
- CA-UC-10-02: dada recuperación de una tarea, cuando se relanza, entonces launch_id cambia y el contador de fallos de calidad no aumenta.

## UC-11 · Gestionar conexiones — M5

Actor: usuario. Precondición: bóveda/ejecutor disponibles. Flujo: introducir datos por canal privado → validar → prueba de menor impacto declarada → asignar recursos/permisos → cifrar → autorizar vínculo local con checkout. Postcondición: conexión utilizable sólo por ejecutor.

Alternos: guardar como no probada; rotar versión; conectar un gestor externo futuro. Excepciones: clave incorrecta, cabecera manipulada o permiso de archivo amplio impiden abrir. Un repo no concede su propia conexión global.

- CA-UC-11-01: dada una conexión utilizada, cuando un worker inspecciona entorno/archivos, entonces no obtiene su secreto.
- CA-UC-11-02: dada rotación de credencial, cuando se usa una aprobación de versión anterior, entonces se exige nueva validación.

## UC-12 · Aprobar acción externa — M5

Actor: usuario/ejecutor. Precondición: operación tipada soportada. Flujo: validar propuesta → preview real/precondiciones → aprobar hash → ejecutar con clave idempotente → verificar → auditar. Postcondición: efecto confirmado, fallido o desconocido.

Alternos: rechazo, edición que genera nueva propuesta, compensación con autorización independiente. Excepciones: caducidad, cambio externo o payload alterado invalidan; timeout tras envío requiere conciliación.

- CA-UC-12-01: dado un correo enviado con respuesta perdida, cuando recupero sin consulta fiable, entonces no se reenvía automáticamente.
- CA-UC-12-02: dada aprobación de A, cuando se propone B, entonces B no hereda esa aprobación.

## UC-13 · Cambiar especificación — M3

Actor: usuario. Precondición: revisión existente. Flujo: nueva propuesta → diff semántico → afectados directos/transitivos → invalidar recepción antigua y parar afectados → nuevas tareas/compensaciones → nueva aprobación. Postcondición: trabajo futuro ligado a revisión nueva, historia anterior preservada.

Alternos: campo editorial explícito no invalida; eliminar requisito integrado crea retiro aprobado. Excepción: impacto incierto amplía conjunto, no lo reduce a aristas conocidas.

- CA-UC-13-01: dado un contrato cambiado, cuando hay dependientes transitivos, entonces también se invalidan o reevalúan.
- CA-UC-13-02: dado un worker antiguo que termina tarde, cuando envía resultado, entonces no se integra en la nueva revisión.

## UC-14 · Observar agentes y costos — M3 CLI/M4 UI

Actor: usuario. Precondición: run registrado. Flujo: consultar snapshot → seguir eventos → abrir tarea/evidencia/contexto → ver consumo por procedencia y pendientes. Postcondición: estado observado consistente, sin autorizar nuevas acciones por observar.

Alternos: cliente reconecta por cursor; cursor expirado solicita snapshot. Excepciones: evento repetido se deduplica; log enorme se pagina; cuota ausente no se convierte en 0 %.

- CA-UC-14-01: dado un corte SSE, cuando reconecto, entonces obtengo replay o snapshot con watermark sin hueco silencioso.
- CA-UC-14-02: dado uso sin cifra de cuota, cuando veo costos, entonces indica desconocida.

## UC-15 · Verificar y restaurar respaldo — M1

Actor: usuario. Precondición: snapshot y destino seleccionados. Flujo: detener actividad relevante → verificar manifiesto/hashes → restaurar en destino separado → comprobar DB/refs/artefactos → reconciliar sin relanzar efectos → activar tras revisión. Postcondición: recuperación demostrada con fecha y RPO visible.

Excepción: snapshot incompleto no reemplaza el estado existente.

- CA-UC-15-01: dado un artefacto faltante, cuando valido backup, entonces la validación falla antes de activar la restauración.

## UC-16 · Rechazar ejecución insegura — M0/M3

Actor: doctor/runtime. Precondición: intento de ejecución real. Flujo: comprobar backend, capacidades, perfil, recursos y credenciales → prueba de controles → permitir sólo modo certificado. Postcondición: ejecución segura dentro del perfil probado o bloqueo explicable.

Excepción: no se propone desactivar sandbox como solución automática.

- CA-UC-16-01: dado backend que no restringe red de herramientas, cuando la tarea exige red cerrada, entonces no arranca.

## UC-17 · Revisar presupuesto y reanudar — M3

Actor: usuario. Precondición: run pausado por límite. Flujo: mostrar consumo/estimación/incertidumbre → nueva asignación explícita → registrar autorización → reservar → continuar. Postcondición: trabajo dentro de nuevos límites autorizados.

Excepción: cuenta/proveedor indisponible mantiene espera aunque se amplíe presupuesto.

- CA-UC-17-01: dadas dos tareas que compiten por el último saldo, cuando reservan, entonces sólo se admite la combinación que cabe en el presupuesto.
