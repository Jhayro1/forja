# Proveedores, modelos y presupuestos

## Contrato de adaptador

El contrato normalizado ofrece detectar instalación, obtener capacidades comprobadas, iniciar, cancelar, consultar estado si existe y reanudar si está soportado. Listar modelos puede no estar disponible; se acepta catálogo local verificado por el usuario/prueba controlada. No inventar un listado universal.

Capacidades trivalentes: soportado, no soportado o no verificado. Registrar versión de CLI, plataforma, modo de autenticación, formato de eventos, soporte de esquema, cancelación, resume, aislamiento, controles de configuración, uso y cuotas. Capacidad no verificada que afecte seguridad bloquea ejecución.

## Matriz inicial de investigación, todavía sin certificar

| Necesidad | Codex CLI | Claude Code CLI | Verificación pendiente |
|---|---|---|---|
| Batch | `codex exec` | `claude -p` | Salidas de éxito/error y cancelación reales |
| Eventos | `--json` | `--output-format stream-json` | Fragmentación, stderr, eventos desconocidos, final incompleto |
| Resultado estructurado | `--output-schema` | `--json-schema` | Esquemas aceptados y validación propia |
| Continuar | `exec resume` con ID | `--resume` con ID | Flags efectivos y permisos en la continuación |
| Modelo | Configuración por identificador admitido | Configuración por identificador admitido | Acceso de la cuenta, modelo efectivo y fallback |
| Aislamiento | Sandbox configurable | Sandbox y permisos configurables | Cobertura de todas las herramientas y configuración heredada |
| Autenticación | Modos oficiales por cuenta/API | Modos oficiales por cuenta/API | Compatibilidad con entorno aislado y condiciones del modo distribuido |

Fuentes: [Codex no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programático](https://code.claude.com/docs/en/headless). La sintaxis publicada orienta M0; no constituye un comando de producción certificado.

La documentación de Claude diferencia bare y login por suscripción; el spike debe resolver aislamiento de configuración sin invalidar el modo de autenticación elegido. No usar un directorio de credenciales temporal copiando tokens como atajo. Para ambos proveedores, comprobar plugins, MCP, hooks, instrucciones y subagentes que se cargan realmente.

## Catálogo inicial de modelos

Decisión del usuario (D2-18): el MVP funciona con **todos** estos modelos de Claude y de Codex. Los identificadores vienen de lo observado en este servidor el 2026-09-24 (`claude --help` en Claude Code 2.1.281; `~/.codex/models_cache.json` en codex-cli 0.156.1). V2-006 confirma con una llamada mínima por modelo que la cuenta lo acepta y qué modelo efectivo reporta.

| Proveedor | Identificador para `--model` / `-m` | Descripción del proveedor | Rol por defecto |
|---|---|---|---|
| Claude | `fable` | Alias del último Fable (`claude-fable-5-1`). En la cuenta de prueba devolvió 429 `credits_required`: usa créditos de uso aparte ([M0](../m0/RESULTADOS.md)) | planeador |
| Claude | `opus` | Alias del último Opus | planeador |
| Claude | `sonnet` | Alias del último Sonnet | trabajador complejo, revisor |
| Claude | `haiku` | Alias del último Haiku (`claude-haiku-4-5-20251001`) | trabajador |
| Codex | `gpt-6-astra` | «Frontier intelligence for the most demanding work» | planeador |
| Codex | `gpt-6-sol` | «Workhorse model for coding and everyday work» | trabajador complejo, revisor |
| Codex | `gpt-6-luna` | «Fast and affordable model for easier tasks» | trabajador |

Nota: según el propio catálogo de Codex, **Astra** es el más potente y **Sol** el de uso diario para programar. Los modelos anteriores que lista Codex (`gpt-5.6-*`, `gpt-5.5`) no entran en el catálogo por defecto, pero se pueden agregar en configuración.

```yaml
# forja.yaml
modelos:
  planeador:   [claude:opus, claude:fable, codex:gpt-6-astra]
  trabajador:  [claude:haiku, codex:gpt-6-luna]
  complejo:    [claude:sonnet, codex:gpt-6-sol]
  revisor:     [codex:gpt-6-sol, claude:sonnet]   # de otro proveedor que el autor cuando se pueda
```

El catálogo se refresca con `forja doctor --modelos`: modelos nuevos aparecen como «no verificados» y no se usan hasta pasar la conformance.

## Normalización y errores

Eventos internos: inicio, texto, herramienta_observada, uso, pregunta, límite, resultado y error. Texto/herramienta observada no conceden capacidad de ejecutar acciones. Eventos nuevos no críticos se conservan redactados con límite; un resultado final desconocido no se trata como éxito.

Error normalizado con categoría: `auth`, `quota`, `network`, `timeout`, `environment`, `schema`, `policy`, `quality`, `protocol` o `unknown`; código original redactado, reintentabilidad y espera conocida. Proceso exit 0 sin resultado completo deja ejecución incompleta; resultado textual «éxito» sin verificación tampoco completa la tarea.

Backoff acotado con jitter para fallos transitorios; circuito abierto tras fallos reiterados. Cuota sin hora de reinicio conocida muestra «desconocida» y usa sondeo controlado, no cuenta regresiva inventada. No cambiar de proveedor fuera de la lista aprobada ni para eludir restricciones de una cuenta.

## Enrutamiento

Roles: planeador, trabajador y revisor. Perfiles de capacidad/riesgo/costo asignan modelos configurables a cada rol. Ruta inicial propuesta: tarea sencilla, dos intentos del modelo base; fallo de calidad persistente, una alternativa más capaz; después bloqueo con diagnóstico. Tarea crítica puede empezar en mayor capacidad. Revisor independiente en sesión y permisos; diversidad de proveedor se mide, no garantiza independencia de errores.

Si se detecta falta de contexto, aportar evidencia antes de subir modelo. Errores de entorno, cuota, presupuesto, permisos o cancelación no aumentan el contador de fallos de calidad. Cada lanzamiento, incluidas recuperaciones, consume recursos y queda medido.

## Contabilidad

Separar `tokens_reportados`, `tokens_estimados`, `costo_equivalente_estimado`, `costo_reportado_proveedor`, `importe_conciliado` y `cuota_reportada`. Un dato ausente es null/desconocido, nunca cero. No inferir porcentaje de suscripción a partir de tokens.

Guardar modelo efectivo, precio/versionado/fecha/moneda, origen y semántica de cada contador (delta, acumulado por turno o acumulado por sesión). La normalización descuenta el último acumulado confirmado dentro del mismo ámbito y deduplica eventos. Contadores inconsistentes pasan a revisión; no restar arbitrariamente hasta hacerlos positivos.

El precio equivalente sólo se calcula si hay correspondencia fiable modelo/tarifa/categorías de caché. Mostrar intervalos cuando faltan datos. La facturación API puede incluir conceptos no presentes en eventos; no llamarla exacta sin conciliación. Reanudar puede volver a consumir contexto y tiempo.

## Presupuestos ejecutables

Reservar antes del lanzamiento un máximo operativo por tiempo, tokens cuando sean observables y gasto estimado. Reserva global atómica evita que dos proyectos gasten simultáneamente el mismo saldo disponible. Liberar reserva tras liquidación; conservar deuda/consumo desconocido cuando falte respuesta.

Presupuesto agotado: pausar y mostrar medido, reservado y potencial consumo pendiente. No escalar. Un tope externo exacto sólo existe si el proveedor ofrece una garantía aplicable; cancelación y telemetría tardías pueden sobrepasar el umbral. El usuario elige nueva asignación y eso produce nueva autorización registrada.

Estimación previa incluye planificación, revisión, reintentos, integración y contexto adicional. Con pocos datos, intervalo amplio y etiqueta «sin calibrar». `--estimar` no llama a modelos ni ejecuta comandos del repo; trabaja con entradas persistidas.
