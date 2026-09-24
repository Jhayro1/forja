# Contratos documentales v2

Estos contratos son normativos para el diseño y deberán implementarse como esquemas y validadores en V2-011. No se incluyen esquemas ejecutables ni SDK. Separar `schema_version` (forma del documento) de `revision` (contenido). Una revisión incompatible se rechaza; migración explícita con backup y diff, nunca silenciosa.

| Documento | Define |
|---|---|
| [Especificación y configuración](especificacion-y-configuracion.md) | Spec, plan, tareas, perfil, aprobaciones y generación |
| [Estado y protocolos](estado-y-protocolos.md) | Eventos, almacenamiento, runner, proveedor, evidencia y acciones |
| [Estado del planeador](../13-planeador-proactivo-y-prompts.md) | Contrato por turno, propuestas, cobertura, contradicciones y procedencia de decisiones |

Reglas comunes: UTF-8; fechas UTC ISO-8601; duración en ms; tamaños en bytes; dinero en unidades enteras de micro-USD y moneda explícita cuando aplique. Tokens como enteros no negativos o desconocidos. IDs opacos de ejecución; IDs documentales estables y globalmente únicos dentro de la spec. Referencias inexistentes son error.

Hash SHA-256 con algoritmo declarado. JSON se canonicaliza con orden estable de claves y representación determinista; arrays mantienen orden salvo colecciones declaradas como conjuntos, ordenadas por ID. Hash de archivo usa bytes exactos. Guardar versión de canonicalización para evitar aprobaciones ambiguas.

Campos desconocidos en configuración con efectos se rechazan; extensiones sólo bajo namespace reservado. Campos desconocidos no críticos del proveedor no invalidan observación, pero nunca se interpretan como autorización. Rutas relativas normalizadas, sin `..` ni escapes por symlink. Límites de bytes, profundidad y cardinalidad se aplican antes de procesar.
