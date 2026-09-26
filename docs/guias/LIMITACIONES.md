# Limitaciones conocidas

Se publican para que decidas con información (v2/11 · M4). Se actualizan en cada versión.

- **Instalable sólo en Linux** (`package.json` lo bloquea a propósito). El sandbox principal es bubblewrap. Si bwrap no funciona en tu máquina Linux (por ejemplo, AppArmor bloqueando *user namespaces* en Ubuntu 24.04+), Docker es un segundo backend **real y probado** (`forja doctor` lo detecta solo): ver [ADR-012](../decisiones/ADR-012-aislamiento-docker.md). En macOS no hay aislamiento equivalente todavía: hay un prototipo con Seatbelt sin probar ni conectar ([ADR-010](../decisiones/ADR-010-aislamiento-macos.md)). En Windows nativo (fuera de WSL2) tampoco: ni el prototipo de AppContainer + Job Object ([ADR-011](../decisiones/ADR-011-aislamiento-windows.md)) ni Docker están conectados de verdad ahí — un binario de Windows/macOS no corre dentro de un contenedor Docker (siempre Linux por dentro), así que el backend de Docker sólo sirve hoy en hosts Linux. La única vía soportada para Windows sigue siendo WSL2.
- **Pensado para TypeScript/JavaScript.** Otros stacks funcionan si el perfil del plan define sus
  comandos, pero la detección y la verificación están probadas sobre TS/JS.
- **Estimaciones sin calibrar** hasta correr `forja piloto` con runs reales en tu proyecto.
- **La ejecución con Claude y Codex reales** se probó por partes (conformidad y planificación
  reales en M0–M2); el recorrido completo de ejecución en paralelo se probó con agentes simulados.
- **Una ejecución a la vez por proyecto**; la integración es de a una tarea (segura, pero en serie).
- **Cambiar la especificación a mitad de run** no está soportado: sí cambiar el plan (`forja dividir`).
- **El panel web es local** (127.0.0.1): no hay acceso remoto ni multiusuario.
- El consumo de Codex se conoce al final de cada llamada; mientras trabaja se muestra como desconocido.
- **El gateway MCP con Claude y Codex reales** no se probó todavía (sí con el agente simulado dentro del sandbox).
- **Las acciones externas** se ejecutan desde la terminal (necesitan la bóveda); el panel sólo aprueba o descarta.
  Hay una operación de referencia (`http.json`); correo, DNS y otras llegarán como operaciones tipadas.
- **El ejecutor de acciones** es un proceso separado con entorno vacío, pero todavía no corre dentro de bubblewrap.
- **La memoria en grafo es sintáctica**: TS/JS y Python. No sigue llamadas entre funciones, imports dinámicos
  ni alias de tsconfig (quedan listados como «sin resolver»). La ausencia de una relación no prueba ausencia de impacto.
  El modo `grafo` es opcional hasta que `forja memoria evaluar` muestre mejora con tu historial.
