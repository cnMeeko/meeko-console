# 基础镜像均可通过 --build-arg 覆盖（国内服务器可换成镜像加速源，例如 m.daocloud.io/docker.io/...）
ARG EASYTIER_IMAGE=easytier/easytier:latest
ARG CADDY_IMAGE=caddy:2.8-alpine
ARG NODE_IMAGE=node:20-alpine
ARG ALPINE_IMAGE=alpine:3.23
# NPS 服务端版本（ehang-io/nps release）
ARG NPS_VERSION=0.26.10

FROM ${CADDY_IMAGE} AS caddy
FROM ${EASYTIER_IMAGE} AS easytier
FROM ${NODE_IMAGE} AS node

# 最终镜像：仅保留运行所需二进制与库，去除 npm/yarn/头文件等
FROM ${ALPINE_IMAGE}

# 全局 ARG 在 stage 内不可见，这里必须重新声明，否则 RUN 里的 ${NPS_VERSION} 会变成字面量导致 404
ARG NPS_VERSION=0.26.10
ARG TARGETARCH=amd64

# 版本号由 CI 读取 VERSION 文件传入，本地构建时用默认值
ARG VERSION=0.3.11
# 镜像角色标识：本镜像内置 Caddy / EasyTier / NPS 服务端，属于装在服务器上的服务端版
ARG EDITION=server
LABEL org.opencontainers.image.title="meeko-console" \
      org.opencontainers.image.description="Meeko 面板（服务端版）— SSL 证书 + DDNS + EasyTier + NPS 一体化控制台" \
      org.opencontainers.image.source="https://github.com/cnMeeko/meeko-console" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      meeko.edition="${EDITION}" \
      meeko.role="server"

# node 需要 musl 动态库（libstdc++、libgcc），ca-certificates 供 HTTPS 调用
# NPS 服务端二进制按目标架构从官方 release 下载，只保留 nps 本体（不需要它的自带 Web UI）
# NPS 只认「二进制所在目录下的 conf/」，所以把 /opt/nps/conf 指向持久化数据卷
RUN apk add --no-cache libstdc++ libgcc ca-certificates tzdata curl tar \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && mkdir -p /opt/nps /console-data/nps/conf \
    && curl -fsSL -o /tmp/nps.tar.gz "https://github.com/ehang-io/nps/releases/download/v${NPS_VERSION}/linux_${TARGETARCH}_server.tar.gz" \
    && tar -xzf /tmp/nps.tar.gz -C /opt/nps \
    && rm -rf /opt/nps/web /opt/nps/conf /tmp/nps.tar.gz \
    && chmod +x /opt/nps/nps \
    && ln -sfn /console-data/nps/conf /opt/nps/conf \
    && apk del tzdata curl tar

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
    && (easytier-core --version || true) \
    && /opt/nps/nps -version

ENV PORT=9600 \
    HOST=127.0.0.1 \
    DATA_DIR=/console-data \
    CADDY_DATA=/data \
    CADDY_SNIPPET=/etc/caddy/domains.caddy \
    CADDYFILE=/etc/caddy/Caddyfile \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/caddy-config \
    STATIC_DIR=/app/admin \
    DDNS_INTERVAL=300 \
    MEEKO_EDITION=server \
    VERSION=${VERSION} \
    NPS_BIN=/opt/nps/nps \
    NPS_VERSION=${NPS_VERSION} \
    NPS_WEB_PORT=18080 \
    NPS_BRIDGE_PORT=8024

EXPOSE 443 443/udp 9443 8024 8024/udp
CMD ["/app/entrypoint.sh"]
