# 更新日志

版本号以仓库根目录的 [`VERSION`](./VERSION) 为准，镜像标签由 CI 自动按该版本生成。

## 0.2.1 — 2026-11-27

### 新增

- **自动发行版**：打 `v*` 标签后，构建成功的 Job 会接着创建 GitHub Release，正文自动生成——包含多架构说明、`docker pull` 命令（完整版本 + 主次版本）、镜像摘要、部署三行命令和 CHANGELOG 链接。
- Release 幂等：同一标签重复触发时改为更新说明，不会因「已存在」失败。

### 变更

- 工作流把镜像摘要（`digest`）从构建 Job 传给发行 Job，便于在发行说明里记录精确镜像。

## 0.2.0 — 2026-11-27

### 变更

- **网络模式改为 host**：`docker-compose.yml` 使用 `network_mode: host`，删除 `ports` 与 `extra_hosts`（host 模式下二者不兼容）。容器直接占用宿主 443 / 9443 / 11010–11012，EasyTier 的 TCP/UDP 监听不再经过 NAT。
- **修复 Caddy 抢占 80 端口**：`Caddyfile` 全局块新增 `auto_https disable_redirects`。宿主机已有 nginx 占用 80 时，Caddy 只监听 443/9443，证书继续走 TLS-ALPN。
- **管理接口收回到回环**：Caddy `admin` 从 `0.0.0.0:2019` 改为 `127.0.0.1:2019`；Node 新增 `HOST` 变量，默认只监听 `127.0.0.1:9600`，宿主机外部无法直连后端。
- **反代地址纠正**：`server.js` 不再把 `127.0.0.1` 改写成 `host.docker.internal`（host 模式下回环即宿主机），历史配置里的旧写法在启动时自动纠正为 `127.0.0.1`。
- **基础镜像可换源**：`Dockerfile` 的 `EASYTIER_IMAGE` / `CADDY_IMAGE` / `NODE_IMAGE` / `ALPINE_IMAGE` 均可通过 `--build-arg` 覆盖，构建末尾校验 node / caddy / easytier 版本。
- **部署脚本重写**：`deploy.sh` 增加 docker/compose 检查、`/dev/net/tun` 自动创建、端口占用检查、构建失败提示、启动后容器状态与 9443 探活，支持 `up` / `restart` / `logs`。
- **新增 `.env.example`**：账号密码与镜像源统一从 `.env` 读取；`.env` 已加入 `.gitignore` 与 `.dockerignore`。

### CI

- 工作流重写为版本驱动：读取 `VERSION`（tag 触发时以 tag 为准）生成 `0.2.0` / `0.2` / `latest` / `sha-xxxxxxx` 标签，同时写入 `org.opencontainers.image.version` 标签。
- 显式传入四个基础镜像的 build-arg，支持在仓库 **Variables** 中配置国内加速源。
- PR 只构建不推送；`workflow_dispatch` 可自定义构建平台；同一 ref 的重复构建自动取消。

## 0.1.0 — 2026-11-24

- 首个版本：Caddy 证书管理、DDNS（阿里云 / 腾讯云 / Cloudflare / Spaceship）、EasyTier 组网、备份与恢复、单容器多架构镜像。
