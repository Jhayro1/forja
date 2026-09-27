# ADR-013 · Panel con React, Tailwind y shadcn/ui

**Estado:** aceptado · 2026-09-27

## Contexto

El panel era JavaScript sin dependencias ni compilación (`panel/panel.js` y
`panel/pantallas.js`, unas 1.500 líneas que armaban el DOM a mano). Cumplía la seguridad
(sólo `textContent`, CSP sin scripts inline), pero cada pantalla nueva costaba mucho, no
había componentes reutilizables y la interfaz se veía casera. Se pidió que el panel y la
app de escritorio se vieran como shadcn/ui.

## Decisión

- `panel/` pasa a ser un proyecto **Vite + React 19 + TypeScript + Tailwind v4** con los
  componentes originales de **shadcn/ui** (estilo new-york, tema neutral, fuente Geist),
  generados con su CLI y guardados en el repo como código propio.
- Es un **workspace de npm**: `npm run build` compila la CLI y el panel. El paquete publicado
  lleva sólo `panel/dist` (probado en `probar:paquete`); quien lo instala no necesita React
  ni Vite.
- Datos con **TanStack Query** sobre un cliente tipado (`panel/src/lib/api.ts`) que conserva
  las reglas de la API: ETag/304, token CSRF e `Idempotency-Key` en cada mutación. El SSE de
  eventos invalida las consultas; mientras algo está en curso se sondea más rápido.
- Cada pantalla es un chunk aparte (`React.lazy`): la primera carga sólo trae lo que muestra.
- La app de escritorio reutiliza los mismos componentes con una segunda entrada
  (`escritorio.html`, [ADR-014](ADR-014-app-escritorio.md)).

## Seguridad (lo que no cambió y lo que sí)

- React escapa todo el texto: sigue sin haber `innerHTML` ni `dangerouslySetInnerHTML`
  (lo comprueba `test/api/server.test.ts` sobre todas las fuentes del panel).
- La CSP sigue sin scripts inline (`script-src 'self'`). Radix inserta un `<style>` para
  bloquear el scroll detrás de los diálogos y en los `Select`: el servidor pone un **nonce
  nuevo en cada carga** en `<meta name="forja-nonce">` y en `style-src`, y el panel se lo
  pasa a Radix (`get-nonce`). Cualquier otro estilo inline sigue bloqueado.
- No se usa `sonner` para los avisos porque inserta estilos sin nonce: `Toaster` propio sobre
  Radix Toast.
- `font-src 'self'` para las fuentes Geist empaquetadas. Los assets con hash se sirven con
  `Cache-Control: immutable`; el servidor sólo sirve nombres planos de `panel/dist` y
  `panel/dist/assets` (nada de `..`, ni ocultos, ni fuentes).

## Alternativas descartadas

- **Seguir sin compilación**: no se puede tener shadcn/ui (son componentes React).
- **Otra librería de componentes (MUI, Mantine…)**: traen su propio sistema de estilos en
  tiempo de ejecución (CSS-in-JS con `<style>` dinámicos) que choca con la CSP; shadcn/ui es
  Tailwind compilado a un archivo CSS.
- **Svelte/Vue**: shadcn/ui es de React; los ports existen pero van por detrás.

## Consecuencias

- Construir el repo necesita las dependencias de desarrollo del panel (se instalan con el
  mismo `npm install`/`npm ci` del workspace).
- `panel/dist` no se versiona; `forja ui` responde 503 con un mensaje claro si falta compilar.
