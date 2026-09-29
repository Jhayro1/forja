# Desplegar Forja en un servidor

Forja tiene dos piezas en un servidor:

1. **Forja en el host** (`deploy/host/`): `forja servidor` como servicio de systemd. Va en el host
   y no en un contenedor porque los agentes se aíslan con bubblewrap, y bubblewrap no funciona
   dentro de un contenedor Docker, ni siquiera con `--privileged` (V3-732 en
   [v3/PLAN.md](../v3/PLAN.md)).
2. **La puerta** (`deploy/doko-puerta/`): un nginx sin privilegios que la plataforma (Doko u
   otra) publica con su dominio y TLS, y que reenvía a Forja por la red interna de Docker. Cumple
   las restricciones típicas de una plataforma: `cap_drop: ALL`, `no-new-privileges`, 512 MB y
   sin volumen.

```
navegador ──HTTPS──▶ proxy de la plataforma (Traefik) ──▶ puerta (nginx, contenedor)
                                                              │ red docker (p. ej. 172.19.0.1:8090)
                                                              ▼
                                                 forja servidor (systemd, host)
                                                     └─ agentes en bubblewrap
```

| Archivo | Para qué |
|---|---|
| `host/forja.service` | Unidad de systemd: usuario `forja`, datos en `/var/lib/forja`, sólo en la IP de la red de Docker, límites de memoria y CPU |
| `host/apparmor-bwrap` | Perfil de AppArmor que permite a bubblewrap crear namespaces en Ubuntu 24.04 con un usuario sin privilegios |
| `doko-puerta/Dockerfile` | Imagen de la puerta; se construye con la raíz del repositorio como contexto |
| `doko-puerta/default.conf.template` | nginx: conserva el `Host`, sin búfer para los eventos en vivo, `FORJA_UPSTREAM` configurable |

Seguridad: el login, el registro cerrado y la protección de rutas son los de
[SERVIDOR.md](../docs/guias/SERVIDOR.md). Forja nunca escucha en la IP pública.
