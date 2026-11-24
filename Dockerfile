# EasyTier 镜像可通过 --build-arg EASYTIER_IMAGE=... 覆盖（国内可使用镜像加速源）
ARG EASYTIER_IMAGE=easytier/easytier:latest
FROM caddy:2.8-alpine AS caddy
FROM ${EASYTIER_IMAGE} AS easytier
FROM node:20-alpine AS node

# 最终镜像：仅保留运行所需二进制与库，去除 npm/yarn/头文件等
FROM alpine:3.23

# node 需要 musl 动态库（libstdc++、libgcc），ca-certificates 供 HTTPS 调用
RUN apk add --no-cache libstdc++ libgcc ca-certificates tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apk del tzdata

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=easytier /usr/local/bin/easytier-core /usr/local/bin/easytier-core

WORKDIR /app
COPY server/ /app/server/
COPY admin/ /app/admin/
COPY entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh /usr/local/bin/caddy /usr/local/bin/easytier-core \
    && node --version && caddy version

ENV PORT=9600 \
    DATA_DIR=/console-data \
    CADDY_DATA=/data \
    CADDY_SNIPPET=/etc/caddy/domains.caddy \
    CADDYFILE=/etc/caddy/Caddyfile \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/caddy-config \
    STATIC_DIR=/app/admin \
    DDNS_INTERVAL=300

EXPOSE 443 443/udp 9443 9600
CMD ["/app/entrypoint.sh"]
