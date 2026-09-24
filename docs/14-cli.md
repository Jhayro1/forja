# 14 · CLI

Todos los comandos aceptan `--proyecto <nombre>` y `--json` (salida para scripts).

## Proyectos

| Comando | Qué hace |
|---------|---------|
| `forja nuevo <nombre> [--ruta]` | Crea el proyecto (carpeta, git, `forja.yaml`, registro) |
| `forja importar <ruta>` | Registra un repo existente y ofrece Analizar |
| `forja proyectos` | Lista los proyectos con fase, agentes activos y gasto |
| `forja usar <nombre>` | Fija el proyecto activo |
| `forja proyecto archivar\|vincular` | Archivar (no borra) / actualizar ruta |

## Flujo

| Comando | Qué hace |
|---------|---------|
| `forja analizar` | Fase 0 (incremental) |
| `forja planear` | Abre o retoma la conversación con el planeador (Descubrir → Especificar) en la terminal |
| `forja especificar` | Genera o regenera `spec.json` y los documentos |
| `forja dividir` | Genera las tareas y el plan con la estimación |
| `forja aprobar [spec\|plan\|accion <id>]` | Pasa una puerta o aprueba una acción externa |
| `forja run [--estimar] [--paralelo N] [--solo T-014]` | Ejecuta (o sólo estima) |
| `forja estado` | Resumen: fase, olas, agentes, pendientes de ti, gasto |
| `forja logs <tarea> [-f]` | Log de una tarea, en vivo con `-f` |
| `forja tarea <id> reintentar\|subir\|pausar\|reasignar <proveedor>` | Control fino |
| `forja preguntas` | Preguntas que llegaron hasta ti; responder |
| `forja unir` | Fuerza el procesamiento de la cola de merge |
| `forja informe` | Informe final (tareas, intentos, costo, tests) |

## Daemon

| Comando | Qué hace |
|---------|---------|
| `forja serve` | Levanta daemon y UI en primer plano |
| `forja ui` | Abre el navegador (levanta el daemon si hace falta) |
| `forja parar [--ya]` | Parada ordenada (o inmediata con checkpoint) |
| `forja servicio instalar\|quitar` | Unidad de systemd de usuario (servidores) |
| `forja doctor` | Revisa Node, git, CLIs, sesiones, permisos de la bóveda y espacio en disco |

## Bóveda

| Comando | Qué hace |
|---------|---------|
| `forja boveda abrir\|cerrar\|estado` | Desbloquear o bloquear |
| `forja conexion nueva <nombre> --tipo <t> [--global]` | Crear (pide los secretos ocultos) |
| `forja conexion probar\|editar\|permisos <nombre>` | Probar, editar, políticas |
| `forja conexiones` | Lista sin valores |
| `forja secreto poner\|quitar <NOMBRE>` | Secreto genérico (quitar pide confirmación escribiendo el nombre) |
| `forja secreto importar <archivo.env>` | Importa y clasifica |
| `forja var poner NOMBRE=valor` | Variable no sensible |
| `forja mcp nuevo\|probar\|lista` | Servidores MCP |
| `forja boveda exportar\|importar` | Respaldo **cifrado** |

## Memoria

| Comando | Qué hace |
|---------|---------|
| `forja memoria buscar <texto>` | Nodos relacionados |
| `forja memoria contexto <tarea>` | Muestra el paquete que recibiría la tarea |
| `forja memoria fijar\|soltar <nodo>` | Ajuste manual de relevancia |
| `forja memoria reconstruir` | Rehace el índice desde el repo y el código |
