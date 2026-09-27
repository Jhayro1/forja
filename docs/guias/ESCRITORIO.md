# App de escritorio (Windows)

La forma más fácil de usar Forja en Windows: se instala como cualquier programa y se abre
desde el menú Inicio. Por dentro usa WSL (Linux de Windows) para aislar a los agentes, pero
no tienes que instalar Ubuntu, crear usuarios ni escribir contraseñas.

## Instalar

1. Descarga `Forja_x.y.z_x64-setup.exe` (o el `.msi`) del
   [último release](https://github.com/Jhayro1/forja/releases/latest) y ábrelo.
   Se instala sólo para tu usuario. Como todavía no está firmado, Windows puede mostrar
   «Windows protegió tu PC»: *Más información → Ejecutar de todas formas*.
2. Abre **Forja**. El asistente revisa tu PC:
   - Si WSL no está activado, pulsa **Activar WSL** y acepta el permiso de administrador.
     Si Windows pide reiniciar, reinicia y vuelve a abrir Forja.
   - Pulsa **Instalar**: descarga la distro de Forja (~350 MB, con Forja, Claude Code y
     Codex), comprueba que llegó completa y la instala.
3. Se abre el panel dentro de la app. En **Configuración** inicia sesión en Claude (y
   opcionalmente en Codex) y elige los modelos de cada rol; en **Proyectos** elige tu carpeta.

Si ya habías instalado Forja con `instalar.ps1` (en tu Ubuntu), la app lo detecta y lo usa.

## Uso diario

- Abrir Forja abre el panel directamente.
- Menú **Forja → Estado de la instalación**: versiones, **Actualizar Forja** (sin perder tus
  proyectos ni sesiones) y **Copiar diagnóstico** para pedir ayuda.
- Menú **Forja → Abrir en el navegador**: el mismo panel en tu navegador.
- Al cerrar la app se cierra el panel; si había una ejecución en curso, sigue en segundo plano.

Los enlaces externos (por ejemplo la página para iniciar sesión en Claude) se abren en tu
navegador, nunca dentro de la app.

## Desinstalar

Desinstala **Forja** desde *Configuración de Windows → Aplicaciones*. La distro con tus
sesiones y datos de Forja queda; para borrarla también: `wsl --unregister Forja`
(tus proyectos en `C:\` no se tocan).

## Para desarrollar la app

Detalles de diseño en [ADR-014](../decisiones/ADR-014-app-escritorio.md).

| Qué | Cómo |
|---|---|
| Asistente en el navegador (sin Tauri) | `npm run dev:escritorio -w panel` y abre `http://localhost:5174/escritorio.html?simular=sin-wsl` (`sin-forja`, `listo`) |
| App completa | `npm run dev -w desktop` (Windows; en Linux necesita WebKitGTK) |
| Instalador | `npm run build -w desktop` en Windows → `desktop/src-tauri/target/release/bundle/` |
| Pruebas de Rust | `cd desktop/src-tauri && cargo test` |
| Distro | `desktop/distro/construir.sh salida` (Docker) → `forja-wsl-x64.tar.gz`, `.sha256` y `forja.tgz` |

**Probar en Linux sin Windows.** Con la imagen `forja-wsl` construida, un `wsl.exe` falso que
la ejecute con Docker permite probar la app de verdad:

```sh
#!/bin/sh
# wsl.exe (en un directorio al principio del PATH)
E=/tmp/wsl-falso; mkdir -p $E
case "$1" in
  --status) exit 0 ;;
  --list) [ -f $E/importada ] && printf 'Forja\r\n'; exit 0 ;;
  --import) echo "$@" > $E/importada; exit 0 ;;
esac
user=forja
while [ $# -gt 0 ]; do case $1 in --distribution) shift 2;; --user) user=$2; shift 2;; --exec) shift; break;; *) shift;; esac; done
exec docker run --rm -i --network host -u "$user" forja-wsl "$@"
```

- `cargo test -- --ignored` prueba el arranque del panel y (con `FORJA_DESCARGAS` apuntando
  a un servidor que sirva la salida de `construir.sh`) la instalación completa.
- `FORJA_PROBAR_EN_LINUX=1 desktop/src-tauri/target/release/forja-escritorio` abre la app
  en Linux usando ese `wsl.exe`.

Publicar: una etiqueta `vX.Y.Z` corre `.github/workflows/escritorio.yml` y sube el
instalador, la distro y `forja.tgz` al release.
