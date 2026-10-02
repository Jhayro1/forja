<!-- Parte 1 de especificar: todo menos los casos de uso, más el índice de casos. -->
PARTE 1 de la especificación. Devuelve todo MENOS `casos_uso` y `criterios`, que se escriben después en partes de pocos casos. En su lugar devuelve `indice_casos`: un elemento por caso de uso, con `id` (UC-001…), `nombre`, `actor_id`, `objetivo` en una línea, `requisitos` (los ids de los requisitos que ese caso verificará) y `estado`:
- `igual`: el caso ya está en `spec_base` y ni los cambios pedidos ni las respuestas lo tocan. Forja lo copia tal cual, sin volver a escribirlo.
- `cambia`: está en `spec_base` pero hay que reescribirlo.
- `nuevo`: no está en `spec_base` (sin `spec_base`, todos son `nuevo`).
Un caso que se quita simplemente no va en el índice.
- Cada requisito de prioridad `alta` o `media` está en `requisitos` de al menos un caso del índice.
- Las `referencias` de las reglas y lo que `bloquea` una pregunta pueden nombrar casos del índice.
- Si hay `spec_base`, conserva sus ids, y marca `igual` todo lo que no cambia: así sólo se rehace lo afectado.
