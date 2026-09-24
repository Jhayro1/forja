#!/usr/bin/env bash
# Instala una copia ESTABLE de Forja (una etiqueta o un commit) fuera del repo
# en desarrollo, para usar Forja para desarrollar Forja sin que se supervise a
# sí misma (MEJORAS 7 · v2/11). Los agentes cambian el repo; la copia que los
# orquesta no cambia hasta que decidas instalar otra.
#
#   bash scripts/forja-estable.sh            # la última etiqueta (o HEAD)
#   bash scripts/forja-estable.sh v0.3.0     # una etiqueta o commit concreto
#
# Destino: $FORJA_ESTABLE_DIR (por defecto ~/.forja-estable)/<commit>, y el
# enlace «actual» apunta a la instalada por última vez.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
REF="${1:-$(git -C "$REPO" describe --tags --abbrev=0 2>/dev/null || echo HEAD)}"
SHA="$(git -C "$REPO" rev-parse --verify "${REF}^{commit}")"
BASE="${FORJA_ESTABLE_DIR:-$HOME/.forja-estable}"
DEST="$BASE/$SHA"

if [ -n "$(git -C "$REPO" status --porcelain)" ] && [ "$REF" = "HEAD" ]; then
  echo "· aviso: hay cambios sin commit; la copia estable usa el último commit ($SHA), no tu árbol de trabajo" >&2
fi

if [ ! -f "$DEST/dist/cli/bin.js" ]; then
  echo "· instalando Forja $REF ($SHA) en $DEST"
  rm -rf "$DEST.tmp"
  mkdir -p "$DEST.tmp"
  # Sólo lo versionado en ese commit: nada del árbol de trabajo se cuela.
  git -C "$REPO" archive "$SHA" | tar -x -C "$DEST.tmp"
  (cd "$DEST.tmp" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
  rm -rf "$DEST"
  mv "$DEST.tmp" "$DEST"
fi
ln -sfn "$DEST" "$BASE/actual"

echo "✔ Forja estable $REF ($SHA) lista."
echo "  Úsala para trabajar sobre este repo con:"
echo "    alias forja-estable='node $BASE/actual/dist/cli/bin.js'"
echo "    forja-estable run"
