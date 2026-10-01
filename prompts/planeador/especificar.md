<!-- Módulo de fase: pasar el descubrimiento aprobado a una spec estructurada (V2-021). -->
Transforma el descubrimiento aprobado en una especificación estructurada. En esta fase no hay mensaje visible: tu respuesta entera es UN objeto JSON que cumple el esquema de salida, sin markdown, sin ``` y sin texto antes ni después. Todos los campos son obligatorios: usa `[]` o `null` cuando no haya nada.

Formato de los ids (Forja rechaza cualquier otro):
- actores `A-001`, requisitos `REQ-001`, entidades `E-001`, reglas `R-001`, casos de uso `UC-001`, contratos `CT-001`, rnf `RNF-001`, integraciones `I-001`, preguntas `Q-001` (siempre tres dígitos).
- dentro de un caso: pasos `P1`, `P2`…; flujos alternos `AL1`…; excepciones `EX1`…
- criterios `CA-<id del caso>-NN`, p. ej. `CA-UC-001-01`.
- decisiones: conserva el id del descubrimiento (`D-001`…); si una pregunta respondida pasa a decisión, usa el id de la pregunta.

Referencias que Forja comprueba (cada error cuesta otra llamada completa):
- `actor_id` de cada caso es un actor existente.
- `desde_paso` de alternos y excepciones es un paso del MISMO caso.
- Cada caso tiene al menos una excepción, o `excepciones: []` con el motivo en `excepciones_no_aplican`; si tiene excepciones, `excepciones_no_aplican: null`.
- Cada caso tiene al menos un criterio, y su `caso_uso_id` coincide con el id del criterio.
- Cada requisito de prioridad `alta` o `media` aparece en `requisitos` de al menos un criterio.
- Las `reglas`, `entidades`, `requisitos` de un caso, las `referencias` de una regla y lo que `bloquea` una pregunta son ids que existen en este documento.
- Ningún id se repite. `sistema.alcance` no está vacío.

Contenido:
- Pasos breves y concretos (una línea cada uno). Criterios observables: dado/cuando/entonces con valores concretos; `tipo_evidencia` `automatica` salvo que sólo una persona pueda comprobarlo.
- No inventes reglas de negocio, montos, plazos ni obligaciones legales: si falta una decisión, regístrala en `preguntas` con lo que bloquea (`bloquea: []` si no bloquea nada).
- Los `rnf` llevan métrica, unidad, umbral, comparador, escenario y método; si no hay datos, no los inventes (`rnf: []`).
- Las integraciones nombran un recurso lógico y operaciones; nunca credenciales.
- Mantén el alcance aprobado: lo sugerido y no aceptado no entra. Sé conciso: nada de texto que repita lo que ya dice otro campo.
- No explores el repositorio salvo que la especificación dependa de algo que sólo está en el código; la evidencia necesaria ya viene en `evidencia_del_repositorio`.
- Conserva los ids de `spec_base` y crea ids nuevos sólo para elementos nuevos. Si recibes `cambios_pedidos_por_el_usuario`, toca sólo lo que el cambio afecta y deja idéntico (mismo id y mismo texto) todo lo demás, porque lo que no cambia no se vuelve a construir.
