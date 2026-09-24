# Spec, configuración y tareas

## Spec v2

| Campo | Tipo / obligación | Regla |
|---|---|---|
| schema_version, revision | entero = 2; entero positivo | Revisiones monotónicas por cambio |
| project_id, change_id | IDs requeridos | Sin rutas ni secretos |
| sistema | nombre, objetivo, alcance[], fuera_de_alcance[] | Objetivo observable y frontera explícita |
| actores | objetos id, nombre, tipo | Tipo humano o sistema |
| terminos | término, definición | Únicos por término normalizado |
| requisitos | id, texto, prioridad, origen | Referencias verificables a necesidad/decisión |
| entidades | id, nombre, campos[], relaciones[], invariantes[] | Campos con tipo, nulabilidad, unidad/restricción cuando aplique |
| reglas | id, texto, alcance, referencias[] | Relacionadas con requisitos/casos/entidades |
| casos_uso | id, actor_id, objetivo, pre/postcondiciones, pasos con id, alternos, excepciones, criterios[] | Alternos y excepciones refieren paso_id existente |
| criterios | id global, requirement_ids[], dado, cuando, entonces, tipo_evidencia | IDs como CA-UC-001-01; automático o manual |
| contratos | id, descripción, productores[], consumidores[], versión | Pueden referir tipos/endpoints/eventos sin implementar aún |
| rnf | id, métrica, unidad, umbral, comparador, escenario, carga, método | Sin umbrales aislados de contexto |
| integraciones | id, tipo, recurso lógico, operaciones, sensibilidad | Referencias de conexión sin credenciales |
| decisiones | id, texto, motivo, alternativas, sobre[], estado | Propuesta/aprobada/sustituida |
| preguntas | id, texto, bloquea_ids[], responsable, estado, condición_resolución | Una pregunta pendiente sobre alcance a ejecutar bloquea la puerta |

Ejemplo conceptual consistente: A-001 Desarrollador realiza UC-001 Registrar proyecto; REQ-001 exige distinguir clones; R-001 exige checkout independiente; E-001 Proyecto y E-002 Checkout son entidades declaradas; CA-UC-001-01 verifica que dos rutas del mismo project_id producen checkout_id diferentes. Todas esas referencias deben existir dentro del documento real. Este ejemplo no representa un spec completo.

Validaciones: IDs y referencias, campos requeridos, criterios por requisito entregable, excepciones o justificación de no aplicabilidad, sin preguntas bloqueantes en el alcance aprobado, interfaces coherentes y límites de tamaño. Validar estructura no prueba corrección del negocio.

## Configuración `forja.yaml`

| Sección | Contenido permitido |
|---|---|
| versión/proyecto | schema_version, project_id, nombre |
| roles | proveedor, modelo solicitado, opciones admitidas y alternativas explícitas |
| ejecución | concurrencia local/global solicitada, timeout, intentos de calidad, backend de aislamiento requerido |
| presupuesto | máximos por tarea/run/día y política ante medición ausente |
| contexto | límite por perfil, exclusiones y fuentes obligatorias |
| perfil | stack, gestor/versión, comandos por nombre con executable/args/cwd, servicios de test |
| política | rutas editables sugeridas, red/herramientas solicitadas, recursos exclusivos |
| conexiones | referencias lógicas solicitadas, sin scopes concedidos ni valores |
| Git | rama destino de lectura; namespace de ramas de Forja |

La configuración del repo es una solicitud no confiable. Política local aprobada intersecta capacidades y permisos; el repo no puede ampliar su propio sandbox, conectar secretos globales ni modificar presupuestos autorizados. Guardar la configuración efectiva resuelta y su hash. Comandos son executable + args, no shell libre; si un stack requiere shell, usar receta explícita revisada dentro del sandbox.

## Plan y tarea

Plan: schema_version, plan_id, revision, spec_revision/hash, tasks[], profile_hash, policy_hash, base_sha, estimación y preguntas bloqueantes. Su hash cubre todos los campos ejecutables. Un run fija el plan; cambiarlo requiere nueva revisión y procedimiento de invalidación.

Tarea: id, revision, título, objetivo, tipo, requirement_ids[], criterion_ids[], depende_de[], contratos_consumidos/producidos[], read_paths[], write_globs[], protected_paths[], resources_exclusive[], risk, role_profile, capabilities_required[], verification_manifest_id, context_policy, timeout_ms, budget, notas y origin_hash.

`ola` y `estado` son proyecciones, no campos que el modelo pueda fijar como verdad. `risk` no decide permisos por sí solo. Dependencias de una tarea siempre refieren tareas del plan o resultados externos explícitamente fijados por versión/hash.

## Aprobación

approval_id, actor local autenticado, issued_at, expires_at opcional para plan, target_type/id/hash, spec_revision, plan_revision, profile_hash, policy_hash, allowed_task_ids[], conexiones y límites autorizados, estado (vigente/revocada/consumida/obsoleta), request_id.

Para plan, autorización puede cubrir lanzamientos/reintentos definidos dentro del límite; no se consume con el primer proceso. Para acción externa, es de un solo uso y expiración obligatoria. Comparar hashes al reservar y al publicar resultados. Cambios de política, destino o contrato anulan la autorización correspondiente.

## Manifiestos

Generación: path, source_ids/hashes, template_version, rendered_hash, fecha de operación. Fecha no forma parte del contenido renderizado si impediría idempotencia.

Verificación: verification_id, criterion_ids, test_paths/hashes, runner/config/fixture hashes, command recipes, expected_test_ids/count, ambiente/servicios y excepciones aprobadas. No aceptar únicamente el exit code como evidencia de cobertura.
