#!/usr/bin/env bash
# Forja en un VPS con un solo comando (Ubuntu 22.04/24.04 o Debian 12, como root):
#
#   curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar-servidor.sh -o /tmp/fs.sh
#   sudo bash /tmp/fs.sh --dominio forja.tudominio.com --dueno tu@correo.com
#
# Que hace (y se puede volver a correr: es idempotente):
#   1. Paquetes: git, bubblewrap, acl, curl; Node 24 si falta o es viejo.
#   2. Usuario de sistema «forja» y carpetas /var/lib/forja (datos y proyectos) y /etc/forja.
#   3. Perfil de AppArmor para bubblewrap si el kernel restringe los namespaces (Ubuntu 24.04).
#   4. Forja desde main en /opt/forja/<commit> (enlace «actual»), y Claude Code y Codex.
#   5. /etc/forja/forja.env (URL publica y correo del dueno) y el servicio systemd «forja».
#   6. Publicarlo con HTTPS: --modo caddy (por defecto) instala Caddy con certificado
#      automatico; --modo doko escucha en la red de Docker de Doko para su «puerta».
#
# Opciones:
#   --dominio D     dominio publico (el DNS ya debe apuntar a este VPS)       [obligatorio]
#   --dueno CORREO  el unico correo que podra registrarse y entrar            [obligatorio]
#   --modo caddy|doko|ninguno   como publicarlo (por defecto caddy)
#   --ref RAMA      rama o etiqueta a instalar (por defecto main)
#   --actualizar    solo actualiza el codigo a --ref y reinicia (no toca configuracion)
#
# Forja nunca escucha en la IP publica: en modo caddy escucha en 127.0.0.1 y en modo doko
# en la puerta de enlace de la red doko-proxy. Solo ASCII en los mensajes.
set -euo pipefail

log() { echo "- $*"; }
ok() { echo "OK $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

DOMINIO="" DUENO="" MODO="caddy" REF="main" ACTUALIZAR=0
REPO="${FORJA_SOURCE:-https://github.com/Jhayro1/forja}"
while (($#)); do
  case "$1" in
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --dueno) DUENO="${2:-}"; shift 2 ;;
    --modo) MODO="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --actualizar) ACTUALIZAR=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) fail "opcion desconocida: $1 (usa --help)" ;;
  esac
done

((EUID == 0)) || fail "corre este instalador como root (sudo bash $0 ...)"
[[ "$(uname -s)" == "Linux" ]] || fail "solo Linux"
PREFIX=/opt/forja DATA=/var/lib/forja ETC=/etc/forja

# ---------------------------------------------------------------- codigo ----------------
instalar_codigo() {
  mkdir -p "$PREFIX"
  if [[ -d "$PREFIX/src/.git" ]]; then
    git -C "$PREFIX/src" fetch -q origin
  else
    git clone -q "$REPO" "$PREFIX/src"
  fi
  git -C "$PREFIX/src" checkout -q --detach "origin/$REF" 2>/dev/null || git -C "$PREFIX/src" checkout -q --detach "$REF"
  local v prev
  v="$(git -C "$PREFIX/src" rev-parse --short HEAD)"
  prev="$(readlink "$PREFIX/actual" 2>/dev/null || true)"
  if [[ "$prev" == "$PREFIX/$v" && -f "$PREFIX/$v/dist/cli/bin.js" ]]; then
    ok "Forja ya esta en $v"
    return 1
  fi
  log "compilando Forja $v (unos minutos)..."
  (cd "$PREFIX/src" && npm ci --no-audit --no-fund >/dev/null && npm run -s build >/dev/null)
  rm -rf "${PREFIX:?}/${v:?}.tmp" && cp -a "$PREFIX/src" "$PREFIX/$v.tmp" && rm -rf "${PREFIX:?}/${v:?}" && mv -T "$PREFIX/$v.tmp" "$PREFIX/$v"
  ln -sfn "$PREFIX/$v" "$PREFIX/actual"
  chown -R root:forja "$PREFIX" && chmod -R o-rwx "$PREFIX" && chmod -R g+rX "$PREFIX"
  ok "Forja $v instalado en $PREFIX/$v${prev:+ (antes: ${prev##*/})}"
}

esperar_salud() {
  local url="$1"
  for _ in $(seq 1 20); do curl -fsS "$url" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

if ((ACTUALIZAR)); then
  id forja >/dev/null 2>&1 || fail "Forja no esta instalado en este servidor"
  if instalar_codigo; then systemctl restart forja; fi
  host="$(sed -nE 's/.*servidor --host ([^ ]+) --puerto ([0-9]+).*/\1:\2/p' /etc/systemd/system/forja.service)"
  esperar_salud "http://$host/salud" && ok "Forja responde en $host" || fail "Forja no responde tras actualizar: journalctl -u forja"
  exit 0
fi

[[ -n "$DOMINIO" && "$DOMINIO" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "falta --dominio (p. ej. forja.tudominio.com)"
[[ -n "$DUENO" && "$DUENO" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "falta --dueno con un correo valido"
[[ "$MODO" =~ ^(caddy|doko|ninguno)$ ]] || fail "--modo debe ser caddy, doko o ninguno"

# ---------------------------------------------------------------- 1. paquetes -----------
log "paquetes del sistema..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git bubblewrap acl curl ca-certificates gnupg >/dev/null
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if ((node_major < 22)); then
  log "instalando Node 24 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node --version), git, bubblewrap"

# ---------------------------------------------------------------- 2. usuario ------------
id forja >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DATA/home" --shell /usr/sbin/nologin forja
install -d -o forja -g forja -m 750 "$DATA"
install -d -o forja -g forja -m 700 "$DATA/datos" "$DATA/home" "$DATA/home/proyectos"
install -d -o root -g forja -m 750 "$ETC"
ok "usuario forja y carpetas en $DATA"

# ---------------------------------------------------------------- 3. sandbox ------------
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == "1" ]]; then
  cat >/etc/apparmor.d/forja-bwrap <<'EOF'
# Forja: permite a bubblewrap crear namespaces de usuario (sandbox de los agentes).
abi <abi/4.0>,
include <tunables/global>

profile forja-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/forja-bwrap>
}
EOF
  apparmor_parser -r /etc/apparmor.d/forja-bwrap
fi
runuser -u forja -- bwrap --ro-bind / / --unshare-net true || fail "bubblewrap no puede aislar con el usuario forja (contenedor o kernel sin namespaces?)"
ok "sandbox de los agentes (bubblewrap) funcionando"

# ---------------------------------------------------------------- 4. codigo y CLIs ------
instalar_codigo || true
log "Claude Code y Codex para el usuario forja..."
npm install -g --prefix "$PREFIX/cli" --no-audit --no-fund @anthropic-ai/claude-code @openai/codex >/dev/null
chown -R root:forja "$PREFIX/cli" && chmod -R o-rwx "$PREFIX/cli" && chmod -R g+rX "$PREFIX/cli"
ok "claude $("$PREFIX/cli/bin/claude" --version 2>/dev/null | cut -d' ' -f1) y $("$PREFIX/cli/bin/codex" --version 2>/dev/null)"

# ---------------------------------------------------------------- 5. servicio -----------
case "$MODO" in
  doko)
    HOST="$(docker network inspect doko-proxy --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
    [[ -n "$HOST" ]] || fail "no encontre la red doko-proxy: Doko esta instalado en este servidor?"
    ;;
  *) HOST=127.0.0.1 ;;
esac
PORT=8090
if [[ ! -f "$ETC/forja.env" ]]; then
  umask 027
  cat >"$ETC/forja.env" <<EOF
# Forja en modo servidor. El correo SMTP y el token de GitHub se configuran en el panel
# (Ajustes); si se definen aqui FORJA_SMTP_* o FORJA_GITHUB_TOKEN, mandan sobre el panel.
FORJA_URL_PUBLICA=https://$DOMINIO
FORJA_DUENO_EMAIL=$DUENO
EOF
  chown root:forja "$ETC/forja.env" && chmod 640 "$ETC/forja.env"
fi
cat >/etc/systemd/system/forja.service <<EOF
[Unit]
Description=Forja (modo servidor)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=forja
Group=forja
WorkingDirectory=$PREFIX/actual
EnvironmentFile=$ETC/forja.env
Environment=NODE_ENV=production HOME=$DATA/home FORJA_HOME=$DATA/datos
Environment=PATH=$PREFIX/cli/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v node) $PREFIX/actual/dist/cli/bin.js servidor --host $HOST --puerto $PORT
Restart=on-failure
RestartSec=5
MemoryMax=6G
CPUQuota=200%
Nice=10
IOSchedulingClass=idle
TasksMax=2048
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q forja
systemctl restart forja
esperar_salud "http://$HOST:$PORT/salud" || fail "el servicio no responde: journalctl -u forja"
ok "servicio forja escuchando en $HOST:$PORT (nunca en la IP publica)"

# ---------------------------------------------------------------- 6. HTTPS --------------
if [[ "$MODO" == caddy ]]; then
  if ! command -v caddy >/dev/null; then
    log "instalando Caddy (HTTPS automatico)..."
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  if ! grep -q "^$DOMINIO " /etc/caddy/Caddyfile 2>/dev/null; then
    cat >>/etc/caddy/Caddyfile <<EOF

$DOMINIO {
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
  fi
  systemctl reload caddy || systemctl restart caddy
  ok "Caddy publica https://$DOMINIO"
fi

echo
echo "Listo. Siguiente paso:"
case "$MODO" in
  doko)
    echo "  En Doko: servicio web con el Dockerfile deploy/doko-puerta/Dockerfile de este repo,"
    echo "  puerto 8080, health check /salud, variable FORJA_UPSTREAM=$HOST:$PORT y dominio $DOMINIO."
    ;;
  ninguno) echo "  Publica http://$HOST:$PORT detras de tu proxy con TLS en https://$DOMINIO." ;;
esac
echo "  Entra a https://$DOMINIO/login y crea la cuenta del dueno ($DUENO)."
echo "  Sin correo configurado, el codigo de verificacion sale aqui:  journalctl -u forja | grep codigo"
echo "  Actualizar mas adelante:  sudo bash $0 --actualizar"
