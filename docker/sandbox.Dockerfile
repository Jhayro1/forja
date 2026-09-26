# Imagen del sandbox Docker (ADR-012-aislamiento-docker.md). A propósito no trae Node ni
# los CLI de los proveedores: el runner bind-montea los del host tal cual (mismo binario
# certificado con el que iniciaste sesión), y una libc moderna alcanza para correrlos.
FROM debian:bookworm-slim
