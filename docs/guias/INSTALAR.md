# Instalar Forja

## Requisitos

| Qué | Por qué |
|---|---|
| Linux (x86_64 o arm64) | El aislamiento de los agentes usa bubblewrap, que sólo existe en Linux. En Windows, usa WSL2 |
| Node.js ≥ 24.11 | Forja usa `node:sqlite` y APIs recientes de Node |
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

En Ubuntu 24.04 o posterior, AppArmor puede bloquear los *user namespaces* que usa
bubblewrap. Si `forja doctor` marca el sandbox con error, sigue la indicación que muestra
(no desactives la protección en una máquina compartida).

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
