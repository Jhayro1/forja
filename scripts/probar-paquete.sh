#!/usr/bin/env bash
# Instalación limpia desde el tarball (V2-043): lo mismo que haría un usuario con
# `npm i -g @jhayro1/forja`, pero en un prefijo temporal y sin publicar nada.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
npm run build >/dev/null
tarball="$(npm pack --silent --pack-destination "$tmp")"
echo "paquete: $tarball ($(du -h "$tmp/$tarball" | cut -f1))"
# Nada de pruebas, fuentes TS ni documentos internos dentro del paquete.
if tar -tzf "$tmp/$tarball" | grep -E '\.test\.|/test/|\.ts$|/m0/|/v2/' >/dev/null; then
  echo "✘ el paquete incluye archivos que no deberían publicarse:"; tar -tzf "$tmp/$tarball" | grep -E '\.test\.|/test/|\.ts$|/m0/|/v2/'; exit 1
fi
npm install -g --prefix "$tmp/prefijo" "$tmp/$tarball" --no-audit --no-fund >/dev/null 2>&1
bin="$tmp/prefijo/bin/forja"
export FORJA_HOME="$tmp/home"
"$bin" --version
"$bin" doctor --json > "$tmp/doctor.json" || true
node -e 'const d=require(process.argv[1]); if(!Array.isArray(d.checks)) process.exit(1); console.log("doctor:", d.estado, d.checks.map(c=>c.id+"="+c.level).join(" "))' "$tmp/doctor.json"
cd "$tmp" && "$bin" nuevo demo --ruta "$tmp/demo" >/dev/null && cd "$tmp/demo" && "$bin" estado 2>"$tmp/estado.err" | head -1
# El arranque (dist/cli/bin.js) oculta sólo el aviso experimental de SQLite, sin `env -S`.
if grep -q ExperimentalWarning "$tmp/estado.err"; then echo "✘ se filtró el aviso experimental de SQLite"; cat "$tmp/estado.err"; exit 1; fi
head -1 "$tmp/prefijo/lib/node_modules/@jhayro1/forja/dist/cli/bin.js" | grep -qx '#!/usr/bin/env node'
test -f "$tmp/prefijo/lib/node_modules/@jhayro1/forja/panel/panel.js"
test -f "$tmp/prefijo/lib/node_modules/@jhayro1/forja/dist/runtime/runner-main.js"
test -f "$tmp/prefijo/lib/node_modules/@jhayro1/forja/dist/providers/sim-agent.js"
echo "✔ instalación limpia: CLI, doctor, proyecto nuevo, panel, runner y agente simulado presentes"
