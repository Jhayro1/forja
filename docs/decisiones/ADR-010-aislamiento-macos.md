# ADR-010 · Aislamiento en macOS con Seatbelt (`sandbox-exec`)

**Estado:** propuesta · prototipo sin probar en macOS · 2026-09-24

## Contexto

El aislamiento de los agentes y del ejecutor de acciones usa bubblewrap, que sólo existe en
Linux. En macOS hoy Forja corre sin aislamiento (`sandbox.mode: ninguno`), y `forja doctor`
lo avisa. Las opciones evaluadas:

| Opción | A favor | En contra |
|---|---|---|
| `sandbox-exec` (Seatbelt) | Viene con macOS; controla lectura, escritura y red por ruta; lo usan otras CLIs de agentes | Marcado como obsoleto por Apple (sigue funcionando); sin espacios de nombres: no remapea rutas ni aísla procesos |
| Contenedor (Docker/Podman, Lima) | Mismo contrato que Linux (`bwrap` dentro de la VM) | Depende de instalar y levantar una VM; rutas del repo compartidas por red; lento para cada lanzamiento |
| Máquina virtual por lanzamiento | Aislamiento fuerte | Demasiado lento y pesado para decenas de agentes |

## Decisión (propuesta)

Usar Seatbelt con **el mismo contrato** que `bwrapArgs` y declarar por escrito lo que no
puede garantizar. El prototipo está en `src/runtime/seatbelt.ts` (`seatbeltProfile`), con
pruebas del perfil generado (`test/runtime/seatbelt.test.ts`). **No está conectado al
lanzador**: nadie lo ha corrido en un Mac.

El perfil:

- niega todo por defecto (`(deny default)`);
- deja leer el sistema, **oculta el HOME real** y vuelve a permitir sólo lo que el lanzamiento
  necesita (espacio de la tarea, HOME falso, binarios del proveedor, ayudas de Forja);
- deja escribir sólo el espacio de la tarea (salvo planeador y revisor), el HOME falso, el
  estado del proveedor y los temporales;
- sin red, salvo el socket unix del proxy fijado (`network-outbound` a esa ruta), igual que
  `--unshare-net` más el socket en Linux.

Lo que cambia respecto de Linux (lo devuelve `limitations`, para mostrarlo al usuario):

1. **Sin remapeo de rutas**: el socket del proxy, las ayudas y los archivos del proveedor
   quedan en su ruta real; el agente las recibe por variables de entorno.
2. **Sin espacio de nombres de procesos**: el runner debe matar el grupo de procesos, y un
   proceso que llame a `setsid` sobrevive. En Linux, `--unshare-pid` lo impide.
3. **Sin tmpfs**: el HOME falso tiene que ser una carpeta nueva y privada por lanzamiento.

## Para darla por aceptada

- Correr en un Mac `forja run --probar-conformidad` con el perfil activo. La sonda
  `aislamiento_sandbox` debe fallar al leer el HOME real, al escribir fuera del espacio y al
  abrir red.
- Resolver el punto 2: vigilar el grupo de procesos y matar a los que se escapen, o
  documentarlo como riesgo aceptado.
- Conectar `seatbeltArgs` en `launcher.ts` detrás de `sandbox.mode: seatbelt` y hacer que
  `forja doctor` lo detecte.
