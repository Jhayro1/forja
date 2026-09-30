# Forja Ligera

Forja Ligera es la versión de Forja para tu propia PC: **se instala con un comando, en un par
de minutos, sin WSL ni Ubuntu**, y usa el Claude Code y el Codex que ya tienes instalados, con
las sesiones que ya iniciaste.

En vez de varios agentes en paralelo, **un solo agente hace la tarea o el bloque de tareas que
tú elijas**, con el modelo que tú elijas, una tarea tras otra **en la misma sesión**: recuerda lo
que hizo en las anteriores. Es más lento que varios en paralelo, pero más coherente.

La planificación, la revisión, la QA, las observaciones, el historial y el PR a GitHub son los
mismos de Forja Completa. Nunca se hace merge ni se toca la rama principal.

## Instalar

**Windows** (PowerShell, sin permisos de administrador):

```powershell
irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/ligera.ps1 | iex
```

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/ligera.sh | sh
```

Qué hace el instalador:

1. Usa tu Node (22.13 o más nuevo). Si no tienes, baja **Node portable** (~30 MB) solo para
   Forja, verificado con su SHA-256 oficial.
2. Revisa Git. En Windows, si falta, lo instala con `winget`, que puede pedir permiso.
3. Instala Forja Ligera **ya compilada**: no se compila nada en tu PC.
   - Windows: en `%LOCALAPPDATA%\Forja`.
   - macOS/Linux: en `~/.local/share/forja-ligera`.
4. Deja el comando `forja` y, en Windows, un acceso **Forja** en el menú Inicio.
5. Te dice si encontró Claude Code y Codex, y abre el panel.

Necesitas **al menos uno** de los dos agentes con sesión iniciada. Si no los tienes, el panel
los instala. Para iniciar sesión, el botón «Conectar» ejecuta `claude` o `codex login`, que
abren tu navegador. Si ya estás dentro de claude.ai o chatgpt.com, basta con un clic en
«Autorizar».

> Forja no usa la sesión que tienes abierta en el navegador. Hacerlo sería leer las cookies
> del navegador, algo que ambos servicios prohíben. Siempre pasa por el CLI oficial.

## Usar

1. `forja ui` (o menú Inicio → Forja) abre el panel. Agrega tu proyecto (una carpeta con Git).
2. **Sprint actual**: cuéntale a Forja qué quieres. Responde sus preguntas, divide en tareas y
   aprueba el plan.
3. **Tablero → Ejecutar con un agente**:
   - Elige las tareas, o todas las pendientes, y **quién lo hace**: Sonnet, Opus, un modelo de
     Codex…
   - Si una tarea depende de otra que no está hecha, Forja la agrega al bloque.
4. El agente hace las tareas **en orden y en la misma sesión**. Después de cada una, Forja:
   - la verifica con las pruebas del proyecto y la revisa;
   - la une a la rama del sprint.
   Si una falla, **se detiene y te pregunta**: no sigue a ciegas.
5. Al terminar el sprint: **Calidad** (QA y auditoría) y **Entrega** (rama y PR en GitHub, si
   configuraste el token).

Desde la terminal hace lo mismo:

```sh
forja run --tareas T-001,T-003 --modelo claude:sonnet   # esas tareas (y sus dependencias)
forja run --bloque CU-01 --modelo codex:gpt-6-sol       # todas las de un caso de uso
forja run                                               # todo lo pendiente, un agente
```

Si la sesión del agente se llena, la siguiente tarea empieza una sesión nueva con el resumen de
lo hecho. El límite es `ejecucion.sesion_max_tokens`, 140 000 tokens por defecto.

## Qué protege y qué no

Forja Ligera **no tiene el aislamiento propio de Forja Completa** (el sandbox de Linux). A
cambio, no necesita WSL ni Docker.

**Lo que sí protege:**

- Cada tarea trabaja en **su propia carpeta y rama** `forja/…`. Tu carpeta y tu rama principal
  no cambian hasta que tú apruebes el PR. Si algo sale mal, se descarta esa rama.
- **Codex** corre con su propio sandbox (`workspace-write`): sólo escribe dentro de esa
  carpeta.
- **Claude Code** corre con permisos restringidos y sin tus plugins ni servidores MCP.
- El agente **no recibe tus variables de entorno**: ni tokens de GitHub, ni la clave SMTP, ni
  nada con «TOKEN», «SECRET» o «KEY» en el nombre. Tus credenciales de Claude/Codex se tachan
  de todos los registros.
- Antes de unir un cambio, Forja busca secretos y operaciones destructivas en el diff.

**Lo que no protege:** el agente tiene **tus mismos permisos** en el resto del equipo. Un agente
que se equivoca o al que engaña un archivo malicioso podría leer archivos de tu usuario fuera
del proyecto. El panel lo recuerda con la etiqueta «Ligera · modo directo».

Úsala con proyectos en los que confías. Para repos con datos sensibles (claves de producción,
datos de clientes), usa **Forja Completa**, que aísla cada agente (WSL, app de escritorio o
servidor): ver [MANUAL.md](MANUAL.md).

## Desinstalar

- **Windows:** borra la carpeta `%LOCALAPPDATA%\Forja` y el acceso «Forja» del menú Inicio.
  Quita esa carpeta de tu PATH de usuario, si quieres.
- **macOS/Linux:** `rm -rf ~/.local/share/forja-ligera ~/.local/bin/forja`.

Tus proyectos, los datos de Forja (`~/.forja`) y tus sesiones de Claude/Codex no se tocan.
