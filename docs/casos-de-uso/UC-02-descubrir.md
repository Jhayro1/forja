# UC-02 · Descubrir con el planeador

**Actores:** Usuario, Planeador · **Reglas:** R-04, R-06

**Precondiciones:** proyecto activo; al menos un proveedor con modelo de nivel `planeador` y sesión activa.

## Flujo principal
1. El usuario ejecuta `forja planear` (o abre la vista Planear) y describe su idea.
2. El planeador responde con una tanda corta de preguntas (≤ 5) según la checklist: actores,
   objetivos, alcance, fuera de alcance, reglas, datos, integraciones, requisitos no funcionales y éxito.
3. Cada pregunta trae opciones y una recomendación.
4. Tras cada turno, Forja guarda el evento, actualiza la lista de **preguntas abiertas** y el borrador de decisiones.
5. Se repiten 2–4 hasta que no quedan preguntas abiertas (o las que quedan están marcadas «decidir después»).
6. El planeador presenta el resumen del descubrimiento.
7. El usuario lo aprueba → se guarda `.forja/descubrimiento.md` y pasa a UC-03.

## Flujos alternos
- **A1 · El usuario responde «decide tú»:** el planeador aplica su recomendación y la registra como decisión.
- **A2 · Proyecto importado:** el planeador parte de la arquitectura actual (UC-08) y pregunta por la mejora, no por el sistema entero.
- **A3 · El usuario cierra la terminal a mitad:** al volver con `forja planear`, se reanuda la sesión con las mismas preguntas abiertas (UC-10).
- **A4 · El usuario pega un secreto en el chat:** Forja detecta el patrón, **no lo envía**, y ofrece guardarlo en la bóveda (UC-11).

## Excepciones
- **E1 · Proveedor con límite alcanzado:** se ofrece continuar con otro proveedor del nivel `planeador` (pasándole el resumen acumulado) o esperar hasta la hora de reinicio.
- **E2 · Ningún proveedor del nivel `planeador` disponible:** error con lo que dice `forja doctor`.
- **E3 · La respuesta del modelo no respeta el formato de preguntas:** se reintenta una vez con el esquema; si vuelve a fallar, se muestra como texto libre.

## Postcondiciones
`descubrimiento.md` aprobado; evento `fase.terminada(descubrir)`.

## Criterios de aceptación
- **CA-1** Dado un descubrimiento en curso con 3 preguntas abiertas, cuando mato el daemon y ejecuto `forja planear`, entonces veo las mismas 3 preguntas abiertas.
- **CA-2** Dado que escribo un texto con un token con formato `sk-…` o de Cloudflare, cuando lo envío, entonces no llega al proveedor y se me ofrece guardarlo en la bóveda.
- **CA-3** Dado que no quedan preguntas abiertas, cuando apruebo, entonces existe `.forja/descubrimiento.md` y el flujo muestra Descubrir ✔.
