# ADR-014 · App de escritorio para Windows (Tauri 2 + distro de WSL propia)

**Estado:** aceptado · la app y la distro se probaron en Linux con un `wsl.exe` simulado;
falta la primera prueba en un Windows real · 2026-09-27

## Contexto

Forja corre en Linux (bubblewrap). En Windows se usaba con `scripts/instalar.ps1`: instalaba
Ubuntu, pedía crear usuario y contraseña de Linux, instalaba Node con nvm, Forja y Claude
Code, y abría el panel en el navegador. Funcionaba, pero con muchos pasos y fallos por
detalles de Windows (codificaciones, CRLF, PATH, `sudo`). Se pidió una app instalable como
cualquier otra, con el mismo estilo que el panel.

## Decisión

1. **Tauri 2** (`desktop/src-tauri`), no Electron: usa el WebView2 que ya trae Windows
   (binario de ~5 MB frente a más de 100 MB) y la lógica nativa es Rust, sin un segundo Node.
2. **Una distro de WSL propia, «Forja»** (`desktop/distro`), en vez de Ubuntu: un rootfs
   basado en `node:22-bookworm-slim` con git, bubblewrap, Forja, Claude Code y Codex ya
   instalados, usuario `forja` (uid 1000) **sin contraseña** por defecto,
   `appendWindowsPath=false` (un `node`/`claude` de Windows no tapa a los de Linux) y C:\
   montado como uid 1000 (git no marca las carpetas de Windows como *dubious ownership*).
   Se importa con `wsl --import`: no toca la Ubuntu del usuario ni pasa por la tienda.
   Lo que necesita root se hace con `wsl -u root`, que Windows permite sin contraseña.
3. **La app no reimplementa el panel**: arranca `forja ui --sin-navegador --salir-sin-entrada`
   dentro de la distro, lee el enlace de un solo uso de su salida y navega a él. Pide
   enlaces nuevos escribiendo una línea en su entrada; al cerrar la app, la entrada se
   cierra y el panel termina (los trabajos en curso siguen, como con Ctrl-C).
4. **Asistente de primer uso** (`panel/src/escritorio`, mismos componentes shadcn):
   activar WSL (un permiso de administrador; puede pedir reiniciar) → descargar la distro
   con progreso → verificar su SHA-256 → importar → abrir el panel. Si ya existe la Ubuntu
   de `instalar.ps1` con Forja, la reutiliza.
5. **Publicación en CI** (`.github/workflows/escritorio.yml`): la distro se construye y se
   prueba en Linux; la app se prueba y empaqueta (NSIS y MSI) en `windows-latest`; en una
   etiqueta `vX.Y.Z` todo va al release junto con `forja.tgz`, que el botón «Actualizar
   Forja» instala dentro de la distro sin reinstalarla (se conservan proyectos y sesiones).

## Seguridad

- La ventana sólo navega a la propia app y a `127.0.0.1`/`localhost`; cualquier otra URL
  (p. ej. la página de inicio de sesión de Claude, que el panel abre con `target=_blank`)
  va al navegador del sistema. Probado en `lib.rs` (`solo_navega_a_la_app_y_al_panel_local`).
- El panel es una página remota para Tauri: la capacidad `default` sólo cubre la página
  local del asistente, así que el panel no puede invocar los comandos de la app.
- El enlace del panel se valida antes de usarlo (`http://127.0.0.1:<puerto>/#codigo=<[A-Za-z0-9_-]+>`).
- La descarga se verifica con SHA-256 publicado junto al archivo y se hace con el TLS del
  sistema (schannel): respeta los certificados de Windows.
- `wsl.exe` se llama siempre con argumentos sueltos, nunca con una línea de comandos armada
  como texto.

## Lo que se probó

- Distro: construida con Docker; como usuario `forja`: `forja`, `claude`, `codex`, `bwrap`
  y `forja doctor` funcionan; el panel responde y se cierra al cerrar la entrada.
- App: compila y pasa `clippy -D warnings` para Linux y para `x86_64-pc-windows-msvc`; sus
  pruebas unitarias pasan. Con un `wsl.exe` simulado que ejecuta la imagen Docker:
  instalación completa (descarga, SHA-256, importar, comprobar) y arranque del panel con
  enlaces nuevos (`cargo test -- --ignored`). La ventana real (WebKitGTK en Xvfb) cargó el
  asistente, arrancó `forja ui` en la «distro» y mostró el panel; al cerrarla, el panel terminó.

## Pendiente

- Primera ejecución en un Windows real (activar WSL, `wsl --import` real, WebView2).
- Firmar el instalador (sin firma, SmartScreen avisa la primera vez).
- Actualización automática de la propia app (Tauri updater necesita claves de firma).
- La distro pesa ~355 MB comprimida: casi todo son los binarios nativos de Claude Code y Codex.
