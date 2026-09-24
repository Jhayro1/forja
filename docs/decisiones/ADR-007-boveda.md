# ADR-007 · Bóveda cifrada fuera del repo; secretos al proceso, nunca al prompt

**Estado:** aceptada · 2026-09-24

## Contexto

Algunas tareas necesitan credenciales externas (Cloudflare, SMTP, bases, SSH, MCP). Los
modelos no deben ver los valores, y los secretos no deben terminar en logs, commits ni
transcripciones.

## Decisión

- Bóveda cifrada (AES-256-GCM, clave derivada con scrypt) en `~/.forja`, con ámbito global o por proyecto.
- Clave maestra desde el llavero del sistema, desde `FORJA_CLAVE_MAESTRA` (servidores) o desbloqueo manual.
- Los secretos se inyectan como **entorno del proceso** o en una **config MCP temporal**
  (600), sólo para las tareas que los declaran y el plan aprobado incluye.
- Redactor obligatorio en toda salida. Permisos de escritura sólo mediante acciones externas aprobadas.

## Alternativas descartadas

- **`.env` en el repo**: se filtra con facilidad y lo leería el agente.
- **Gestores externos (Vault, 1Password)** como requisito: demasiada fricción para el MVP.
  Se pueden soportar después como **fuente** de secretos (adaptador).

## Consecuencias

- La bóveda es un componente de seguridad: tests de 0 fugas en CI y revisión cuidadosa.
- Con la bóveda cerrada, las tareas que la necesitan esperan en lugar de fallar.
