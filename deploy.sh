#!/usr/bin/env bash
# 一键部署 / 重启（Caddy + 证书控制台 + DDNS + EasyTier 单容器，host 网络模式）
# 用法：
#   ./deploy.sh          # 构建并启动
#   ./deploy.sh restart  # 仅重启，不重新构建
#   ./deploy.sh logs     # 查看日志
set -euo pipefail
cd "$(dirname "$0")"

log()  { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[deploy]\033[0m %s\n' "$*"; exit 1; }

ACTION="${1:-up}"

# ---------- 0. 依赖检查 ----------
command -v docker >/dev/null 2>&1 || die "未检测到 docker，请先安装：curl -fsSL https://get.docker.com | sh"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
  warn "当前使用旧版 docker-compose（v1），建议升级为 docker compose v2（docker-compose-plugin）"
else
  die "未检测到 docker compose，请安装 docker-compose-plugin：apt install docker-compose-plugin"
fi

docker info >/dev/null 2>&1 || die "docker 守护进程未运行或当前用户无权限（systemctl start docker / 加入 docker 组）"

# ---------- 1. TUN 设备（EasyTier 必需） ----------
if [ ! -e /dev/net/tun ]; then
  warn "/dev/net/tun 不存在，尝试自动创建"
  modprobe tun >/dev/null 2>&1 || true
  mkdir -p /dev/net
  if [ ! -c /dev/net/tun ]; then
    mknod /dev/net/tun c 10 200 >/dev/null 2>&1 || true
  fi
  chmod 666 /dev/net/tun >/dev/null 2>&1 || true
fi
if [ ! -e /dev/net/tun ]; then
  die "/dev/net/tun 不可用：该服务器未启用 TUN/TAP（OpenVZ/LXC 常见），EasyTier 组网无法运行，请联系服务商开启或改用 KVM/物理机"
fi

# ---------- 2. 基础配置 ----------
if [ ! -f domains.caddy ]; then
  printf '# 由 SSL 证书管理控制台自动生成，请勿手工修改\n' > domains.caddy
fi
mkdir -p console-data data

if [ ! -f .env ]; then
  warn "未发现 .env，将使用默认账号 admin/admin，请尽快创建 .env 设置强密码（参考 .env.example）"
elif grep -qs '^CONSOLE_PASS=admin' .env; then
  warn ".env 中 CONSOLE_PASS 仍为默认值 admin，存在安全风险，建议修改"
fi

# ---------- 3. 端口占用检查（host 模式直接占用宿主机端口） ----------
check_ports() {
  if ! command -v ss >/dev/null 2>&1; then
    warn "未找到 ss 命令，跳过端口占用检查"
    return 0
  fi
  for p in 443 9443 11010 11011 11012; do
    line=$(ss -lntup 2>/dev/null | grep -E "[:.]${p}[[:space:]]" | head -n 1 || true)
    if [ -n "$line" ]; then
      warn "端口 ${p} 已被占用：${line}"
      warn "host 网络模式下无法改映射端口，若该进程不是旧的本项目容器，请先停掉它再启动"
    fi
  done
}

# ---------- 4. 构建 / 启动 ----------
case "$ACTION" in
  restart)
    log "重启容器（不重新构建）"
    $DC up -d --remove-orphans
    ;;
  logs)
    exec docker logs -f --tail 200 meeko-console
    ;;
  up|"")
    # 先移除旧容器，避免它自己占着 443/9443 造成误判
    $DC down --remove-orphans >/dev/null 2>&1 || true
    check_ports

    log "构建镜像 meeko-console:latest"
    if ! $DC build console; then
      warn "镜像构建失败。国内服务器最常见原因是基础镜像拉取超时，可在 .env 中换用镜像加速源后重试："
      cat <<'TIP'
  EASYTIER_IMAGE=m.daocloud.io/docker.io/easytier/easytier:latest
  CADDY_IMAGE=m.daocloud.io/docker.io/library/caddy:2.8-alpine
  NODE_IMAGE=m.daocloud.io/docker.io/library/node:20-alpine
  ALPINE_IMAGE=m.daocloud.io/docker.io/library/alpine:3.23
  或在 /etc/docker/daemon.json 配置 registry-mirrors 后 systemctl restart docker
TIP
      exit 1
    fi
    log "启动容器（host 网络模式）"
    $DC up -d --remove-orphans
    ;;
  *)
    die "未知参数：$ACTION（可用：up | restart | logs）"
    ;;
esac

# ---------- 5. 启动后自检 ----------
log "等待服务启动..."
sleep 6
$DC ps

if ! docker inspect -f '{{.State.Status}}' meeko-console 2>/dev/null | grep -q '^running$'; then
  warn "容器未处于 running 状态，最近日志如下："
  docker logs --tail 80 meeko-console 2>&1 || true
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:9443/; then
    log "控制台 9443 访问正常：http://<服务器IP>:9443"
  else
    warn "9443 暂无响应，最近日志如下（常见原因：443/9443 被占用、Caddyfile 语法错误）："
    docker logs --tail 60 meeko-console 2>&1 || true
  fi
fi

log "完成。查看日志：./deploy.sh logs"
