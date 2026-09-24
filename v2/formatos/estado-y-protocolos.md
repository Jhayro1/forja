# Estado y protocolos

## Modelo persistente lógico

| Colección / tabla | Clave y relaciones | Invariantes |
|---|---|---|
| projects/checkouts | project_id / checkout_id, ruta e identidad normalizada | Dos clones no comparten estado por accidente |
| events | event_id único, seq por checkout | Append-only lógico, payload versionado y redactado |
| runs/tasks | run_id / run_id + task_id + revision | Estado derivado de eventos |
| attempts/launches | attempt_id / launch_id | Intento de calidad separado de recuperación de proceso |
| commands/outbox | request_id único, target, estado de envío | Dedupe de solicitudes y despacho recuperable |
| leases/reservations | recurso + propietario + generation | Exclusión y reserva de presupuesto atómicas |
| approvals | approval_id, target_hash | No autorización sin coincidencia de revisión |
| artifacts | hash, tamaño, tipo, ubicación privada | Referencias sólo tras escritura completa y hash comprobado |
| usage | launch_id, scope, provider_event_id/seq | Contadores deduplicados con procedencia |
| verifications/merges | ID, run/task, tree/base/candidate hashes | Publicación sólo con evidencia vigente |
| questions/actions | ID, revisión, estado | Respuestas/autorizaciones vinculadas al objeto exacto |

Índices por sujeto/secuencia, estado del run, órdenes pendientes y recursos activos. Transacción única para evento, proyección, outbox y reserva que pertenezcan a una misma decisión. No FK cruzada entre archivos DB: el registro global es reconciliable con cada checkout.

## Sobre de evento

Campos requeridos: event_id, schema_version, checkout_id, seq, occurred_at, recorded_at, type, aggregate_type/id, aggregate_revision, correlation_id, causation_id, command_id, payload. `run_id`, `task_id`, `attempt_id` y `launch_id` según evento. Payload nunca guarda secretos; blobs grandes van a artefactos.

Catálogo mínimo: proyecto registrado/vinculado/archivado; spec revisada/validada; plan propuesto; aprobación otorgada/revocada/obsoleta; run iniciado/pausado/completado; tarea creada/lista/invalidada/bloqueada; lanzamiento solicitado/preparado/iniciado/interrumpido/terminado/desconocido; uso observado; verificación iniciada/paso/finalizada; merge preparado/confirmado/rechazado; pregunta creada/respondida; proveedor limitado/restablecido; backup creado/verificado; acción propuesta/aprobada/iniciada/confirmada/desconocida/compensada.

Eventos describen hechos observados. Una solicitud de pausa y el hecho de estar detenido son eventos distintos. Replay usa sólo datos guardados, sin reloj aleatorio, Git ni red; efectos se disparan desde outbox/controlador vivo, nunca durante replay.

## Runner

Orden de inicio: launch_id, fencing_token, task_revision, approval_id/hash, workspace_id, base_sha, context_artifact_hash, provider_profile, effective_policy_hash, resource_limits, deadline y protocol_version. Canal privado autenticado y restringido al lanzamiento.

Mensaje de runner: launch_id, generation, seq, tipo, timestamp y payload. Tipos: ready, started, heartbeat, observation, usage, stopped, result, error. `started` incluye identidad de proceso y sesión opcional. Daemon confirma última seq incorporada; runner retiene spool hasta confirmación y cierre.

Resultado: status (completed/needs_clarification/failed/cancelled/unknown), exit_code si observado, session_id opcional, result_artifact_hash, workspace manifest, usage completeness y error normalizado. `completed` significa final de proveedor, no tarea integrada. Campos suministrados por el modelo se consideran no confiables y se contrastan con runtime y verificador.

## Resultado de revisión

El descubrimiento utiliza el contrato por turno de [Planeador proactivo](../13-planeador-proactivo-y-prompts.md). Persistir `planeador.turno_confirmado` con turn_id, revisión base/nueva, manifiesto de prompts y hash del artefacto redactado que contiene la actualización validada. Turno repetido se deduplica; revisión base obsoleta se rechaza. Las propuestas de cierre y decisiones del modelo no generan por sí solas eventos de aprobación. El evento y la referencia al artefacto durable se confirman juntos antes de reconocer el turno como guardado.

review_id, task_revision, tree_hash, criterion_results[] con criterion_id/veredicto/evidencias, findings[] con severidad/ubicación/motivo, overall y limitaciones. Veredictos: cumple/no_cumple/no_verificable. Un fallo de esquema no es aprobación; el revisor no puede cambiar permisos ni criterios.

## Acción externa y conexión

Conexión: connection_id, ámbito, tipo/version, recurso/destino, referencias a secretos, permisos efectivos, versión de credencial, política, expiración y prueba con fecha. Cambiar credenciales/permisos incrementa versión. Sólo ejecutor puede resolver referencias; valores nunca se serializan a tarea o evento.

Acción: action_id, schema_version, task_revision, operation_type/version, connection_id/version, canonical_payload/hash, target, preconditions/hash, preview_artifact_hash, idempotency_key, approval_id, expires_at, status, receipt y reconciliation_evidence. Destino y payload son inmutables tras aprobar. Transición aprobada → ejecutando se reserva una vez; después de crash se concilia, no se concede otro consumo.

## Formato de bóveda propuesto

Envelope binario o serializado con magic/version, algoritmo, parámetros KDF acotados, salt, nonce, ciphertext y tag; cabecera relevante autenticada como AAD. Contenido estructurado versionado con variables, secretos, conexiones y referencias MCP. Permisos privados y writes atómicos; errores de autenticación nunca devuelven texto parcial. El diseño criptográfico y los parámetros exactos quedan sujetos a V2-050, no se implementan copiando los valores ilustrativos de v1.

## Evolución

Fixtures de cada versión externa; esquemas internos versionados; migraciones puras de eventos al leer sin borrar originales. Actualizaciones incompatibles exigen parada y backup. El adaptador puede aceptar eventos adicionales, pero un evento desconocido que cambie la interpretación de costo, permiso o finalización bloquea esa capacidad hasta revisión.
