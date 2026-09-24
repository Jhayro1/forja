# Progreso de Forja

Bitácora de implementación. Se actualiza al terminar cada punto del [roadmap v2](v2/11-roadmap-y-backlog.md).
Formato: fecha · punto · qué quedó · cómo se verificó · qué sigue.

## Dónde estoy

**Último punto terminado:** V2-018 · M1 completo · **Siguiente:** M2 · V2-020/025 (planeador conversacional con estado persistente)

## Bitácora

| Fecha | Punto | Resultado | Verificación |
|---|---|---|---|
| 2026-09-24 | Plan v1 + v2 | Documentación y decisiones D2-01 a D2-21 | Revisión con el usuario |
| 2026-09-24 | M0 · V2-001/002/003/004/006/007 | Pruebas reales de Claude y Codex: modelos, esquema, reanudar, kill -9, aislamiento. [Resultados](m0/RESULTADOS.md) | 11 fixtures redactadas |
| 2026-09-24 | V2-010 | Paquete TS, licencia Apache-2.0, CI | CI verde en GitHub |
| 2026-09-24 | V2-011 | Dominio: ids, hash canónico, transiciones, aprobaciones, errores | 15 tests |
| 2026-09-24 | V2-012 | Almacén de eventos SQLite, comandos idempotentes, outbox, proyección de tareas | 11 tests |
| 2026-09-24 | V2-013 | Parsers de Claude/Codex con fixtures reales, proveedor simulado, `forja doctor` | 21 tests |
| 2026-09-24 | V2-014 | Redactor (valores conocidos + variantes base64/url + formas típicas; streaming por líneas que no parte secretos ni llaves privadas), entorno por lista positiva, política efectiva = intersección de lo pedido con lo aprobado | 10 tests; un test encontró y corrigió una fuga en el redactor de streaming |
| 2026-09-24 | V2-015 | Registro global (checkouts separados por clon), forja.yaml validado (claves desconocidas = error), importación estática (commits, sucio, submódulos, LFS, symlinks, lenguajes), bloqueo por proyecto con identidad pid+inicio, comandos nuevo/importar/proyectos/usar/proyecto archivar/desarchivar/vincular. La API local autenticada se hace junto con el tablero (V2-039) | 8 tests + prueba manual del CLI (clon, nombre duplicado, carpeta movida) |
| 2026-09-24 | V2-016 | Runner separado por lanzamiento: orden durable antes del proceso, candado por lanzamiento (orden duplicada no lanza otro escritor), spool redactado con seq, latido, tiempo máximo, cancelación, resultado atómico. Sandbox bwrap: HOME real oculto, sólo el workspace escribible, --unshare-pid + --die-with-parent. Filtro de red D2-20: sin red + proxy CONNECT con lista de hosts. Probado con los CLI reales: Claude y Codex funcionan montando sólo su archivo de credenciales y saliendo sólo a su API (api.anthropic.com / chatgpt.com); telemetría y red de herramientas bloqueadas | 9 tests (incluye kill -9 que no deja huérfanos con setsid, aislamiento de disco y red, proxy 403/502) + pruebas manuales con claude y codex reales |
| 2026-09-24 | V2-017 | Copias: instantánea consistente de la base (VACUUM INTO), lanzamientos, bundle de las ramas forja/*, manifiesto con tamaño y sha256; verificación (archivos, hashes, integrity_check); restauración que exige copia verificada, aparta el estado actual (no borra) y sólo toca ramas de Forja; comandos forja backup crear/listar/verificar/restaurar --confirmar | 4 tests + prueba manual del CLI |
| 2026-09-24 | V2-018 · M1 completo | Adaptadores Claude y Codex con el perfil seguro de M0 (MCP vacío, sin settings del usuario, sin segundo plano, prompt por stdin, sólo su archivo de credenciales, estado de sesión por proyecto, red sólo a su API), agente simulado que edita archivos de verdad dentro del sandbox, servicio de lanzamiento que resume desde el spool (incluye hosts bloqueados). Arreglado: socket del proxy en ruta corta (límite de 107 bytes) | Suite de conformidad: 10/10 con simulado, Claude (haiku) y Codex (gpt-6-luna) reales editando archivos y devolviendo salida con esquema |
