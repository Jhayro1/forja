#!/bin/sh
# Forja Ligera: instalador de un solo comando para macOS y Linux (ligera/PLAN.md F5).
#
#   curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/ligera.sh | sh
#
# Sin sudo: usa tu Node (22.13 o mas nuevo) o baja uno portable verificado con su
# SHA-256 oficial, e instala Forja Ligera ya compilada en ~/.local/share/forja-ligera
# con el comando "forja" en ~/.local/bin. Desinstalar: borra esas dos cosas.
set -eu

PREFIX="${FORJA_PREFIJO:-$HOME/.local/share/forja-ligera}"
BIN="$HOME/.local/bin"
PAQUETE="${FORJA_PAQUETE:-https://github.com/Jhayro1/forja/releases/latest/download/forja-ligera.tgz}"
inicio=$(date +%s)

paso() { printf -- '- %s\n' "$1"; }
falla() { printf 'error: %s\n' "$1" >&2; exit 1; }
node_ok() {
  v=$("$1" -v 2>/dev/null | sed 's/^v//') || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}
bajar() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }

mkdir -p "$PREFIX" "$BIN"
command -v git >/dev/null 2>&1 || falla 'falta Git: instalalo (p. ej. con xcode-select --install en macOS o el paquete git de tu distro) y vuelve a correr esto'
paso "$(git --version)"

if command -v node >/dev/null 2>&1 && node_ok node; then
  NODE_DIR=$(dirname "$(command -v node)")
  paso "Node $(node -v) ya instalado"
elif [ -x "$PREFIX/node/bin/node" ] && node_ok "$PREFIX/node/bin/node"; then
  NODE_DIR="$PREFIX/node/bin"
  paso "Node $("$NODE_DIR/node" -v) (el de Forja)"
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) falla "sistema no soportado: $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; arm64 | aarch64) arch=arm64 ;; *) falla "arquitectura no soportada: $(uname -m)" ;; esac
  base=https://nodejs.org/dist/latest-v24.x
  tmp=$(mktemp -d)
  bajar "$base/SHASUMS256.txt" "$tmp/sumas"
  linea=$(grep -E "node-v[0-9.]+-$os-$arch\.tar\.gz$" "$tmp/sumas" | head -n 1)
  [ -n "$linea" ] || falla "no encontre Node para $os-$arch"
  hash=${linea%% *}; nombre=${linea##* }
  paso "bajando Node portable ($os-$arch)..."
  bajar "$base/$nombre" "$tmp/$nombre"
  if command -v sha256sum >/dev/null 2>&1; then real=$(sha256sum "$tmp/$nombre" | cut -d' ' -f1); else real=$(shasum -a 256 "$tmp/$nombre" | cut -d' ' -f1); fi
  [ "$real" = "$hash" ] || falla 'la descarga de Node no coincide con su SHA-256 oficial; no se instala nada'
  rm -rf "$PREFIX/node" && mkdir -p "$PREFIX/node"
  tar -xzf "$tmp/$nombre" -C "$PREFIX/node" --strip-components=1
  rm -rf "$tmp"
  NODE_DIR="$PREFIX/node/bin"
  paso "Node $("$NODE_DIR/node" -v) listo"
fi

paso 'instalando Forja Ligera...'
PATH="$NODE_DIR:$PATH" "$NODE_DIR/npm" install -g --prefix "$PREFIX" --no-audit --no-fund --no-update-notifier --loglevel=error "$PAQUETE"
[ -x "$PREFIX/bin/forja" ] || falla "la instalacion no dejo $PREFIX/bin/forja"
# Un lanzador que siempre usa ESE Node, aunque el PATH cambie.
cat >"$BIN/forja" <<EOF
#!/bin/sh
PATH="$NODE_DIR:\$PATH" exec "$PREFIX/bin/forja" "\$@"
EOF
chmod 755 "$BIN/forja"
case ":$PATH:" in *":$BIN:"*) ;; *) paso "agrega $BIN a tu PATH (p. ej. en ~/.profile) para usar forja en terminales nuevas" ;; esac

command -v claude >/dev/null 2>&1 && c1=encontrado || c1='no encontrado'
command -v codex >/dev/null 2>&1 && c2=encontrado || c2='no encontrado'
printf '\nClaude Code: %s | Codex: %s\n' "$c1" "$c2"
if [ "$c1" != encontrado ] && [ "$c2" != encontrado ]; then
  echo 'Necesitas al menos uno: npm install -g @anthropic-ai/claude-code (y luego: claude) o npm install -g @openai/codex (y luego: codex login)'
fi
printf '\nListo en %ss. Abre el panel con: forja ui\n' "$(($(date +%s) - inicio))"
