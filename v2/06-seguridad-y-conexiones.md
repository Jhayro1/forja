# Seguridad, bóveda y acciones externas

## Modelo de amenazas

Proteger archivos del usuario, otros proyectos, credenciales, historial y destinos externos frente a instrucciones maliciosas en repos, herramientas o salidas de modelos, errores del agente y dependencias ejecutables. El administrador del host y el propio SO son de confianza; una máquina comprometida o un administrador malicioso quedan fuera de la garantía del MVP.

Un repo «propio» puede contener datos o scripts no confiables. Ejecutar build, tests, hooks o instalación es ejecutar código. El análisis estático es el único modo inicial sin esa autorización.

| Frontera | Control exigido | Prueba negativa |
|---|---|---|
| Workspace → host/otro proyecto | Sandbox del SO, rutas de lectura limitadas, escrituras confinadas, symlinks evaluados | Intentar leer un canario fuera del workspace y modificar un repo vecino |
| Worker → Git/control | Sin socket administrativo, sin escritura a refs/config/hooks compartidos | Intentar cambiar main, hooks o estado.db |
| Worker → red | Red de herramientas denegada por defecto; rutas permitidas específicas cuando hacen falta | Intentar DNS, HTTP, sockets locales y acceso a metadata cloud no autorizados |
| Worker → credenciales | Sin bóveda ni secretos externos ni entorno completo heredado | Intentar env, archivos de autenticación y configuración de otros procesos |
| Repo → arranque de proveedor | Inventario de hooks, instrucciones, MCP, plugins y configuración efectiva | Repo malicioso no puede cargar una herramienta con privilegios extra |
| Resultado → publicación | Política validada fuera del modelo; revisión y hash obligatorios | Enviar resultado de otro run o revisión antigua |

Globs son controles de aceptación de diff, no sustituyen el aislamiento. Verificar también borrados, renombres (origen y destino), cambios de modo, enlaces y archivos nuevos/ignorados. El agente puede escribir archivos temporales dentro del workspace; sólo se exporta lo permitido. Nunca se acepta `.git`, configuración de Forja ni controles de verificación como parte de un diff de implementación.

## Autenticación del proveedor

El CLI necesita comunicarse con su proveedor, mientras las herramientas no deben tener red arbitraria. Esa separación debe demostrarse en M0 con la configuración real, no asumirse por una opción `red: false`.

Forja no extrae, copia ni distribuye tokens de sesión. El usuario autentica el binario oficial. El proceso del CLI y su almacén de credenciales pertenecen a una zona de confianza; las herramientas ejecutadas deben quedar privadas de leerlos. Si un modo no logra esa separación, no se certifica para ejecución autónoma. La alternativa es otro modo oficialmente soportado o limitarse a planificación, no desactivar controles en silencio.

**Decisión D2-21 (M0).** Cada usuario usa sus propias cuentas en su propia máquina. `forja doctor` comprueba que `claude` y `codex` estén instalados y con sesión iniciada; si no, indica el comando oficial (`claude`, `codex login`) y nunca pide la credencial. Riesgo residual aceptado: una herramienta del agente puede leer el login de su mismo CLI. Con una inyección desde contenido no confiable, el peor caso es el uso de la suscripción de ese usuario hasta que cierre sesión. Mitigaciones: sin red para herramientas (D2-20), revisión de diffs por el valor exacto del token y redacción en logs.

No se heredan todas las variables del daemon. Entorno por lista positiva; sin tokens Git, SSH agent, sockets Docker ni clave maestra. No usar permisos de root como solución a incompatibilidades.

## Secretos y bóveda futura

Los workers proponen operaciones tipadas. Un **ejecutor separado** resuelve credenciales y llama al servicio con parámetros validados. Ni el valor ni un archivo que lo contenga están montados en el worker. Separación efectiva por permisos/usuario/sandbox; dos procesos con el mismo acceso de archivos no proporcionan esta garantía.

Para tests locales, datos ficticios y servicios efímeros. Si una tarea requiere ejecutar código arbitrario con credenciales reales, no cumple el perfil seguro y debe rediseñarse o ejecutarse como operación externa explícita.

Bóveda local propuesta: cifrado autenticado AES-256-GCM y scrypt mediante biblioteca estándar, formato versionado, salt aleatoria, nonce único por escritura, cabecera autenticada, límites estrictos de parámetros antes de derivar, memoria máxima de KDF probada y escritura atómica con sincronización. Un llavero o gestor existente es preferible cuando esté disponible; no construir criptografía propia. Implementar sólo después de revisión del diseño y pruebas de manipulación/restauración.

Clave maestra solicitada de forma privada o resuelta desde gestor del SO; no forma parte del entorno de workers. Rotación vuelve a cifrar y conserva recuperación controlada. Cerrar bóveda impide nuevas operaciones y exige política explícita para las ya iniciadas. No prometer borrado perfecto de secretos de memoria en JavaScript.

Conexiones globales no se conceden sólo por nombrarlas en un repo: el usuario autoriza un vínculo local checkout/conexión/permisos. Cambiarlo invalida las aprobaciones pertinentes. Permisos se basan en recurso y operación; el nivel del modelo no otorga privilegios.

## MCP

MCP externo pasa por un gateway/ejecutor con herramientas autorizadas, esquemas conocidos y límites de respuesta. Un nombre de herramienta o anotación «lectura» no demuestra ausencia de efectos. Credenciales con scopes reales y controles del ejecutor imponen privilegios. No ejecutar automáticamente `npx -y` desde una definición recibida: fijar origen y versión e instalar en un paso separado.

URL, redirects y resolución DNS se validan; bloquear destinos internos/metadata fuera de política. Una prueba de conexión puede producir auditoría o efectos en servicios; cada conector define su prueba de menor impacto, no se asume que todo GET es inocuo.

## Protocolo de acciones externas

Propuesta → validación → lectura de precondiciones → vista previa → aprobación → reserva exclusiva → ejecución → comprobación → resultado. La aprobación liga `action_id`, hash del payload, recurso/destino, versión de conexión/política, precondición, expiración y actor. Editar cualquier dato produce nueva propuesta.

Antes de ejecutar se comparan precondiciones con control condicional del servicio cuando exista. Si no admite condición atómica, indicar ventana de carrera residual; no ofrecer la misma garantía. La idempotency key la genera Forja y se reutiliza sólo para la misma operación. Consumo de aprobación y estado `ejecutando` se registran juntos antes del efecto.

| Resultado | Tratamiento |
|---|---|
| Confirmado y verificable | Guardar comprobante y observación posterior |
| Rechazado sin efecto | Reportar fallo; una nueva propuesta puede autorizar otro intento |
| Timeout tras envío | `resultado_desconocido`; consultar servicio por clave/estado |
| No hay consulta/idempotencia fiable, como envío SMTP simple | No reenviar automáticamente; conciliación humana |
| Efecto parcial | Mostrar estado comprobado y compensación propuesta |

Deshacer es otra acción con nueva autorización; no siempre existe. Restaurar una DB puede perder escrituras posteriores: plan de migración debe evaluar ese impacto, backup restaurable y alternativas. SSH arbitrario y migraciones productivas se posponen, no se esconden detrás de un permiso genérico.

## Logs, UI y datos

Redactar antes de persistir y antes de mostrar: stdout, stderr, errores, artefactos de depuración y transcripciones propias. El redactor de stream conserva fragmentos para detectar secretos partidos entre chunks; aplica límites de memoria. Escaneo conocido y heurístico no detecta todas las transformaciones: la prevención principal es no dar secretos al agente.

Auditar también archivos que escriben directamente los CLI. Si Forja no controla ese almacenamiento, registrarlo como limitación y no afirmar «cero secretos en todo el host». Preguntar por secretos o enviarlos a un modelo para clasificarlos no es aceptable.

API local en loopback, sesión privada, cookies HttpOnly/SameSite, CSRF para mutaciones, validación de Host/Origin y sin CORS abierto. El token no va en URLs/logs. Markdown, terminal y nombres de archivo se escapan, incluidos controles ANSI peligrosos. Túneles y acceso remoto están fuera del MVP.
