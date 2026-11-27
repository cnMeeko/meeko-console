# 基础镜像均可通过 --build-arg 覆盖（国内服务器可换成镜像加速源，例如 m.daocloud.io/docker.io/...）
ARG EASYTIER_IMAGE=easytier/easytier:latest
ARG CADDY_IMAGE=caddy:2.8-alpine
ARG NODE_IMAGE=node:20-alpine
ARG ALPINE_IMAGE=alpine:3.23

FROM ${CADDY_IMAGE} AS caddy
FROM ${EASYTIER_IMAGE} AS easytier
FROM ${NODE_IMAGE} AS node

# 最终镜像：仅保留运行所需二进制与库，去除 npm/yarn/头文件等
FROM ${ALPINE_IMAGE}

# 版本号由 CI 读取 VERSION 文件传入，本地构建时用默认值
ARG VERSION=0.2.0
LABEL org.opencontainers.image.title="meeko-console" \
      org.opencontainers.image.description="Meeko 面板 — SSL 证书 + DDNS + EasyTier 一体化控制台" \
      org.opencontainers.image.source="https://github.com/cnMeeko/meeko-console" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

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
    && node --version \
    && caddy version \
    && (easytier-core --version || true)

ENV PORT=9600 \
    HOST=127.0.0.1 \
    DATA_DIR=/console-data \
    CADDY_DATA=/data \
    CADDY_SNIPPET=/etc/caddy/domains.caddy \
    CADDYFILE=/etc/caddy/Caddyfile \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/caddy-config \
    STATIC_DIR=/app/admin \
    DDNS_INTERVAL=300

EXPOSE 443 443/udp 9443
CMD ["/app/entrypoint.sh"]
