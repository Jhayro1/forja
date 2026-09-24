# UC-01 · Crear o importar un proyecto

**Actor:** Usuario · **Reglas:** R-08

**Precondiciones:** Forja instalado; `forja doctor` sin errores bloqueantes.

## Flujo principal (crear)
1. El usuario ejecuta `forja nuevo mi-app`.
2. Forja crea la carpeta, `git init`, `forja.yaml` con un id nuevo, `.forja/` y `.gitignore`.
3. Forja registra el proyecto en `registro.db` y crea `~/.forja/proyectos/<id>/`.
4. Forja lo marca como proyecto activo y ofrece `forja planear`.

## Flujos alternos
- **A1 · Importar repo existente:** `forja importar /ruta` → si no hay `forja.yaml`, lo crea;
  si ya existe con un id conocido, vuelve a vincular el proyecto; ofrece la fase Analizar (UC-08).
- **A2 · Carpeta ya existe y no está vacía (con `nuevo`):** pregunta si importar en lugar de crear.
- **A3 · El repo tiene `forja.yaml` con un id desconocido (clonado de otra máquina):** lo registra con ese id y
  trae la especificación del repo; el historial de ejecución empieza vacío.

## Excepciones
- **E1 · Nombre duplicado en el registro:** error con sugerencia de otro nombre o `forja usar`.
- **E2 · Sin permisos de escritura en la ruta:** error con la ruta y el permiso que falta.
- **E3 · git no instalado:** error que indica ejecutar `forja doctor`.

## Postcondiciones
El proyecto figura en `forja proyectos`, tiene un id estable y un evento `proyecto.creado` o `proyecto.importado`.

## Criterios de aceptación
- **CA-1** Dado que no existe `mi-app`, cuando ejecuto `forja nuevo mi-app`, entonces existe `mi-app/forja.yaml` con un id y `forja proyectos` lo lista.
- **CA-2** Dado un repo con `forja.yaml` y el id `X`, cuando ejecuto `forja importar` en otra ruta, entonces el proyecto `X` se vincula a la nueva ruta y conserva su estado.
- **CA-3** Dado un proyecto archivado, cuando listo los proyectos, entonces no aparece, pero sus archivos en `~/.forja/proyectos/<id>/` siguen existiendo.
