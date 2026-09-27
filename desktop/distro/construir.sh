#!/usr/bin/env bash
# Construye la distro de WSL «Forja» y la exporta a <salida>/forja-wsl-x64.tar.gz (+ .sha256).
#   desktop/distro/construir.sh [salida]
# Necesita Docker. Empaqueta el Forja de este repositorio (npm pack), no el publicado.
set -euo pipefail
cd "$(dirname "$0")/../.."
out="$(realpath -m "${1:-desktop/distro/salida}")"
mkdir -p "$out"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; docker rm -f forja-wsl-export >/dev/null 2>&1 || true' EXIT

npm run -s build
tarball="$(npm pack --silent --pack-destination "$tmp")"
mv "$tmp/$tarball" "$tmp/forja.tgz"

docker build -f desktop/distro/Dockerfile --build-context "paquete=$tmp" -t forja-wsl desktop/distro
docker create --name forja-wsl-export forja-wsl >/dev/null
docker export forja-wsl-export | gzip -9 > "$out/forja-wsl-x64.tar.gz"
(cd "$out" && sha256sum forja-wsl-x64.tar.gz > forja-wsl-x64.tar.gz.sha256)
echo "OK: $out/forja-wsl-x64.tar.gz ($(du -h "$out/forja-wsl-x64.tar.gz" | cut -f1))"
