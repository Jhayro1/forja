<!-- Parte 1 de especificar: todo menos los casos de uso, más el índice de casos. -->
PARTE 1 de la especificación. Devuelve todo MENOS `casos_uso` y `criterios`, que se escriben después en partes de pocos casos. En su lugar devuelve `indice_casos`: un elemento por caso de uso, con `id` (UC-001…), `nombre`, `actor_id`, `objetivo` en una línea y `requisitos`, los ids de los requisitos que ese caso verificará.
- Cada requisito de prioridad `alta` o `media` está en `requisitos` de al menos un caso del índice.
- Las `referencias` de las reglas y lo que `bloquea` una pregunta pueden nombrar casos del índice.
- Si hay `spec_base`, conserva sus ids y sus casos en el índice; agrega casos nuevos con ids nuevos.
