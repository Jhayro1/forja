# Formato · bóveda (`*.enc`)

## Archivo

```
FORJA-BOVEDA v1\n
{ "kdf": "scrypt", "N": 131072, "r": 8, "p": 1, "sal": "<base64 16B>",
  "cifrado": "aes-256-gcm", "iv": "<base64 12B>", "tag": "<base64 16B>" }\n
<base64 del contenido cifrado>
```

- Permisos 600; el daemon rechaza abrirlo si son más abiertos.
- Cada escritura genera un IV nuevo y se hace de forma atómica (archivo temporal + rename).
- Se conserva una copia `.enc.anterior` de la versión previa.

## Contenido descifrado (sólo en memoria del daemon)

```jsonc
{
  "version": 1,
  "variables": { "LOG_LEVEL": "debug" },
  "secretos": {
    "STRIPE_KEY": { "valor": "…", "creado": "2026-09-24T…", "nota": "" }
  },
  "conexiones": {
    "cloudflare-principal": {
      "tipo": "cloudflare",
      "campos": { "zone_id": "3f2a…", "account_id": "…" },
      "secretos": { "api_token": "…" },
      "politica": {
        "niveles_permitidos": ["planeador", "medio"],
        "permisos_sin_aprobacion": ["dns:leer"],
        "permisos_con_aprobacion": ["dns:escribir"],
        "expira": "2026-12-31"
      },
      "ultima_prueba": { "ts": "…", "ok": true, "detalle": "token válido" }
    }
  },
  "mcp": {
    "cloudflare-dns": {
      "comando": "npx",
      "args": ["-y", "<paquete>"],
      "entorno": { "CLOUDFLARE_API_TOKEN": "@cloudflare-principal.api_token" },
      "conexiones": ["cloudflare-principal"]
    }
  }
}
```

Las referencias `@conexion.campo` se resuelven sólo al lanzar el proceso autorizado.
