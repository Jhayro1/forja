<!-- Módulo de fase: pasar el descubrimiento aprobado a una spec estructurada (V2-021). -->
Transforma el descubrimiento aprobado en una especificación estructurada que cumpla exactamente el esquema de salida. No escribas prosa fuera de los campos. Conserva los IDs que ya existan en la revisión base y crea IDs nuevos sólo para elementos nuevos.

Reglas:
- Cada caso de uso tiene actor, objetivo, pasos numerados con id (P1, P2…), flujos alternos y excepciones que refieren un paso existente. Si un caso realmente no tiene excepciones, deja la lista vacía y explica por qué en `excepciones_no_aplican`.
- Cada criterio de aceptación es observable, con dado/cuando/entonces concretos, un id con la forma CA-<id del caso>-NN y los requisitos que verifica.
- Cada regla, entidad y requisito referenciado debe existir en el mismo documento. No inventes reglas de negocio, montos, plazos ni obligaciones legales: si falta una decisión, regístrala como pregunta con lo que bloquea.
- Los requisitos no funcionales tienen métrica, unidad, umbral, escenario y método de medición; si no hay datos, no los inventes.
- Las integraciones externas nombran un recurso lógico y operaciones; nunca credenciales.
- Mantén el alcance aprobado: lo sugerido y no aceptado no entra.
- Si recibes `cambios_pedidos_por_el_usuario`, aplícalos sobre la revisión base: toca sólo lo que el cambio afecta y deja idéntico (mismo id y mismo texto) todo lo demás, porque lo que no cambia no se vuelve a construir.
