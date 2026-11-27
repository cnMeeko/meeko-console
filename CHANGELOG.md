# 更新日志

版本号以仓库根目录的 [`VERSION`](./VERSION) 为准，镜像标签由 CI 自动按该版本生成。

## 0.3.0 — 2026-11-27

### 新增

- **NPS 内网穿透服务端**集成进同一个容器：镜像内置 `nps 0.26.10`（按 `TARGETARCH` 从官方 release 下载 amd64/arm64 二进制），由后端在启动时拉起，数据落在 `/console-data/nps`。
- 面板新增「NPS 内网穿透」页签（位于「备份与恢复」之前），分三块管理：
  - **客户端**：添加 / 编辑 / 删除，自动生成 vkey，可一键复制 `npc -server=... -vkey=... -type=tcp` 连接命令。
  - **TCP 隧道** / **UDP 隧道**：单条添加、编辑、删除，并支持**批量添加**（每行 `端口 目标地址 备注`）、**批量编辑**（统一改客户端 / 监听 IP / 备注 / 密码 / 启用状态）、**批量删除**（勾选后一次删除）。
  - 支持修改桥接端口、面板显示公网地址，以及 NPS 进程的重启 / 停止 / 运行日志查看。
- 隧道改动后自动重启 NPS 使配置生效（先停进程、写数据文件、再拉起，避免运行中被覆盖）。

### 修改

- **备份与恢复**纳入 NPS 数据：`panel.json`、`conf/nps.conf`、`conf/clients.json`、`conf/tasks.json`、`conf/hosts.json` 都会随备份导出，恢复后自动重启 NPS。
- 镜像增加**服务端标识**：OCI 标签 `meeko.role=server`、`meeko.edition=server`，环境变量 `MEEKO_EDITION=server`，`/health` 返回 `edition`，面板标题旁显示「服务端版」徽标；GitHub Actions 的构建参数与标签同步加上该标识（`EDITION=server` / `NPS_VERSION`）。
- 启动日志文案由「SSL 证书管理服务」改为「Meeko 面板服务」。

### 说明

- NPS 自带的管理网页只监听 `127.0.0.1:18080`，不对外开放；镜像里也不再打包它的 Web 静态资源，界面统一走 Meeko 面板。
- 部署时需在防火墙/安全组放行 NPS 桥接端口（默认 `8024/tcp`）与各隧道端口（UDP 隧道同时放行 udp）。

## 0.2.4 — 2026-11-27

### 修改

- 浏览器标签页标题由「SSL 证书管理」改为「Meeko 面板管理」（`admin/index.html` 的 `<title>`），与页面主标题保持一致；SSL 证书仍是其中一个功能页签，不再是整站名称。

## 0.2.3 — 2026-11-27

### 修复

- 镜像导出改用 **skopeo**（`docker://` → `docker-archive:`），替代 `docker pull --platform` + `docker save`。
  原因：多架构镜像在 runner 的 containerd 镜像存储里只落单平台 manifest，`docker save` 会报
  `unable to create manifests file: NotFound: content digest sha256:…: not found`（arm64 导出因此失败，发行版被跳过）。
- 导出时显式写入 `<仓库>:<版本>` 引用，`manifest.json` 的 `RepoTags` 不再为空，`docker load` 后镜像直接带正确标签，无需手工 retag。
- 附带收益：不依赖 docker 守护进程，导出更稳、也不再重复拉取到本地镜像库。

## 0.2.2 — 2026-11-27

> 注：本版 CI 的导出步骤有缺陷（见 0.2.3），镜像虽已推送但发行版未生成，请直接使用 0.2.3。

### 新增

- **Release 附带镜像文件**：打 `v*` 标签后，CI 会把已推送的多架构镜像按平台导出成离线包，作为发行版资产上传：
  - `meeko-console-<版本>-linux-amd64.tar.gz`
  - `meeko-console-<版本>-linux-arm64.tar.gz`
  - `SHA256SUMS.txt`
- 新增 `export` job：按 `linux/amd64` / `linux/arm64` 矩阵并行 `docker pull` + `docker save`，产物经 artifact 传给发行 job，再 `gh release upload` 挂到对应 Release（`--clobber` 支持重复触发）。
- 离线部署路径：`docker load -i …tar.gz` 即可得到 `ghcr.io/cnmeeko/meeko-console:<版本>`，无需外网拉取。

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
