# Distro de WSL «Forja»: lo que la app de escritorio importa con `wsl --import`.
# Trae todo lo que Forja necesita (Node 22, git, bubblewrap, Forja, Claude Code y Codex),
# así el usuario no instala Ubuntu, no crea usuario ni escribe contraseñas.
#
#   docker build -f desktop/distro/Dockerfile --build-context paquete=<carpeta con forja.tgz> -t forja-wsl .
#   (o desktop/distro/construir.sh, que además la exporta a forja-wsl-x64.tar.gz)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap ca-certificates curl procps less openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Forja (el tarball de `npm pack`) y los CLI oficiales de los proveedores.
COPY --from=paquete forja.tgz /tmp/forja.tgz
RUN npm install -g --no-audit --no-fund /tmp/forja.tgz @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force \
 && rm -f /tmp/forja.tgz \
 && forja --version

# El usuario de siempre (uid 1000), sin contraseña: lo que necesita root se hace con
# `wsl -u root` desde Windows. La imagen de Node ya trae el uid 1000 como «node».
RUN usermod -l forja -d /home/forja -m -c Forja node \
 && groupmod -n forja node \
 && mkdir -p /home/forja/.local/bin \
 && chown -R forja:forja /home/forja

COPY wsl.conf /etc/wsl.conf
COPY wsl-distribution.conf /etc/wsl-distribution.conf
RUN echo 'Distro de Forja. Abre la app «Forja» en Windows; aquí no hace falta tocar nada.' > /etc/motd
