# CLI, UI y API local

## CLI previsto

Estos nombres son contratos propuestos, no comandos disponibles en esta entrega. Idioma de la interfaz: español inicialmente; códigos de error y campos de protocolo estables.

| Grupo | Comandos | Efecto y puerta |
|---|---|---|
| Diagnóstico | `forja doctor` | Capacidades, versiones, aislamiento y estado de autenticación sin mostrar credenciales |
| Proyectos | `nuevo`, `importar`, `proyectos`, `usar`, `proyecto vincular`, `proyecto archivar` | Importar inspecciona; vincular no mezcla clones; archivar espera/paraliza trabajo |
| Plan | `analizar`, `planear`, `especificar`, `dividir` | Generan borradores; comandos del repo sólo tras aprobar perfil |
| Aprobación | `aprobar spec`, `aprobar plan`, `revocar <id>` | Mostrar y ligar revisión/hash; repetir mismo comando con misma clave no duplica |
| Ejecución | `run`, `run --estimar`, `run --solo <tarea>` | Ejecutar exige puerta vigente; `--solo` no omite dependencias pendientes |
| Observación | `estado`, `logs <tarea> -f`, `informe`, `preguntas` | Lectura, eventos, evidencia y pendientes |
| Control | `tarea <id> pausar`, `reanudar`, `reintentar`, `reasignar` | Nunca saltar política; cambio de proveedor debe estar autorizado |
| Integración | `unir`, `entrega preparar` | Procesan candidatos; preparan rama e informe local |
| Servicio | `serve`, `serve --sin-reanudar`, `parar`, `parar --ya` | Separar parada de CLI, daemon y workers; mostrar lanzamientos todavía vivos |
| Operación | `backup crear`, `backup verificar`, `backup restaurar`, `limpiar --vista-previa` | Restauración/limpieza requieren selección concreta y confirmación |
| Beta | `ui`, `memoria buscar`, `memoria contexto` | Panel y explicación de contexto |
| M5+ | `boveda abrir/cerrar`, `conexion nueva/probar`, `conexiones`, `accion aprobar/rechazar/deshacer`, `mcp registrar` | Conexiones y operaciones mediante ejecutor |

Flags comunes: `--proyecto`, `--checkout`, `--json`; comandos de mutación admiten ID de solicitud para deduplicación. Resolución: checkout explícito → repo del cwd → selección activa no ambigua → error con opciones. Nombre duplicado nunca selecciona arbitrariamente.

Salida JSON tiene versión, request_id, datos o error y referencias de evidencia, sin ANSI. Salidas propuestas: 0 éxito del comando, 2 entrada inválida, 3 precondición/aprobación ausente, 4 proveedor/entorno, 5 verificación rechazada, 6 operación en estado desconocido. Iniciar un run correctamente no significa que el run ya pasó sus tests.

## Tablero de terminal (MVP)

Decisión del usuario (D2-17): al inicio se trabaja en la terminal, pero se tiene que poder **ver todo en detalle** y debe ser fácil de usar. `forja tablero` abre una interfaz interactiva a pantalla completa (TypeScript con Ink u otra librería equivalente que se elija en V2-039), que funciona por SSH y lee la misma API que usará el panel web.

```
┌ Forja · mi-bodega · run r_07 ─────────── Ejecutar ●  11/27 integradas ─ 3/3 agentes ┐
│ Descubrir ✔  Especificar ✔  Plan ✔  [Aprobado]  Ejecutar ●  Verificar  Integrar     │
├─ Agentes ───────────────────────────────────────────────────────────────────────────┤
│ ▶ T-014 POST /fiados      claude:haiku      2m14s  8.1k tok  › editando api.ts        │
│   T-015 Pantalla fiados   codex:gpt-6-luna  1m02s  5.3k tok  › corriendo tests       │
│   T-016 Validaciones      claude:haiku      0m40s  2.0k tok  › leyendo contrato      │
├─ Cola ───────────────────────────── Pendiente de ti (1) ────────────────────────────┤
│ lista: T-020, T-021  espera: T-030←T-014    ? T-019 pregunta por redondeo [r]esponder │
├─ Consumo ───────────────────────────────────────────────────────────────────────────┤
│ planeador 41k · trabajador 96k · revisor 12k   Claude: cuota ok   Codex: desconocida  │
└ [↑↓] mover [enter] detalle [l]ogs [d]iff [c]ontexto [p]ausar [a]probar [?] ayuda [q] ┘
```

- **Detalle de tarea** (`enter`): objetivo, criterios, dependencias, modelo efectivo, intentos, base SHA, estado de la verificación paso a paso.
- **Logs en vivo** (`l`), **diff** (`d`), **paquete de contexto** que recibió (`c`), todo redactado y con scroll.
- **Pendiente de ti** siempre visible: aprobaciones, preguntas, bloqueos. Se responde ahí mismo.
- Acciones con confirmación: pausar, reanudar, reintentar, reasignar a otro modelo permitido.
- Estados con texto además de color; funciona en 80 columnas; sin ratón obligatorio.
- Comandos no interactivos para scripts: `forja estado`, `forja logs <tarea> -f`, `forja tarea <id>`, `--json`.

## Panel

La vista Planear sigue el [contrato del planeador proactivo](13-planeador-proactivo-y-prompts.md): conversación natural y resumen de decisiones, sugerencias por aceptar/rechazar/diferir, dudas prioritarias y cobertura desplegable. Elegir una opción sólo responde a esa pregunta; no aprueba todo el plan. La matriz interna no se presenta como un formulario obligatorio y los prompts internos no ocupan la conversación.

Pantallas: Flujo, Planear, Tareas/Agentes, Evidencia, Consumo y, posteriormente, Memoria, Conexiones y Auditoría. «Pendiente de ti» siempre visible. Planear muestra decisiones y preguntas; Tareas muestra dependencias y recursos; detalle incluye revisión, base SHA, modelo efectivo, contexto y resultado de pruebas.

Consumo distingue medido, estimado, reservado y desconocido. La UI no dice «recuperado» hasta reconciliar. Pausa muestra solicitada/detenida. Completar manualmente una tarea adjunta evidencia y pasa por verificador. La accesibilidad incluye teclado, estados con texto además de color y logs que se pueden pausar/copiar sin ejecución de HTML.

MVP ofrece estos datos en la terminal (tablero y comandos); el panel web llega en M4 y no es requisito para probar el dominio. No incluir notificaciones por email/Telegram hasta que exista conexión explícita y control de datos enviados.

## API v1 prevista

HTTP local autenticado. Recursos principales bajo `/v1`: proyectos, checkouts, cambios, planes, runs, tareas, preguntas, aprobaciones, artefactos y eventos. El dominio comparte handlers con CLI/UI; ninguna vista actualiza SQLite directamente.

| Operación | Contrato mínimo |
|---|---|
| Crear run de un plan | POST con checkout_id, plan_revision, approval_id, idempotency_key; devuelve 202 + run_id y estado |
| Leer run/tareas | GET por ID; versión de recurso y evidencias paginadas |
| Aprobar | POST con target_id, target_hash, expected_revision; conflicto si cambió |
| Pausar/reanudar | POST sobre run/tarea; comando durable, estado observado separado de solicitud |
| Responder pregunta | POST con question_id, expected_revision, respuesta; puede crear cambio de spec |
| Leer artefacto | GET por ID autorizado, tamaño/tipo/hash; ruta interna nunca aceptada desde URL |
| Eventos | GET SSE por checkout y cursor; replay o snapshot si cursor expiró |

Mutaciones llevan token CSRF en navegador y clave de idempotencia en peticiones reintentables. Estado 409 para revisión/precondición incompatible, 422 para datos válidos en sintaxis pero inválidos en dominio, 401/403 para autenticación/autorización, 429 para límites del servicio. Error contiene código estable, explicación, si puede reintentarse y acción recomendada; datos internos sensibles no se exponen.

SSE es entrega al menos una vez: event_id = checkout_id + secuencia. Cliente deduplica, reconecta con cursor y obtiene snapshot con su watermark. Logs voluminosos usan canal paginado separado para no saturar eventos de dominio. Backpressure y límites de buffers son obligatorios; una UI desconectada no frena el scheduler.
