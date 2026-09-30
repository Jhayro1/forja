# ADR-016 · Edición ligera y modo «directo»

**Estado:** aceptada · 2026-09-30 · plan en [ligera/PLAN.md](../../ligera/PLAN.md)

## Contexto

Instalar Forja Completa en Windows exige WSL2, una distro de Linux, un usuario, bubblewrap y
copias propias de Claude Code y Codex. Todo eso sirve a una decisión: varios agentes trabajan
**sin supervisión y en paralelo**, y cada uno debe quedar encerrado en un sandbox que en Linux
da bwrap (ADR-010/011/012).

Hay otro uso igual de válido. La persona ya tiene Claude Code y Codex en su PC, quiere
instalar en minutos y prefiere que **un solo agente** avance un bloque de tareas con memoria
continua, aunque tarde más.

## Decisión

1. **Una sola base de código, dos ediciones.** `FORJA_EDICION=ligera` la fija el binario del
   paquete `@jhayro1/forja-ligera` (`dist/cli/bin-ligera.js`). No hay fork: los arreglos llegan a
   las dos.
2. **Modo de ejecución `directo`** (`sandbox.mode: directo` en la orden del runner). El agente
   corre como el usuario, sin bwrap ni Docker. Lo que sí queda:
   - un worktree y una rama `forja/…` por tarea; la rama principal nunca se toca;
   - el sandbox propio de Codex (`-s workspace-write`) y los permisos restringidos de Claude
     Code (`--permission-mode dontAsk`, herramientas fijas, `--strict-mcp-config`, sin
     configuración de usuario);
   - un entorno construido con la lista blanca de `security/env.ts`: nunca llega una variable
     con forma de credencial;
   - el tachado de credenciales en los registros y el escaneo del diff antes de unir.
   El runner es dueño del árbol de procesos: grupo propio en POSIX, `taskkill /T` en Windows.
3. **Un agente por bloque.** `forja run --tareas/--bloque/--modelo` y el botón «Ejecutar con un
   agente» del tablero:
   - sólo una tarea en camino a la vez;
   - todas en una misma carpeta (`worktrees/<run>/_agente`), porque Claude Code guarda sus
     sesiones por carpeta;
   - cada tarea reanuda la sesión de la anterior (`--resume`, `exec resume`) mientras su
     contexto esté bajo `ejecucion.sesion_max_tokens`;
   - si pasa ese límite, la tarea arranca una sesión nueva con el registro de equipo como
     resumen;
   - el bloque se detiene en la primera tarea que necesita al usuario.
   En la edición ligera, `forja run` sin opciones es un bloque con todo lo pendiente.
4. **Windows nativo** para esta edición:
   - Los `.cmd` de npm se resuelven a su script de Node, nunca pasan por `cmd.exe`.
   - Las señales se reemplazan por archivos de parada: `detener-run`, `<trabajo>/detener` y el
     archivo `cancelar` del lanzamiento.
   - Los bloqueos no necesitan `/proc`.
   - El gateway MCP usa tuberías con nombre.

## Consecuencias

- **Aviso permanente.** La edición ligera no aísla al agente del resto del equipo, y se dice
  siempre: en `forja doctor` (chequeo «Aislamiento») y en el panel (etiqueta «Ligera · modo
  directo»).
  - Para repos con secretos de producción sigue recomendada Forja Completa.
- **Instalación.** La ligera se instala con `scripts/ligera.ps1` o `scripts/ligera.sh`:
  - usan el Node del usuario o uno portable verificado por SHA-256;
  - instalan el paquete ya compilado del release, sin compilar nada;
  - no piden permisos de administrador.
- **CI.** Corre en `windows-latest` las pruebas de la edición ligera y el instalador de
  PowerShell 5.1.
- **Queda abierto** (ADR-011): el aislamiento nativo de Windows (AppContainer), que daría a la
  edición ligera un sandbox propio sin WSL.
