# Forja Ligera · plan de desarrollo

**Estado:** propuesta · 2026-09-30 · rama `ligera/plan`

## 1. Objetivo

Una segunda versión de Forja que se instala **con un solo comando, en un par de minutos y sin
instalar casi nada**: ni WSL, ni Ubuntu, ni usuario Linux, ni una copia aparte de Claude Code o
Codex. Usa el `claude` y el `codex` que ya tienes en tu PC, con las sesiones que ya iniciaste.

Cambia también la forma de ejecutar. En vez de varios agentes en paralelo, **un solo agente
recorre la tarea o el bloque de tareas que tú elijas**, con el modelo que tú elijas (Sonnet,
Opus o un modelo de Codex), y **conserva su memoria de una tarea a la siguiente**. Se sacrifica
velocidad a cambio de coherencia; la idea es probar si así el sprint sale mejor.

## 2. Dos versiones, una sola base de código

| | **Forja Completa** (la actual, v0.2.x) | **Forja Ligera** (nueva, v0.3.0) |
|---|---|---|
| Para qué | Servidor/VPS, varios agentes sin supervisión | Tu PC, rápido y simple |
| Instalación | WSL + distro + CLIs propias, o VPS | Un comando; sólo Node y Git (si faltan) |
| Agentes | Varios en paralelo, con registro de equipo | Uno solo, por tarea o bloque |
| Memoria entre tareas | Registro de equipo (resúmenes) | La misma sesión del agente continúa |
| Aislamiento | Sandbox propio (bwrap/Docker) | Sin sandbox propio: rama/worktree aparte + los límites del propio CLI |
| Cuentas | Varias por proveedor, CLIs dentro de Forja | Las de tu PC (`~/.claude`, `~/.codex`) |
| Plataformas | Linux, WSL, VPS | Windows nativo, macOS, Linux |
| Planificación, revisión, QA, observaciones, historial, PR | Sí | Sí (lo mismo) |

**Decisión: no hacer un fork separado del repositorio.** Un fork se desincroniza en semanas y
cada arreglo habría que hacerlo dos veces. En su lugar:

- el mismo repositorio y el mismo núcleo (planificación, eventos, revisión, QA, PR, panel);
- una **edición** elegida al instalar: `edicion: completa | ligera` en la configuración global;
- dos paquetes y dos instaladores publicados desde el mismo código:
  `@jhayro1/forja` (completa) y `@jhayro1/forja-ligera` (ligera);
- la versión completa queda congelada en la etiqueta `v0.2.0` y sigue funcionando tal cual en
  forja.winkstec.com; **nada de este plan toca ese despliegue**.

Si en algún momento se quiere separar del todo, el paquete ligero ya estaría aislado y se podría
mover a su propio repositorio sin reescribir nada.

## 3. Qué pasa con «las sesiones abiertas en el navegador»

Forja **no puede usar la sesión de claude.ai o chatgpt.com que tienes abierta en el navegador**.
Técnicamente sería leer las cookies del navegador, y además va contra los términos de ambos
servicios. Lo que sí se puede, y es lo que hace esta versión:

- si ya iniciaste sesión en `claude` y `codex` en tu PC, Forja usa esa sesión directamente;
- si no, el botón «Conectar» ejecuta `claude` / `codex login`, que **abre tu navegador**; como
  ya estás dentro de claude.ai o chatgpt.com, es un clic en «Autorizar».

## 4. Fases

Cada fase termina con pruebas en verde y un PR contra `main`; nada se publica hasta la fase 8.

### F1 · Núcleo portable (Windows y macOS nativos)

Lo que hoy sólo funciona en Linux:

| Pieza | Hoy | Cambio |
|---|---|---|
| `registry/lock.ts` | Identidad del proceso leída de `/proc/<pid>/stat` | Identidad portable: pid + marca aleatoria en el archivo de latido; `process.kill(pid, 0)` para saber si vive |
| Gateway MCP y proxy (`mcp/gateway.ts`, `runtime/netproxy.ts`) | Sockets Unix `p.sock` | En Windows, tubería con nombre (`\\.\pipe\forja-…`); en la edición ligera sin sandbox basta `127.0.0.1` con token |
| `cli/jobs.ts`, `cli/job-main.ts` | `process.kill(-pid)` (grupo de procesos) | En Windows, `taskkill /T /F /PID` |
| Comandos de verificación del perfil | Supone `bash` | `shell: true` con el intérprete del sistema; el perfil puede traer comandos por plataforma |
| `package.json` | `"os": ["linux"]` | Sin restricción para `forja-ligera` |
| `node:sqlite`, git worktrees, panel | Ya portables | Sin cambios; se prueba en CI |

Criterio: la suite actual pasa en `windows-latest`, `macos-latest` y `ubuntu-latest` (matriz de CI).

### F2 · Modo de ejecución «directo» (sin sandbox propio)

- Nuevo modo `sandbox.mode: directo`, basado en el camino `ninguno` que ya existe en
  `runtime/runner.ts` (hoy sólo para pruebas).
- Qué **sí** limita, aunque no haya sandbox:
  - cada tarea trabaja en su **propio worktree y rama `forja/…`**: tu carpeta y tu `main` no
    se tocan hasta que tú apruebes el PR;
  - **Codex** corre con su sandbox propio (`-s workspace-write`: escribe sólo en el worktree);
    en Windows ese sandbox de Codex se verifica en F1 y, si no está maduro, se avisa;
  - **Claude Code** corre con `--permission-mode` restringido y sin `--add-dir`, con la lista de
    herramientas que ya arma `providers/adapters.ts`;
  - el entorno del agente se limpia (`security/env.ts`): no recibe tokens de GitHub, SMTP ni
    variables de tu sesión;
  - el diff se revisa antes del PR con el escaneo de secretos y operaciones destructivas que ya
    existe (`quality/validate.ts`).
- Qué **no** limita, y se dice claro en el panel y en `forja doctor`: el agente podría leer
  archivos de tu usuario fuera del proyecto (claves SSH, otros repos). Por eso el aviso fijo:
  «Modo directo: el agente tiene tus mismos permisos. Úsalo con proyectos en los que confías».

### F3 · Usar el Claude y el Codex de tu PC

- Detección en el `PATH` de `claude` y `codex` y de su versión; si falta uno, se ofrece el
  comando para instalarlo, pero **no es obligatorio tener los dos**.
- La cuenta `principal` apunta a las carpetas reales (`~/.claude`, `~/.codex`) en vez de a
  copias dentro de Forja (`providers/accounts.ts` ya tiene `configDir`/`envFor`).
- Estado de sesión con los comandos de cada CLI; botón «Conectar» que abre el navegador.
- Las cuentas extra siguen disponibles como opción avanzada, no como requisito.
- La conformidad de modelos (`forja conformidad`) se corre una vez en segundo plano tras
  instalar, para no bloquear el primer uso.

### F4 · Ejecutar con un solo agente: tarea o bloque, con el modelo que elijas

La planificación no cambia: épicas → sprints → historias → tareas, con dependencias.

Nuevo flujo de ejecución:

1. En el tablero eliges **una tarea, varias o un bloque** (una historia o un grupo de tareas).
   Forja agrega las dependencias que falten y te muestra el orden.
2. Eliges **quién lo hace**: un selector con los modelos disponibles de tus CLIs (Sonnet 5.5,
   Opus, gpt-5.6-sol/terra/luna…), con el que recomienda el plan preseleccionado.
3. Un solo agente recorre las tareas **en orden y en la misma sesión**: al pasar de una tarea a
   la siguiente, Forja **reanuda la sesión** (`--resume` en Claude, `exec resume` en Codex, que
   ya usan los adaptadores). Así el agente recuerda lo que hizo antes.
4. Después de cada tarea: commit en la rama del bloque, verificación (pruebas del perfil) y
   punto de control. Si una falla, se detiene y pregunta; no sigue a ciegas.
5. Si la sesión se hace demasiado larga (umbral de tokens), se cierra y la siguiente tarea
   arranca en una sesión nueva con un **resumen de relevo** (lo que ya existe en `run/team.ts`).
6. Al final del bloque: revisión, QA y observaciones como hoy, y PR (nunca merge, nunca `main`).

Implementación: `ejecucion.paralelo: 1` y el filtro `--solo` ya existen; falta aceptar una
**lista** de tareas, mantener la sesión entre ellas y el selector de modelo por ejecución.
CLI: `forja run --bloque H-003 --modelo claude-sonnet-5-5`.

### F5 · Instalador de un comando

**Windows** (PowerShell, sin permisos de administrador):

```powershell
irm https://github.com/Jhayro1/forja/releases/latest/download/ligera.ps1 | iex
```

1. Comprueba Node ≥ 22.13 y Git. Si falta Node, descarga **Node portable** (~30 MB) en
   `%LOCALAPPDATA%\Forja\node`; si falta Git, ofrece `winget install Git.Git`.
2. Descarga el paquete **ya compilado** (panel incluido, sin compilar nada en tu PC).
3. Crea el comando `forja` y un acceso directo «Forja» en el menú Inicio.
4. Detecta `claude` y `codex` y abre el panel.

**macOS / Linux:** `curl -fsSL …/ligera.sh | sh` con los mismos pasos.
**Sin instalar nada:** `npx @jhayro1/forja-ligera`.

Meta medible: **menos de 2 minutos y menos de 60 MB** en un Windows que ya tiene Node, Git y
Claude o Codex. (Hoy: varios GB y 10–20 minutos.)

Desinstalar: `forja desinstalar` borra `%LOCALAPPDATA%\Forja` y el acceso directo; tus
proyectos no se tocan.

### F6 · Panel

- Pantalla de inicio sin pasos de sandbox ni de distro: «Tus agentes: Claude ✓ · Codex ✓».
- Botón **«Ejecutar»** en el tablero con la selección de tareas y el selector de modelo (F4).
- Banner fijo del modo directo (F2).
- Se ocultan en la edición ligera: servidor/login remoto, cuentas múltiples (en «avanzado»),
  paralelismo y registro de equipo.

### F7 · Pruebas

- Matriz de CI Windows/macOS/Linux con el agente simulado (`providers/sim-agent.ts`) de
  principio a fin: planear → bloque de 3 tareas con sesión reanudada → PR simulado.
- Prueba de que el modo directo nunca escribe fuera del worktree con Codex
  (`workspace-write`) y de que la rama principal no cambia.
- Prueba del instalador en una VM Windows limpia (GitHub Actions `windows-latest`), midiendo
  tiempo y tamaño.
- Prueba real en tu PC antes de publicar.

### F8 · Documentación y publicación

- `docs/guias/MANUAL.md`: sección «¿Completa o Ligera?» y guía de la ligera.
- ADR-016 · Edición ligera y modo directo (qué protege y qué no).
- Release `v0.3.0` con `ligera.ps1`, `ligera.sh` y el paquete `forja-ligera.tgz`. Los
  archivos de la v0.2.0 (app `.exe`, distro WSL) siguen publicados para la versión completa.

## 5. Orden y tamaño estimado

| Fase | Depende de | Tamaño |
|---|---|---|
| F1 Núcleo portable | — | Mediano |
| F2 Modo directo | F1 | Chico |
| F3 CLIs de tu PC | F1 | Chico |
| F4 Un agente por bloque | — (se puede hacer en paralelo con F1) | Mediano |
| F5 Instalador | F1–F3 | Chico |
| F6 Panel | F3, F4 | Mediano |
| F7 Pruebas | todas | Mediano |
| F8 Docs y release | F7 | Chico |

Primer hito útil: **F4 + F2 en Linux/WSL** (se puede probar el trabajo con un solo agente sin
esperar a Windows nativo). Segundo hito: **F1 + F3 + F5**, la instalación rápida en Windows.

## 6. Riesgos

- **Sin sandbox propio el agente tiene tus permisos.** Mitigación: worktree + rama, límites del
  CLI, entorno limpio, escaneo del diff y aviso visible. Para repos sensibles (ERP con datos de
  clientes) se recomienda la versión completa.
- **Sandbox de Codex en Windows**: puede ser menos estricto que en Linux; se verifica en F1.
- **Sesiones largas**: el contexto de un solo agente se llena en bloques grandes; mitigado con
  el relevo por resumen (F4.5). Se recomienda bloques de 3–8 tareas.
- **Cambios en los CLIs** (flags de `--resume`, permisos): cubiertos por `forja conformidad`.

## 7. Fuera de alcance

- Usar sesiones del navegador (claude.ai / chatgpt.com) sin pasar por el CLI.
- Modo servidor/VPS en la edición ligera (para eso está la completa).
- Tocar el despliegue actual de forja.winkstec.com.
