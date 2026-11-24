#!/bin/sh
set -e

mkdir -p /data /console-data

# Caddy 与 Node 同容器：Caddy 占用 443/9443，Node 只在 9600
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# Caddyfile 或 domains.caddy 变化时热重载（替代独立的 reloader 容器）
(
  last=""
  while true; do
    cur=$(cat /etc/caddy/Caddyfile /etc/caddy/domains.caddy 2>/dev/null | md5sum | cut -d' ' -f1)
    if [ -n "$last" ] && [ "$cur" != "$last" ]; then
      echo "[reloader] 配置有变化，正在重载 Caddy"
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address 127.0.0.1:2019 || true
    fi
    last="$cur"
    sleep 2
  done
) &

sleep 2
if ! kill -0 "$CADDY_PID" 2>/dev/null; then
  echo "[entrypoint] Caddy 启动失败，请检查 Caddyfile"
  exit 1
fi

exec node /app/server/server.js
