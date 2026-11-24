#!/bin/bash
# 一键部署 / 重启（Caddy + 证书控制台 + DDNS + EasyTier 单容器）
set -euo pipefail
cd "$(dirname "$0")"

docker compose build console
docker compose up -d --remove-orphans

echo "等待服务启动..."
sleep 6
docker compose ps
echo "--- 容器日志 ---"
docker logs --tail 40 meeko-console || true
