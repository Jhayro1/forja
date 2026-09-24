# UC-11 · Gestionar conexiones, secretos y MCP

**Actor:** Usuario · **Reglas:** R-04, R-10

**Precondiciones:** la bóveda existe (se crea al primer uso, pidiendo o generando la clave maestra).

## Flujo principal (nueva conexión)
1. El usuario ejecuta `forja conexion nueva cloudflare-principal --tipo cloudflare [--global]` o usa el formulario de la UI.
2. Forja pide los campos del tipo; los secretos se escriben ocultos.
3. Forja ejecuta la prueba del tipo (p. ej. verificar el token) **sin efectos**.
4. El usuario elige permisos y política (qué niveles pueden recibirla y qué requiere aprobación).
5. Se guarda cifrada; evento `boveda.conexion_creada` (sin valores); entrada en la auditoría.

## Flujos alternos
- **A1 · Secreto genérico:** `forja secreto poner NOMBRE`.
- **A2 · Importar `.env`:** clasifica cada clave (secreto o variable) por patrón y nombre, y pide confirmación.
- **A3 · Servidor MCP:** `forja mcp nuevo` con comando o URL y entorno referenciando conexiones (`@conexion.campo`); se prueba el arranque y se listan sus herramientas.
- **A4 · Usar una conexión global en un proyecto:** añadirla a `forja.yaml › conexiones`.
- **A5 · Rotar un secreto:** `forja conexion editar` → se prueba antes de reemplazar el anterior.
- **A6 · Quitar un secreto:** exige escribir el nombre para confirmar; queda en la auditoría.

## Excepciones
- **E1 · La prueba falla:** se muestra el error tal cual (con los secretos redactados); se puede guardar igual marcando «sin probar».
- **E2 · Permisos del archivo de la bóveda demasiado abiertos:** el daemon se niega a abrirla e indica el `chmod` necesario.
- **E3 · Clave maestra incorrecta:** error; tras 5 intentos, espera progresiva.

## Criterios de aceptación
- **CA-1** Dada una conexión SMTP guardada, cuando ejecuto `forja conexiones`, entonces veo nombre, tipo, ámbito y última prueba, pero nunca la contraseña.
- **CA-2** Dada una conexión, cuando busco su valor secreto con `grep -r` en `~/.forja` (sin los `.enc`) y en el repo, entonces no hay coincidencias.
- **CA-3** Dado un MCP que usa `@cloudflare-principal.api_token`, cuando una tarea autorizada lo recibe, entonces el archivo de config temporal tiene permisos 600 y se borra al terminar la tarea.
