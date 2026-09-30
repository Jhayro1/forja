# Manual de inicio de Forja

Forja es un orquestador de agentes de programación. Conversas con él lo que quieres construir,
lo especifica y lo divide en tareas. Varios agentes de Claude y Codex programan esas tareas en
paralelo, cada uno aislado en su sandbox. Todo termina verificado en una rama aparte y, si
quieres, en un PR en GitHub.

**Reglas que Forja cumple siempre:** trabaja en sus propias ramas (`forja/…`), nunca toca la
rama principal, nunca une un PR y nunca usa `--force`. Tus claves se guardan cifradas y nunca
llegan a los agentes.

Hay **dos versiones**, del mismo código:

| | **Forja Ligera** (nueva) | **Forja Completa** |
|---|---|---|
| Instalación | Un comando, un par de minutos. Sin WSL ni Ubuntu | App `.exe` con WSL, un comando en Linux o un VPS |
| Agentes | **Uno**, que hace la tarea o el bloque que elijas en la misma sesión | Varios en paralelo, coordinados |
| Claude y Codex | Los que ya tienes en tu PC, con tu sesión | Instalados dentro de Forja |
| Aislamiento | Rama y carpeta propias, sin sandbox (el agente tiene tus permisos) | Sandbox propio por agente |
| Dónde | Windows, macOS, Linux | Windows (WSL), Linux, VPS |

**Forja Ligera** tiene su propia guía: [LIGERA.md](LIGERA.md). En Windows se instala así:

```powershell
irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/ligera.ps1 | iex
```

El resto de este manual es para **Forja Completa**. Elige cómo instalarla:

| Dónde | Cómo | Para qué |
|---|---|---|
| **Windows** | App de escritorio (`.exe`) | Usarlo en tu PC con una ventana propia |
| **Linux o WSL** | Un comando en la terminal | Usarlo en tu PC con Linux |
| **VPS** | Un comando como root | Usarlo desde el navegador en cualquier lugar, con login |

Las tres formas tienen **el mismo panel y las mismas funciones**. La única diferencia es que
en un VPS hay que iniciar sesión (sólo el dueño puede entrar), y en tu PC no, porque sólo
escucha en tu propia máquina.

---

## 1. Instalar en Windows

### Con la app (recomendado)

1. Descarga `Forja_x.y.z_x64-setup.exe` del
   [último release](https://github.com/Jhayro1/forja/releases/latest) y ábrelo.
   - Todavía no está firmado. Si Windows muestra «Windows protegió tu PC», pulsa *Más
     información* y luego *Ejecutar de todas formas*.
2. Abre **Forja** desde el menú Inicio. El asistente revisa tu PC:
   - Si falta WSL, pulsa **Activar WSL** y acepta el permiso de administrador. Si pide
     reiniciar, reinicia y vuelve a abrir Forja.
   - Pulsa **Instalar**. Descarga la distro de Forja (~350 MB, con Forja, Claude Code y Codex)
     y la instala. No te pide usuarios ni contraseñas.
3. Se abre el panel dentro de la app. Sigue en la [sección 4](#4-configuración-inicial-igual-en-todas).

Para actualizar: menú **Forja → Estado de la instalación → Actualizar Forja**. No pierdes
proyectos ni sesiones.

### Con PowerShell (alternativa)

```powershell
irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.ps1 | iex
```

Instala todo en tu Ubuntu de WSL y abre el panel en el navegador. Más detalle en
[INSTALAR.md](INSTALAR.md).

**Tus carpetas de Windows:** en **Proyectos → Agregar un proyecto existente** puedes pegar la
ruta de Windows tal cual (por ejemplo, `C:\Users\tú\proyectos\mi-app`). También puedes pulsar
«Buscar la carpeta…» y elegirla.

---

## 2. Instalar en Linux o WSL (tu PC)

```bash
curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh -o /tmp/i.sh && bash /tmp/i.sh
forja          # abre el panel en el navegador
```

Instala lo que falte (git, bubblewrap y Node) y deja el comando `forja`.

---

## 3. Instalar en un VPS

### Requisitos

- Ubuntu 22.04 o 24.04, o Debian 12, con acceso root.
- Un dominio o subdominio con un registro **A** que apunte a la IP del VPS, por ejemplo
  `forja.tudominio.com`.
- Mínimo 4 GB de RAM; mejor 8 GB, porque los agentes compilan y prueban código.

### Instalar (un comando)

```bash
curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar-servidor.sh -o /tmp/fs.sh
sudo bash /tmp/fs.sh --dominio forja.tudominio.com --dueno tu@correo.com
```

El comando hace todo esto:
- Instala git, bubblewrap y Node 24.
- Crea el usuario de sistema `forja` y sus carpetas (`/var/lib/forja`).
- Prepara el sandbox de los agentes.
- Instala Forja en `/opt/forja`, junto con Claude Code y Codex.
- Crea el servicio `forja` (systemd), con límites de memoria y CPU.
- Instala **Caddy** para servir `https://forja.tudominio.com` con certificado automático.

Forja nunca queda expuesto en la IP pública: escucha sólo dentro del servidor.

**Si tu VPS usa Doko** (u otro panel con su propio proxy), usa `--modo doko`. Forja escucha
en la red interna de Docker y Doko publica el dominio con una «puerta». Al terminar, el
instalador te dice qué servicio crear en Doko (Dockerfile `deploy/doko-puerta/Dockerfile`,
puerto 8080, health check `/salud`). Con `--modo ninguno`, lo publicas tú con tu propio proxy.

> Forja no funciona dentro de un contenedor Docker: el sandbox de los agentes lo impide. Por
> eso se instala en el servidor con systemd y no como una app de Doko. Ver
> [SERVIDOR.md](SERVIDOR.md).

### Primer acceso en el VPS

1. Entra a `https://forja.tudominio.com/login` y pulsa **Crea la cuenta del dueño**, con el
   correo que pusiste en `--dueno` y una contraseña de al menos 10 caracteres. Cualquier otro
   correo recibe «registro cerrado».
2. **Código de verificación:** todavía no hay correo configurado, así que el código aparece en
   el registro del servidor:
   ```bash
   journalctl -u forja | grep codigo | tail -1
   ```
3. Entra y sigue con la [sección 4](#4-configuración-inicial-igual-en-todas). Después de
   configurar el correo, los códigos (por ejemplo, para recuperar la contraseña) te llegan por
   correo.

Protecciones del login:
- 5 contraseñas incorrectas bloquean la cuenta 15 minutos.
- Las sesiones duran 7 días.
- «¿La olvidaste?» envía un código para cambiar la contraseña.

### Actualizar el VPS

```bash
sudo bash /tmp/fs.sh --actualizar
```

Descarga `main`, compila en una carpeta nueva, cambia la versión y reinicia. La versión
anterior queda en `/opt/forja/<commit>` por si hay que volver.

---

## 4. Configuración inicial (igual en todas)

Todo se hace en el panel: **Ajustes** en la barra lateral, abajo.

### 4.1 Cuentas de IA (obligatorio)

**Ajustes → Cuentas de IA**:

1. En **Claude Code**, cuenta `@principal`: pulsa **Iniciar sesión**. Abre la página, entra
   con tu cuenta de Claude, copia el código que te muestra y pégalo en Forja.
2. En **Codex** (opcional): **Iniciar sesión**. En tu PC se completa solo. En un VPS aparece
   un código: escríbelo en la página de OpenAI que se abre.
3. **Más cuentas:** escribe un alias (por ejemplo, `trabajo`), pulsa **Agregar cuenta** y
   luego **Iniciar sesión** con esa otra cuenta.
   - Forja reparte los agentes entre todas las cuentas activas.
   - Si una se queda sin cuota, sigue con las demás.
   - «Límite» fija cuántos agentes a la vez usa cada cuenta.

### 4.2 Modelos por rol

**Ajustes → Modelos por rol**: elige el modelo, un respaldo y el esfuerzo de razonamiento de
cada uno de los siete roles:

| Rol | Qué hace |
|---|---|
| Orquestador | Planea, especifica y divide |
| Implementador (simple y complejo) | Programa las tareas |
| Integrador | APIs, bases de datos y webhooks |
| Revisor | Revisa cada cambio contra sus criterios |
| Auditor | Revisa seguridad y arquitectura del sprint |
| QA | Prueba la entrega completa |

Para empezar sirven los valores por defecto. Sube **«Agentes trabajando a la vez»** si tienes
varias cuentas. El botón **Probar estos modelos** confirma que tu cuenta los acepta.

### 4.3 Correo (opcional, recomendado en un VPS)

**Ajustes → Correo**. Sirve para que Forja te avise cuando:
- termina un trabajo o un run;
- algo espera tu respuesta;
- el planeador respondió;
- hay observaciones de calidad nuevas.

1. En **Auralis Mail** (o tu proveedor): en la cuenta que va a enviar, por ejemplo
   `noreply@tudominio.com`, crea una **clave de aplicación**. En Gmail se llama «contraseña
   de aplicación».
2. En Forja rellena:
   - servidor, por ejemplo `mail.tudominio.com`;
   - puerto 587 con STARTTLS (o 465 con TLS);
   - usuario: la cuenta completa;
   - la clave de aplicación;
   - remitente y destinatario.
3. Pulsa **Guardar** y **Enviar correo de prueba**. Marca qué avisos quieres.

La clave se guarda cifrada y nunca vuelve al navegador.

### 4.4 GitHub (opcional)

**Ajustes → GitHub**. Con un token, Forja **sube la rama de cada sprint entregado y abre el PR**
contra tu rama principal. **Nunca lo une**: eso lo decides tú en GitHub.

1. En GitHub ve a **Settings → Developer settings → Personal access tokens → Fine-grained
   tokens → Generate new token**:
   - *Repository access*: sólo los repos donde trabajará Forja.
   - *Permissions*: **Contents** y **Pull requests** en «Read and write».
2. Pega el token en Forja y pulsa **Guardar y probar**. Forja comprueba con GitHub que funciona
   y lo guarda cifrado.
3. Elige qué hace al entregar. Por defecto, al terminar un sprint:
   - sube la rama;
   - abre el PR.

Sin token, la entrega queda en la rama `forja/entrega/<sprint>` de tu repo y tú la subes cuando
quieras.

### 4.5 Proyectos

**Proyectos** (barra lateral, abajo) tiene tres maneras de agregar uno:
- **Clonar desde GitHub:** pega `usuario/repo` o la dirección `https`. Si es privado, añade un
  token de sólo lectura; se usa una vez y no se guarda.
- **Agregar un proyecto existente:** una carpeta que ya sea un repositorio git.
- **Crear un proyecto nuevo:** Forja crea la carpeta y el repositorio.

Después, el selector de arriba a la izquierda cambia entre proyectos. Al agregar un proyecto,
Forja crea un `forja.yaml` en él: es su configuración (roles, paralelismo y perfil).

---

## 5. Tu primer sprint

1. **Sprint actual:** cuenta lo que quieres, por ejemplo «Quiero registrar pagos parciales de
   facturas y ver el saldo de cada cliente». El orquestador te hace preguntas. Cuando no quede
   nada pendiente, pulsa **Aprobar y seguir**.
2. **Escribir la especificación:** casos de uso y criterios de aceptación. Responde sus
   preguntas si las hay.
3. **Dividir en tareas:** tareas en olas, con la estimación de tiempo y consumo. Revísalo y
   pulsa **Aprobar el plan**.
4. **Ejecutar:** los agentes trabajan en paralelo.
   - Míralo en **Tablero**, por columnas, y en **Agentes**, que muestra quién trabaja en qué y
     con qué cuenta.
   - Si un agente pregunta algo, aparece en la campana y en el tablero.
5. **Entregado:** todo queda en `forja/entrega/<sprint>`, verificado. Con token de GitHub, se
   sube y se abre el PR.
6. **Calidad → Validar el sprint:** QA prueba la entrega completa y el auditor revisa la
   seguridad.
   - Lo que encuentren queda como **observaciones**.
   - Eliges cuáles corregir y pulsas **Crear plan de acción**. Eso crea un sprint de
     correcciones que tú apruebas antes de que se ejecute nada.
7. **Historial:** lista de control por épica, sprint, historia y tarea, y calendario de lo que
   pasó.

**Atajos:**
- **Ctrl+K** busca pantallas, tareas y acciones.
- La **campana** muestra lo que espera tu respuesta.
- **Resumen** siempre dice cuál es el siguiente paso.

---

## 6. Si algo no funciona

| Problema | Qué hacer |
|---|---|
| «Falta algo para poder trabajar» | **Ajustes → Tu máquina** dice qué falta y cómo resolverlo. En la terminal: `forja doctor` |
| No llega el código de verificación (VPS) | `journalctl -u forja \| grep codigo \| tail -1` |
| «Demasiados intentos fallidos» | Espera 15 minutos, o usa «¿La olvidaste?» |
| Una cuenta de IA «sin cuota» | Forja sigue con otra cuenta o modelo. Cuando renueves la cuota, pulsa **Reanudar** en el tablero |
| «bubblewrap no puede aislar» | En Ubuntu 24.04, el instalador del VPS lo resuelve. Dentro de un contenedor Docker no hay solución: instala en el servidor ([SERVIDOR.md](SERVIDOR.md)) |
| El PR no se abrió | Revisa que el token tenga **Contents** y **Pull requests** en «Read and write». En la entrega del sprint pulsa **Subir de nuevo**, o en la terminal: `forja publicar` |
| GitHub «ya tiene la rama con otros cambios» | Alguien subió commits a la rama de Forja. Forja no la sobrescribe nunca: une o descarta esos cambios en GitHub y vuelve a publicar |

Más guías: [seguridad](SEGURIDAD.md) · [recuperación](RECUPERACION.md) · [limitaciones](LIMITACIONES.md) · [servidor](SERVIDOR.md) · [app de escritorio](ESCRITORIO.md).
