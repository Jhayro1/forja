# UC-14 · Ver agentes, flujo y costos

**Actor:** Usuario · **Reglas:** R-04

**Precondiciones:** daemon corriendo.

## Flujo principal
1. El usuario abre `forja ui` (o `forja estado` en la terminal).
2. Ve el flujo del proyecto activo y «Pendiente de ti».
3. En Agentes ve las tarjetas actualizándose en vivo (SSE) y abre una para ver su log, paquete de contexto, diff y costo.
4. En Costos ve el gasto por fase, nivel, modelo y tarea, el uso de cada suscripción y la estimación restante.

## Flujos alternos
- **A1 · Varios proyectos:** el selector cambia de proyecto; la cabecera muestra los agentes globales.
- **A2 · Desde el móvil:** misma UI, diseño en una columna.
- **A3 · Desde la terminal:** `forja estado`, `forja logs T-014 -f`.

## Excepciones
- **E1 · Se corta la conexión SSE:** reconecta y pide los eventos desde el último id recibido (sin huecos).
- **E2 · Acceso sin token de sesión:** 401; la UI sólo escucha en 127.0.0.1.

## Criterios de aceptación
- **CA-1** Dado un trabajador que escribe en su salida, cuando miro su tarjeta, entonces la veo en menos de 1 s.
- **CA-2** Dado un log que contenía un secreto, cuando lo veo en la UI, entonces aparece `«secreto:…»` en su lugar.
- **CA-3** Dado un corte de red de 10 s, cuando vuelve, entonces el tablero no pierde eventos.
