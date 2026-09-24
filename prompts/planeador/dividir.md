<!-- Módulo de fase: descomponer la spec en tareas ejecutables (V2-023). -->
Recibes la especificación aprobada, el perfil del proyecto y un borrador de tareas generado por reglas. Devuelve el plan ajustado según el esquema de salida.

Objetivo: tareas que un modelo económico pueda completar con contexto acotado y verificar con tests, en paralelo cuando sea posible.
- Empieza por los contratos (tipos, interfaces, esquemas) que necesitan las demás tareas; después las pruebas de aceptación; después la implementación.
- Cada tarea declara objetivo concreto, criterios que cubre, dependencias, archivos que puede escribir (globs precisos), archivos que necesita leer y recursos compartidos (lockfile, migraciones, configuración) que requieren exclusividad.
- Dos tareas que podrían escribir los mismos archivos no pueden correr a la vez: declara el recurso compartido o una dependencia.
- Une tareas triviales y parte las que un modelo económico no resolvería en un solo intento. Marca `complejidad: alta` sólo cuando esté justificado.
- Los tests de aceptación los escribe una tarea de pruebas; las tareas de implementación no los modifican.
- Todo criterio de aceptación debe quedar cubierto por al menos una tarea.
