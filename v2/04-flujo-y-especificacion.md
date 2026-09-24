# Flujo, especificación y generación

## Un incremento por vez

El acompañamiento de ideas y mejoras se define en [Planeador proactivo y prompts internos](13-planeador-proactivo-y-prompts.md). El planeador debe descubrir necesidades omitidas y sugerir soluciones justificadas, además de preguntar y documentar. Sus prompts, matriz de cobertura, estado por turno y reglas de cierre forman parte de M2.

1. **Analizar:** inventario estático y evidencias del repo; baseline dinámico opcional tras aprobar entorno y perfil.
2. **Descubrir:** objetivo, actores, alcance, datos, reglas, alternativas, restricciones, riesgos y dudas. Máximo tres preguntas prioritarias por tanda; sugerencias identificadas como tales.
3. **Especificar:** requisitos y criterios con IDs; conservar razones y ejemplos cuando evitan ambigüedad. JSON no significa «sin explicación».
4. **Dividir:** contratos, pruebas y tareas verticales; DAG, recursos compartidos, presupuesto y riesgos.
5. **Aprobar:** revisión exacta de spec y plan, perfil de ejecución, conexiones y política. Aprobación de descubrimiento no autoriza ejecución.
6. **Ejecutar, verificar e integrar:** ciclo por tarea; las dependencias integradas desbloquean siguientes tareas. No esperar que termine una fase global para verificar.
7. **Entregar:** rama local e informe con criterios cubiertos, pendientes y evidencia. Push, PR o despliegue no están implícitos.

## Especificación suficiente

La puerta comprueba integridad referencial, IDs únicos, criterios observables, límites de alcance, dependencias sin ciclos, comandos concretos y ausencia de preguntas bloqueantes. Una duda diferida declara responsable, condición para resolver y tareas que bloquea; no basta `decidir_despues: true`.

Cada caso analiza excepciones. Si no aplican, incluye justificación revisable; no se inventa una excepción para satisfacer una cantidad. Los requisitos no funcionales declaran métrica, unidad, escenario, carga y umbral. Criterios sin automatización declaran evidencia manual y quién debe aceptarla.

## Generación

El planeador produce cambios estructurados contra una `revision_base`. Forja valida y aplica atómicamente; dos respuestas concurrentes no pueden sobrescribir la misma revisión. Límite inicial: dos reparaciones de formato y tres de completitud por operación; después se bloquea con diagnóstico y conserva respuesta redactada.

Plantillas generan casos, reglas, glosario, trazabilidad y plan de pruebas. Gherkin es opcional según stack; producir `.feature` no produce un test ejecutable. Un test pendiente no satisface un criterio ni puede ocultarse entre pruebas verdes.

Un manifiesto de generación guarda versión de plantilla, hash de fuente y hash del contenido emitido. Si la fuente cambia y el documento fue editado, se genera propuesta de diferencia separada. Markdown editado a mano no reescribe automáticamente el JSON: el usuario incorpora cambios explícitamente. La regeneración sin cambios hace cero llamadas de modelo y no reescribe archivos.

## Descomposición del trabajo

La unidad es un incremento comprobable, no «una entidad = varias tareas obligatorias». Empezar por los contratos necesarios para el siguiente incremento. Pruebas de aceptación siguen a sus contratos y preceden a implementación; no pueden depender circularmente de esta última para estar definidas.

Cada tarea contiene objetivo, criterios, evidencia esperada, dependencias, permisos, recursos exclusivos, política de archivos, presupuesto y timeout. Archivos compartidos, migraciones, lockfiles y generación de clientes requieren serialización o tarea propietaria. Si dos globs podrían solaparse y no se puede demostrar independencia, se usa un bloqueo común; no basta mirar archivos que ya existen.

El scheduler usa un DAG dinámico. «Olas» son una presentación útil, no una barrera que obligue a esperar trabajos independientes lentos.

## Cambio de alcance durante un run

Crear nueva revisión; calcular afectados directos y dependientes transitivos, incluidos contratos, tests, contexto y permisos. Con incertidumbre de referencias, ampliar el conjunto. Detener sus nuevos lanzamientos, revocar la aceptación de resultados antiguos y solicitar parada de runners afectados. Guardar sus diffs como evidencia.

Las tareas integradas no desaparecen: se crean tareas compensatorias aprobables. Cambios de títulos o notas editoriales explícitas pueden no invalidar; modificar texto de una regla, criterio o contrato **es semántico por defecto**. La aprobación parcial incluye el conjunto de tareas y entradas sin cambios que siguen autorizadas. Ningún worker viejo puede publicar bajo la nueva revisión.

## Preguntas y decisiones

Un worker envía una solicitud estructurada con tarea, revisión, duda, alternativas y elementos bloqueados. No se interpreta cualquier frase de stdout como comando. Si el adaptador no tiene herramienta bidireccional, el worker termina con `necesita_aclaracion`; Forja conserva workspace y continúa en otro lanzamiento cuando haya respuesta.

Búsqueda exacta por IDs puede devolver decisiones con fuente vigente. Una coincidencia textual ambigua no se presenta como respuesta cierta. El planeador puede resolver detalles dentro del alcance; cambios de negocio, permisos o presupuesto pasan por el usuario. La confianza declarada por el modelo no concede autoridad.
