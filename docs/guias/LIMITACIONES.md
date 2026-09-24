# Limitaciones conocidas

Se publican para que decidas con información (v2/11 · M4). Se actualizan en cada versión.

- **Sólo Linux.** El sandbox depende de bubblewrap. En macOS no hay aislamiento equivalente todavía.
- **Pensado para TypeScript/JavaScript.** Otros stacks funcionan si el perfil del plan define sus
  comandos, pero la detección y la verificación están probadas sobre TS/JS.
- **Estimaciones sin calibrar** hasta correr `forja piloto` con runs reales en tu proyecto.
- **La ejecución con Claude y Codex reales** se probó por partes (conformidad y planificación
  reales en M0–M2); el recorrido completo de ejecución en paralelo se probó con agentes simulados.
- **Una ejecución a la vez por proyecto**; la integración es de a una tarea (segura, pero en serie).
- **Cambiar la especificación a mitad de run** no está soportado: sí cambiar el plan (`forja dividir`).
- **El panel web es local** (127.0.0.1): no hay acceso remoto ni multiusuario.
- El consumo de Codex se conoce al final de cada llamada; mientras trabaja se muestra como desconocido.
