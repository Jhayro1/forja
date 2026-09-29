# «Puerta» de Forja en Doko (plan de despliegue v3): Doko pone el dominio y el TLS; este nginx sin
# privilegios reenvía al Forja que corre en el host (fuera de un contenedor, porque los agentes
# necesitan bubblewrap). Funciona con las restricciones de Doko: cap_drop ALL y no-new-privileges.
FROM nginxinc/nginx-unprivileged:1.29-alpine
# Contexto de construcción: la raíz del repositorio (como en Doko).
COPY deploy/doko-puerta/default.conf.template /etc/nginx/templates/default.conf.template
# Dirección de Forja en el host, alcanzable desde la red doko-proxy (su puerta de enlace).
ENV FORJA_UPSTREAM=172.19.0.1:8090
EXPOSE 8080
