# Instalar Forja

## Requisitos

| Qué | Por qué |
|---|---|
| Linux (x86_64 o arm64) | El aislamiento de los agentes usa bubblewrap, que sólo existe en Linux. En Windows, usa WSL2 |
| Node.js ≥ 22.13 (22 LTS o 24) | Forja usa `node:sqlite`, disponible sin bandera desde 22.13; el CI prueba Node 22 y 24 |
| Git ≥ 2.40 | Worktrees por tarea y ramas de integración |
| bubblewrap (`bwrap`) | Sandbox de cada agente: sin red salvo la API de su proveedor, sin tu HOME |
| Claude Code y/o Codex con sesión iniciada | Forja usa tus suscripciones a través de los CLI oficiales; nunca te pide ni copia credenciales |

```bash
sudo apt install bubblewrap git          # Debian/Ubuntu
npm install -g @anthropic-ai/claude-code && claude          # inicia sesión
npm install -g @openai/codex && codex login                 # opcional, recomendado
npm install -g @jhayro1/forja
forja doctor
```

## Instalación de un solo comando (mientras no esté publicado en npm)

El paquete todavía no está en el registro de npm, así que el comando de arriba no funciona
todavía. Hasta que se publique, este script hace lo mismo en un solo paso, dentro de Linux
o de tu distro WSL2 (nunca en PowerShell/CMD): instala lo que falte (git, bubblewrap y
Node 22 vía nvm; puede pedirte tu contraseña de Linux), clona, compila, empaqueta e
instala global, y deja un lanzador en `/usr/local/bin/forja` para que `forja` funcione
también fuera de una terminal interactiva.

```bash
curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh -o /tmp/i.sh && bash /tmp/i.sh
```

Se baja a un archivo en vez de `curl | bash` para que un fallo de la descarga no pase
desapercibido. Mientras el repositorio sea privado, `raw.githubusercontent.com` responde
404 sin credenciales: clona el repo y corre `bash scripts/instalar.sh` desde ahí. Revisa el
script antes si prefieres: [`scripts/instalar.sh`](../../scripts/instalar.sh).

## Windows: un solo comando en PowerShell

Forja no corre nativo en Windows todavía. Hay un segundo backend de aislamiento real con
Docker ([ADR-012](../decisiones/ADR-012-aislamiento-docker.md)), pero sólo sirve hoy en hosts
Linux: un contenedor Docker corre Linux por dentro incluso en Windows, así que no puede
ejecutar el `claude`/`node` de un Windows nativo. Falta una imagen que traiga esos CLI
instalados adentro (no probado, ver el ADR) — mientras tanto sigue el prototipo sin conectar
de [ADR-011](../decisiones/ADR-011-aislamiento-windows.md). Este comando, corrido en una
PowerShell normal, activa WSL2 e instala Ubuntu si hace falta, instala Forja adentro y deja
un `forja.cmd` en tu PATH de Windows que reenvía cada comando a esa Ubuntu — para que puedas
escribir `forja ...` directo en PowerShell aunque por debajo siga siendo Linux:

```powershell
irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.ps1 | iex
```

Si es la primera vez que activas WSL en esa máquina, Windows puede pedirte reiniciar; cuando
reinicies, abre la app **Ubuntu** una vez para crear tu usuario y contraseña de Linux, y
vuelve a correr el mismo comando — retoma solo desde ahí.

Revisa el script antes si prefieres: [`scripts/instalar.ps1`](../../scripts/instalar.ps1).

En Ubuntu 24.04 o posterior, AppArmor puede bloquear los *user namespaces* que usa
bubblewrap. Si `forja doctor` marca el sandbox con error, primero prueba instalando Docker
(`sudo apt install docker.io` o Docker Engine) y corre `forja doctor` de nuevo: si bwrap no
funciona, Docker es un segundo backend real (mismas garantías de aislamiento, probado en
[ADR-012](../decisiones/ADR-012-aislamiento-docker.md)) que `forja doctor` detecta y prepara
solo, sin que cambies nada más. No desactives la protección de AppArmor en una máquina
compartida.

## Primer uso

```bash
forja nuevo mi-proyecto && cd mi-proyecto      # o: forja importar ./repo-existente
forja conformidad                               # prueba los modelos de tus roles (consume poca cuota)
forja planear "lo que quieres construir"
```

Sigue con el flujo del [README](../../README.md#estado-del-código).

## Dónde guarda cosas

| Ruta | Contenido |
|---|---|
| `~/.forja/registro.db` | Proyectos y checkouts registrados en esta máquina |
| `~/.forja/checkouts/<id>/estado.db` | Eventos y estado del proyecto (SQLite, WAL) |
| `~/.forja/checkouts/<id>/lanzamientos/` | Orden, registro redactado y resultado de cada agente |
| `~/.forja/checkouts/<id>/worktrees/` | Copias de trabajo de las tareas (se borran al integrar) |
| `~/.forja/conformidad.json` | Modelos certificados por versión de CLI |
| `<repo>/forja.yaml` | Configuración del proyecto (una *solicitud*: nunca se concede a sí misma permisos) |
| `<repo>/.forja/` | Especificación, documentos, informes y piloto: versionables junto al código |

Cambia la carpeta de datos con `FORJA_HOME=/otra/ruta`.

## Desinstalar

```bash
npm uninstall -g @jhayro1/forja
rm -rf ~/.forja          # borra estado, copias y registros de TODOS los proyectos
```

Tus repositorios no se tocan: las ramas `forja/*` quedan y puedes borrarlas con `git branch -D`.
