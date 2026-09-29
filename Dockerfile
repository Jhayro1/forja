# Forja en modo servidor (v3/PLAN.md §6.9): pensado para Doko o cualquier plataforma con
# proxy TLS delante. Sin sesión del dueño no responde ninguna ruta salvo /login y /salud.
#
# Variables obligatorias:  FORJA_URL_PUBLICA (https://forja.tudominio.com)
#                          FORJA_DUENO_EMAIL (el único correo que puede registrarse y entrar)
# Opcionales:              FORJA_SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM/TO (avisos y códigos)
#                          PORT (8080), FORJA_SANDBOX=docker si no hay user namespaces
# Datos persistentes en /datos (monta ahí un volumen): proyectos, cuentas y sesiones.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY panel/package.json panel/
COPY desktop/package.json desktop/
RUN npm ci --ignore-scripts --workspace panel --include-workspace-root
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git bubblewrap socat ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
# Los CLI oficiales: cada cuenta inicia sesión desde el panel (Ajustes → Proveedores).
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
COPY panel/package.json panel/
COPY desktop/package.json desktop/
RUN npm ci --omit=dev --ignore-scripts --workspaces=false && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/panel/dist ./panel/dist
COPY prompts ./prompts
COPY docker ./docker
COPY LICENSE NOTICE ./
RUN mkdir -p /datos/home /datos/forja /datos/proyectos && chown -R node:node /datos
USER node
ENV NODE_ENV=production HOME=/datos/home FORJA_HOME=/datos/forja PORT=8080
VOLUME ["/datos"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli/bin.js", "servidor"]
