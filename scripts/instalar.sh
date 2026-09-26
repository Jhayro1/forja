#!/usr/bin/env bash
# Instalador de un solo comando (Linux o WSL2 — Windows nativo no está soportado, ver
# docs/decisiones/ADR-011-aislamiento-windows.md). Mientras @jhayro1/forja no esté
# publicado en npm, esto clona el repo, lo compila y lo instala global desde el
# tarball, igual que haría `npm install -g @jhayro1/forja` una vez publicado.
#
#   curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh | bash
#
# Variables opcionales:
#   FORJA_REPO_DIR   dónde clonar/usar el repo (por defecto ~/forja)
#   FORJA_REF        rama o etiqueta a instalar (por defecto la default del remoto)
#   FORJA_SOURCE     de dónde clonar (URL git o ruta local); por defecto GitHub.
#                    Si ya tienes el repo clonado (p. ej. en Windows, visible en WSL como
#                    /mnt/c/...), pásalo aquí: es una copia local, no depende de que el
#                    repo sea público ni de red.
set -euo pipefail

log() { echo "· $*" >&2; }
fail() { echo "✘ $*" >&2; exit 1; }

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "Forja sólo corre en Linux (o Windows con WSL2). Ejecuta este script dentro de tu distro WSL, no en PowerShell/CMD."
fi

command -v git >/dev/null || fail "falta git. Instálalo (Debian/Ubuntu: sudo apt install -y git) y vuelve a correr este script."
command -v bwrap >/dev/null || fail "falta bubblewrap. Instálalo (Debian/Ubuntu: sudo apt install -y bubblewrap) y vuelve a correr este script."

if ! command -v node >/dev/null; then
  fail "falta Node.js >= 22.13. Instálalo con nvm y vuelve a correr este script:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.bashrc && nvm install 22"
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node $(node --version) es muy viejo, hace falta >=22.13 (nvm install 22)."

REPO_DIR="${FORJA_REPO_DIR:-$HOME/forja}"
if [[ -d "$REPO_DIR/.git" ]]; then
  log "repo ya existe en $REPO_DIR, actualizando"
  git -C "$REPO_DIR" fetch origin --quiet
  git -C "$REPO_DIR" checkout --quiet "${FORJA_REF:-main}"
  git -C "$REPO_DIR" pull --quiet origin "${FORJA_REF:-main}"
else
  SOURCE="${FORJA_SOURCE:-https://github.com/Jhayro1/forja.git}"
  log "clonando desde $SOURCE en $REPO_DIR"
  git clone --quiet "$SOURCE" "$REPO_DIR"
  [[ -n "${FORJA_REF:-}" ]] && git -C "$REPO_DIR" checkout --quiet "$FORJA_REF"
fi

log "instalando dependencias y compilando"
(cd "$REPO_DIR" && npm install --no-audit --no-fund --loglevel=error)

log "empaquetando e instalando global"
TARBALL="$(cd "$REPO_DIR" && npm pack --silent)"
npm install -g --no-audit --no-fund "$REPO_DIR/$TARBALL"
rm -f "$REPO_DIR/$TARBALL"

echo "✔ Forja instalado."
forja doctor || true
echo
echo "Siguiente paso: cd a tu proyecto y corre 'forja importar .' (o 'forja nuevo <nombre>')."
