#!/bin/sh
echo "1 leer_fuera: $(cat <CANARIO_FUERA>/secreto.txt 2>&1 | head -c 60)"
test -r $HOME/.codex/auth.json && echo "2 auth_codex: LEGIBLE" || echo "2 auth_codex: NO"
test -r $HOME/.claude/.credentials.json && echo "3 auth_claude: LEGIBLE" || echo "3 auth_claude: NO"
echo "4 red: $(curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com 2>&1 || echo FALLA)"
(echo x > <CANARIO_FUERA>/escrito_por_agente.txt) 2>/dev/null && echo "5 escribir_fuera: SI" || echo "5 escribir_fuera: NO"
(echo x > ./escrito_dentro.txt) 2>/dev/null && echo "6 escribir_dentro: SI" || echo "6 escribir_dentro: NO"
echo "7 env_con_TOKEN_o_KEY: $(env | grep -ciE 'token|api_key|secret')"
echo "8 netns: $(readlink /proc/self/ns/net) mntns: $(readlink /proc/self/ns/mnt)"
