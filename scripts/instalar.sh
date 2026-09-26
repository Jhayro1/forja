#!/usr/bin/env bash
# Instalador de un solo comando (Linux o WSL2; Windows nativo no esta soportado, ver
# docs/decisiones/ADR-011-aislamiento-windows.md). Instala lo que falte (git, bubblewrap,
# Node 22 via nvm), clona el repo, lo compila y lo instala global desde el tarball, igual
# que haria `npm install -g @jhayro1/forja` una vez publicado.
#
#   curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh -o /tmp/i.sh && bash /tmp/i.sh
#
# Variables opcionales:
#   FORJA_REPO_DIR   donde clonar/usar el repo (por defecto ~/forja)
#   FORJA_REF        rama o etiqueta a instalar (por defecto main)
#   FORJA_SOURCE     de donde clonar (URL git o ruta local); por defecto GitHub.
#
# Con --sistema solo hace la parte que necesita root (paquetes y el lanzador global) y
# sale: instalar.ps1 la corre con `wsl -u root`, que no pide contrasena, para que la parte
# de usuario ya no tenga nada que pedirle a sudo. En Linux, sin --sistema, lo que falte se
# pide con sudo una sola vez; si ya esta todo, no se vuelve a pedir.
#
# Solo ASCII en los mensajes: la salida puede terminar en una consola de Windows que no
# la muestra como UTF-8.
set -euo pipefail

log() { echo "- $*" >&2; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || fail "Forja solo corre en Linux (o Windows con WSL2)."

# --- Lo que necesita root ---------------------------------------------------------------
as_root() { if ((EUID == 0)); then "$@"; else sudo "$@"; fi; }

# /usr/local/bin/forja es un lanzador fijo (no depende de donde quedo Node), asi que se
# escribe una vez y las reinstalaciones no lo tocan. El real, con la ruta de Node, vive en
# ~/.local/bin/forja y lo escribe la parte de usuario, sin sudo. Hace falta porque
# `wsl -- forja` (el forja.cmd de Windows) no carga .bashrc, y ~/.local/bin solo entra al
# PATH en un shell de login.
GLOBAL_LAUNCHER=/usr/local/bin/forja
launcher_body() {
  printf '%s\n' '#!/bin/sh' \
    '# Lanzador de Forja: el de cada usuario esta en ~/.local/bin/forja (lo deja el instalador).' \
    '[ -x "$HOME/.local/bin/forja" ] || { echo "Forja no esta instalado para $(id -un): corre el instalador." >&2; exit 1; }' \
    'exec "$HOME/.local/bin/forja" "$@"'
}
launcher_ok() { [[ -f "$GLOBAL_LAUNCHER" ]] && [[ "$(cat "$GLOBAL_LAUNCHER")" == "$(launcher_body)" ]]; }
# Solo se reemplaza un script de shell (este lanzador o el de versiones anteriores), nunca
# el forja que deja `npm install -g` si Node es del sistema.
launcher_replaceable() { [[ ! -e "$GLOBAL_LAUNCHER" ]] || [[ "$(head -n1 "$GLOBAL_LAUNCHER")" == '#!/bin/sh' ]]; }

missing=()
command -v git >/dev/null || missing+=(git)
command -v bwrap >/dev/null || missing+=(bubblewrap)
command -v curl >/dev/null || missing+=(curl)
if ((${#missing[@]})); then
  command -v apt-get >/dev/null || fail "faltan ${missing[*]} y esta distro no usa apt: instalalos a mano y vuelve a correr esto."
  ((EUID == 0)) || log "instalando ${missing[*]} (te pide tu contrasena de Linux una sola vez)"
  as_root apt-get update -qq
  as_root apt-get install -y -qq "${missing[@]}"
fi
if ! launcher_ok && launcher_replaceable; then
  ((EUID == 0)) || log "dejando el lanzador /usr/local/bin/forja (te pide tu contrasena de Linux una sola vez)"
  launcher_body | as_root tee "$GLOBAL_LAUNCHER" >/dev/null
  as_root chmod 755 "$GLOBAL_LAUNCHER"
fi

if [[ "${1:-}" == --sistema ]]; then
  echo "OK: paquetes del sistema y lanzador listos."
  exit 0
fi

# --- Node >= 22.13 ---------------------------------------------------------------------
# nvm se inicializa en ~/.bashrc, pero el .bashrc de Ubuntu se corta al principio en shells
# no interactivos (como este script corriendo via `wsl`), asi que se carga a mano.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() {
  [[ -s "$NVM_DIR/nvm.sh" ]] || return 1
  set +eu # nvm.sh no esta escrito para -e/-u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  set -eu
}

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}

load_nvm || true
if ! node_ok; then
  if ! load_nvm; then
    log "instalando nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o /tmp/forja-nvm-install.sh
    bash /tmp/forja-nvm-install.sh >/dev/null
    load_nvm || fail "no se pudo cargar nvm despues de instalarlo."
  fi
  log "instalando Node 22 con nvm"
  set +eu
  nvm install 22 >/dev/null && nvm alias default 22 >/dev/null
  set -eu
  node_ok || fail "no se pudo dejar Node >= 22.13 disponible."
fi
log "Node $(node --version)"

# --- Repo ------------------------------------------------------------------------------
REPO_DIR="${FORJA_REPO_DIR:-$HOME/forja}"
REF="${FORJA_REF:-main}"
if [[ -d "$REPO_DIR/.git" ]]; then
  log "repo ya existe en $REPO_DIR, actualizando"
  [[ -n "${FORJA_SOURCE:-}" ]] && git -C "$REPO_DIR" remote set-url origin "$FORJA_SOURCE"
  git -C "$REPO_DIR" fetch --quiet origin
  git -C "$REPO_DIR" checkout --quiet "$REF"
  git -C "$REPO_DIR" reset --quiet --hard "origin/$REF"
else
  SOURCE="${FORJA_SOURCE:-https://github.com/Jhayro1/forja.git}"
  log "clonando desde $SOURCE en $REPO_DIR"
  git clone --quiet --branch "$REF" "$SOURCE" "$REPO_DIR"
fi

log "instalando dependencias y compilando"
(cd "$REPO_DIR" && npm install --no-audit --no-fund --loglevel=error)

log "empaquetando e instalando global"
TARBALL="$(cd "$REPO_DIR" && npm pack --silent)"
npm install -g --no-audit --no-fund --loglevel=error "$REPO_DIR/$TARBALL"
rm -f "$REPO_DIR/$TARBALL"

# --- forja visible fuera de un shell interactivo ----------------------------------------
# Con Node de nvm, `forja` queda en un directorio que solo entra al PATH desde .bashrc.
# Este lanzador antepone ese directorio al PATH (claude/codex instalados con el mismo npm
# tambien quedan visibles para Forja); /usr/local/bin/forja delega en el.
NODE_BIN="$(dirname "$(command -v node)")"
if [[ "$NODE_BIN" != /usr/bin && "$NODE_BIN" != /usr/local/bin ]]; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexport PATH="%s:$PATH"\nexec "%s/forja" "$@"\n' "$NODE_BIN" "$NODE_BIN" >"$HOME/.local/bin/forja"
  chmod 755 "$HOME/.local/bin/forja"
fi

# --- Claude Code: el agente que Forja lanza ---------------------------------------------
# Forja no trae su propio modelo: ejecuta el CLI oficial de Claude con tu suscripcion. Tiene
# que estar en este Linux (aunque ya lo tengas en Windows) y con la sesion iniciada.
if ! command -v claude >/dev/null; then
  log "instalando Claude Code"
  npm install -g --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code
fi
if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  log "Claude Code ya tiene sesion iniciada"
elif [[ -t 0 ]]; then
  log "iniciando sesion en Claude Code (si no se abre el navegador, copia el enlace que aparece)"
  claude auth login || log "no se completo el inicio de sesion; puedes hacerlo despues con: claude auth login"
else
  log "falta iniciar sesion en Claude Code: corre 'claude auth login' en Ubuntu"
fi

echo "OK: Forja instalado."
forja doctor || true
echo
echo "Para abrir Forja escribe: forja   (se abre en tu navegador; todo corre en tu PC)"
