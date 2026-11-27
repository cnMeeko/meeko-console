# Meeko 面板 — SSL 证书 + DDNS + EasyTier 一体化控制台

[![version](https://img.shields.io/github/v/tag/cnMeeko/meeko-console?label=version&color=blue)](https://github.com/cnMeeko/meeko-console/tags)
[![release](https://img.shields.io/github/v/release/cnMeeko/meeko-console?label=release&color=brightgreen)](https://github.com/cnMeeko/meeko-console/releases)
[![build](https://github.com/cnMeeko/meeko-console/actions/workflows/docker-build.yml/badge.svg)](https://github.com/cnMeeko/meeko-console/actions/workflows/docker-build.yml)

一个容器搞定 **SSL 证书自动签发/续期**、**DDNS 动态解析**、**EasyTier 组网**、**NPS 内网穿透**，全部在同一个 Web 控制台里配置。

基于 Caddy + Node.js + NPS，单镜像、单容器，开箱即用。当前版本 **0.3.6**（见 [`VERSION`](./VERSION)，变更记录见 [`CHANGELOG.md`](./CHANGELOG.md)）。

> 本镜像带 `meeko.role=server` / `meeko.edition=server` 标签，是**服务端版**（内置 NPS 服务端、EasyTier 服务端与 Caddy），面相部署在服务器上使用。用 `docker inspect` 可确认：

```bash
docker inspect ghcr.io/cnmeeko/meeko-console:latest \
  --format '{{ index .Config.Labels "meeko.role" }} / {{ index .Config.Labels "meeko.edition" }}'
```

---

## ✨ 功能特性

- **SSL 证书管理**：Caddy 自动向 Let's Encrypt 申请并续期（90 天），支持为每个域名配置反向代理目标。
- **DDNS 动态解析**：内置支持阿里云、腾讯云、Cloudflare、Spaceship，可同时配置多个服务商，IPv4 / IPv6 分别管理。
- **EasyTier 组网**：内置 EasyTier 服务端，控制台内可配置主机名、网络、密码、虚拟 IP、监听端口等。
- **NPS 内网穿透**：内置 NPS 服务端（0.26.x），客户端用 vkey 连上桥接端口后，把内网 TCP / UDP 服务映射到服务器；隧道支持批量添加、批量编辑、批量删除。
- **备份与恢复**：支持本地导入/导出配置，以及七牛云 Kodo 对象存储备份（含区域选择），NPS 的客户端与隧道数据一并备份。
- **零预置数据**：首次启动不含任何默认域名或 DDNS 记录，避免信息泄露。

---

## 🐳 快速开始（Docker Compose）

### 1. 准备目录与配置文件

创建项目目录，放入以下文件：

| 文件 | 说明 |
|------|------|
| `docker-compose.yml` | 见下方模板 |
| `Caddyfile` | Caddy 主配置（见仓库内 `Caddyfile`） |
| `domains.caddy` | 域名片段（由控制台自动生成，初始可为空文件） |

> `domains.caddy` 初始为空文件即可：`touch domains.caddy`

### 2. docker-compose.yml

```yaml
services:
  console:
    build:
      context: .
      args:
        EASYTIER_IMAGE: ${EASYTIER_IMAGE:-easytier/easytier:latest}
        CADDY_IMAGE: ${CADDY_IMAGE:-caddy:2.8-alpine}
        NODE_IMAGE: ${NODE_IMAGE:-node:20-alpine}
        ALPINE_IMAGE: ${ALPINE_IMAGE:-alpine:3.23}
    image: meeko-console:latest
    container_name: meeko-console
    restart: unless-stopped
    # 宿主机网络模式：不开端口映射，容器直接占用宿主 443 / 9443 / 11010-11012
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_RAW
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      TZ: Asia/Shanghai
      PORT: "9600"
      HOST: "127.0.0.1"
      CONSOLE_USER: ${CONSOLE_USER:-admin}
      CONSOLE_PASS: ${CONSOLE_PASS:-admin}
    volumes:
      - ./console-data:/console-data
      - ./data:/data
      - ./domains.caddy:/etc/caddy/domains.caddy
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### 3. 启动

```bash
# 推荐：一键脚本（含环境自检、端口检查、启动后自检）
./deploy.sh

# 或者手动
docker compose build console
docker compose up -d
```

### 4. 访问控制台

浏览器打开 `http://你的服务器IP:9443`，输入 `CONSOLE_USER` / `CONSOLE_PASS` 登录。

---

## 🏗️ 自行构建镜像

如果你想从源码构建（例如在国内服务器上使用镜像加速源）：

```bash
git clone 你的仓库地址
cd 仓库目录

# 国内可指定全部基础镜像的加速源（不传则用官方源）
docker build \
  --build-arg VERSION=$(cat VERSION) \
  --build-arg EASYTIER_IMAGE=m.daocloud.io/docker.io/easytier/easytier:latest \
  --build-arg CADDY_IMAGE=m.daocloud.io/docker.io/library/caddy:2.8-alpine \
  --build-arg NODE_IMAGE=m.daocloud.io/docker.io/library/node:20-alpine \
  --build-arg ALPINE_IMAGE=m.daocloud.io/docker.io/library/alpine:3.23 \
  -t meeko-console:latest .
```

---

## 🔧 配置说明

### 网络模式

容器使用 **host 网络模式**（`network_mode: host`），与宿主机共用网卡和回环地址：

- 不需要 `ports` 端口映射，Caddy 直接监听宿主机 443 / 9443，EasyTier 直接监听 11010–11012。
- 容器内的 `127.0.0.1` 就是宿主机本身，所以反代目标填 `127.0.0.1:8080` 可直接访问宿主机上的服务，不再需要 `host.docker.internal`。
- Node 后端只监听 `127.0.0.1:9600`，由容器内 Caddy 反代，宿主机外部无法直连 9600。
- Caddy 管理接口 `admin` 只监听 `127.0.0.1:2019`，避免暴露到公网。

### 端口

| 端口 | 协议 | 用途 |
|------|------|------|
| 443 | TCP/UDP | Caddy HTTPS（证书签发与域名反代） |
| 9443 | TCP | 控制台 Web 入口（Caddy 反代到容器内 Node 9600） |
| 11010–11012 | TCP/UDP | EasyTier 组网监听端口 |
| 8024 | TCP | NPS 桥接端口（`npc` 客户端连接用） |
| 自定 | TCP/UDP | NPS 各隧道端口（TCP 隧道放行 tcp，UDP 隧道放行 udp） |
| 18080 | TCP | 仅回环：NPS 自带管理页（面板不靠它，不对外开放） |
| 9600 / 2019 | TCP | 仅回环：Node 后端与 Caddy 管理接口，不对外 |

> host 模式下这些端口直接占用宿主机端口，启动前需确认没有 nginx、caddy、面板等程序占用 443 / 9443。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CONSOLE_USER` | `admin` | 后台登录用户名 |
| `CONSOLE_PASS` | `admin` | 后台登录密码（**请务必修改**） |
| `DDNS_INTERVAL` | `300` | DDNS 检查间隔（秒） |
| `PORT` | `9600` | Node 监听端口 |
| `HOST` | `127.0.0.1` | Node 监听地址，默认仅回环 |
| `DATA_DIR` | `/console-data` | 控制台数据存储目录 |
| `CADDY_DATA` | `/data` | Caddy 证书存储目录 |
| `MEEKO_EDITION` | `server` | 镜像角色标识，服务端版为 `server` |
| `NPS_BIN` | `/opt/nps/nps` | NPS 服务端二进制路径 |
| `NPS_BRIDGE_PORT` | `8024` | NPS 桥接端口初始值（面板里可改，改完存 `panel.json`） |
| `NPS_WEB_PORT` | `18080` | NPS 自带管理页端口（只监听 127.0.0.1） |

> 可复制 `.env.example` 为 `.env` 填写账号密码与镜像源，Compose 会自动读取。

### 数据卷

| 宿主机路径 | 容器路径 | 说明 |
|------------|----------|------|
| `./console-data` | `/console-data` | 账号、域名、DDNS、EasyTier、NPS、备份配置 |
| `./data` | `/data` | Caddy 证书（迁移时务必保留，避免重复签发） |
| `./domains.caddy` | `/etc/caddy/domains.caddy` | 控制台生成的域名配置 |
| `./Caddyfile` | `/etc/caddy/Caddyfile` | Caddy 主配置（只读挂载） |

---

## 📖 使用指南

### SSL 证书

在「SSL 证书」标签页添加域名，可填写反向代理目标（如 `127.0.0.1:8080`），留空则仅签发证书。保存后 Caddy 自动申请证书并生效。

### DDNS 动态解析

在「DDNS 动态解析」标签页点击「添加服务商」，选择服务商并填写密钥：

- **服务商**：阿里云 / 腾讯云 / Cloudflare / Spaceship
- **IPv4 / IPv6**：可分别填写公网 IP（留空自动获取）和域名列表
- 每行一个域名，如 `example.com`、`www.example.com`；可用 `主机记录:主域名` 格式手动指定
- Cloudflare 只需 API Token，Secret 留空

保存后立即执行一次，之后按 `DDNS_INTERVAL` 间隔自动检查。

### EasyTier 组网

在「EasyTier 组网」标签页配置：
- 主机名、网络名称、网络密码（必填）
- 虚拟 IP（可选，如 `10.0.0.1`）
- 监听地址（默认 `11010`）
- 对端节点（可选）

点击「保存并启动」即可。

### NPS 内网穿透

「NPS 内网穿透」标签页分三块：

1. **服务端状态**：显示 NPS 进程、桥接端口、运行日志；**公网地址留空时自动读取本机公网 IP**（先取网卡地址，取不到再用外网探测，结果缓存在 `console-data/nps/server-addr.txt`），也可填成已解析到该地址的域名；桥接端口默认 `8024`，支持重启 / 停止。需要固定覆盖时设环境变量 `NPS_PUBLIC_ADDR`。
2. **客户端**：添加时自动生成 vkey，列表显示 `ID n`；每条客户端都能一键复制连接命令，也能直接启停（停用后该客户端连不上桥接端口）：

```bash
npc -server=你的公网地址:8024 -vkey=xxxxxx -type=tcp
```

3. **TCP 隧道 / UDP 隧道**：把服务器端口映射到客户端内网地址（`目标地址` 填 `127.0.0.1:22` 这类**客户端侧**地址）。支持：
   - 单条添加 / 编辑 / 删除；
   - **批量添加**：每行 `端口 目标地址 备注`，例如：

     ```
     9001 127.0.0.1:22 内网 SSH
     9002 192.168.1.10:3306 数据库
     ```

   - **批量编辑**：勾选多条后统一改客户端、监听 IP、备注、访问密码、启用状态（留空的项保持不变）；
   - **批量删除**：勾选后一次删除；
   - **状态可设置**：表格「状态」列是开关，点一下直接启用 / 停用；表格里的「客户端ID」列显示当前隧道归属的客户端编号，方便与备份文件对照。停用的隧道保留配置但不转发。

改动保存后面板会自动重启 NPS 进程使配置生效（隧道会短暂中断数秒）。别忘了在防火墙 / 安全组放行桥接端口与各隧道端口。

> 数据安全：每次写入 `clients.json` / `tasks.json` 前都会留一份同目录的 `*.bak` 快照；如果记录文件被清成 0 字节（误删、异常重启等），容器启动时会自动用快照恢复。删除客户端会连带删除其名下所有隧道，确认框会提示条数。

4. **其它隧道**：`tasks.json` 里如果存在 `socks5` / `httpProxy` 等非 TCP/UDP 记录（典型场景是从原生安装的 NPS 迁移过来），面板会在「其它隧道」区块里只读展示并可删除，避免这些记录在界面上"消失"。要新建或编辑这类隧道，请在 NPS 原生方式里改，或继续使用 TCP/UDP。

> 从原生 NPS 迁移：停掉原生进程（`systemctl disable --now Nps`），把 `conf/clients.json`、`conf/tasks.json`、`conf/hosts.json` 拷到 `console-data/nps/conf/`，桥接端口保持与原一致（现网客户端无需改配置），再重启容器即可。

### 备份与恢复

在「备份与恢复」标签页：
- **本地**：导出配置为 `.tar.gz`，或上传备份包恢复
- **七牛云**：配置 AccessKey / SecretKey / Bucket / 存储区域 / 下载域名后，可上传备份到对象存储并随时恢复

备份内容包含账号、域名、DDNS、EasyTier，以及 NPS 的 `panel.json` / `conf/nps.conf` / `conf/clients.json` / `conf/tasks.json` / `conf/hosts.json`；恢复后 NPS 会自动重启加载新数据。

---

## 🤖 GitHub Actions 自动构建

仓库内置 `.github/workflows/docker-build.yml`，推送代码到 `main` 分支或打 `v*` 标签时，会自动构建多架构（`linux/amd64`、`linux/arm64`）镜像并推送到 **GHCR**（GitHub Container Registry）。

镜像地址格式：

```
ghcr.io/cnmeeko/meeko-console:latest
```

标签由 CI 按 `VERSION` 文件自动生成，同一个版本号会同时产出四类标签：

构建流水线还会写入服务端标识：构建参数 `EDITION=server`、`NPS_VERSION=<版本>`，镜像标签 `meeko.role=server` / `meeko.edition=server`，所以从 GHCR 拉下来的都是服务端版。

| 标签 | 示例 | 说明 |
|------|------|------|
| 完整版本 | `0.2.1` | 与 `VERSION` / git tag 一致 |
| 主次版本 | `0.2` | 便于只跟随次版本更新 |
| `latest` | `latest` | 仅默认分支（main）构建时生成 |
| 提交号 | `sha-1a2b3c4` | 便于回溯到具体提交 |

> 打 `v*` 标签触发时，以标签号作为版本，`VERSION` 文件仅作为普通分支构建的版本来源。

### 发版流程

1. 改 `VERSION`（如 `0.3.0`）并更新 `CHANGELOG.md`；
2. 提交并推送到 `main`；
3. 打标签：`git tag v0.3.0 && git push origin v0.3.0`。

推送标签后 CI 会做三件事：**构建多架构镜像并打上 `0.3.0` / `0.3` / `sha-…` 标签**，**把镜像按平台导出成离线包**，再**自动创建 GitHub Release（发行版）**并把离线包作为附件挂上去 —— 所以「发行版」页面始终显示当前最新版本，而且能直接下载到该版本的镜像文件，不用手工点「Draft a new release」。重复推送同一标签时会更新说明并覆盖同名附件。

发行版附件（Assets）：

| 文件 | 说明 |
|------|------|
| `meeko-console-<版本>-linux-amd64.tar.gz` | x86_64 服务器用的镜像离线包（`docker save` 产物） |
| `meeko-console-<版本>-linux-arm64.tar.gz` | ARM64 服务器用（甲骨文 ARM、群晖 ARM 机型等） |
| `SHA256SUMS.txt` | 两个包的 sha256，下载后校验 |

内网 / 无外网服务器这样部署，不连 GHCR 也能跑：

```bash
docker load -i meeko-console-0.3.0-linux-amd64.tar.gz   # 按服务器架构选
sha256sum -c SHA256SUMS.txt
# 加载后镜像标签为 ghcr.io/cnmeeko/meeko-console:0.3.0
docker tag ghcr.io/cnmeeko/meeko-console:0.3.0 meeko-console:latest
```

再把 `docker-compose.yml` 里的 `build:` 段删掉、保留 `image: meeko-console:latest`，`bash deploy.sh up` 就直接用它启动。


首次使用需在仓库 **Settings → Actions → General → Workflow permissions** 中勾选 **Read and write permissions**，并在 **Packages** 设置中将镜像可见性设为 Public 或按需授权。

国内构建可选的加速源，在仓库 **Settings → Secrets and variables → Actions → Variables** 里新增（不配置则用官方源）：

| 变量名 | 示例值 |
|--------|--------|
| `EASYTIER_IMAGE` | `m.daocloud.io/docker.io/easytier/easytier:latest` |
| `CADDY_IMAGE` | `m.daocloud.io/docker.io/library/caddy:2.8-alpine` |
| `NODE_IMAGE` | `m.daocloud.io/docker.io/library/node:20-alpine` |
| `ALPINE_IMAGE` | `m.daocloud.io/docker.io/library/alpine:3.23` |
| `NPS_VERSION` | `0.26.10`（NPS 服务端版本，默认即此值） |

---

## 🩺 常见部署错误

| 现象 | 原因 | 处理 |
|------|------|------|
| `error gathering device information while adding custom device "/dev/net/tun": no such file or directory` | 服务器未启用 TUN/TAP（OpenVZ / LXC 常见） | `modprobe tun`；仍无 `/dev/net/tun` 则需服务商开启或换 KVM/物理机，EasyTier 必须有 TUN |
| `Bind for 0.0.0.0:443 failed: port is already allocated` 或 Caddy 日志 `address already in use` | 宿主机已有 nginx / caddy / 宝塔面板占用 443 或 9443 | 停掉占用服务；host 模式下无法改映射端口 |
| `network_mode: host` 与 `ports` 同时存在 → `conflicting options: port publishing and the container type network mode` | 旧版 compose 文件残留 `ports` | 已在本仓库移除，host 模式下不要再写 `ports` |
| 构建阶段拉取 `caddy` / `node` / `easytier` 镜像超时 | 国内访问 Docker Hub 受限 | 用 `CADDY_IMAGE` / `NODE_IMAGE` / `ALPINE_IMAGE` / `EASYTIER_IMAGE` 换加速源，或配置 `registry-mirrors` |
| `docker: 'compose' is not a docker command` | 只装了旧版 docker-compose 或未装 compose 插件 | 安装 `docker-compose-plugin`，`deploy.sh` 会自动兼容 v1 |
| 证书一直 pending，Caddy 日志报 DNS / 连接失败 | 域名未解析到本机、80/443 被防火墙拦截、或 DNS 有 CDN 代理 | 确认 A 记录指向本机公网 IP，放行 443，Cloudflare 记录设为 DNS-only |
| Caddy 日志 `listen tcp :80: bind: address already in use` | 宿主机上 nginx / 宝塔面板等已占用 80，而 Caddy 给域名站点默认会加一个 HTTP->HTTPS 跳转监听 | 已在 `Caddyfile` 全局块加 `auto_https disable_redirects`（本仓库默认已加），证书走 TLS-ALPN，不需要 80 |
| 反代到宿主机服务 502 | 目标服务只监听 `127.0.0.1` 之外的地址或端口不对 | host 模式下直接填 `127.0.0.1:端口` 即可，无需 `host.docker.internal` |

迁移提示：从桥接模式切换到 host 模式后，历史配置里如果存过 `host.docker.internal`，启动时会被自动纠正为 `127.0.0.1`，无需手工改 `domains.caddy`。

---

## ⚠️ 安全提示

- **务必修改默认密码** `CONSOLE_PASS`，切勿使用默认的 `admin`。
- 服务器凭据、AccessKey 等敏感信息请勿提交到代码仓库（例如 `服务器登录信息.md`）。
- 控制台建议仅在内网或通过 VPN 访问，或在 Caddy 中为 9443 配置访问控制。
- host 网络模式下容器直接占用宿主端口，`2019`（Caddy 管理接口）与 `9600`（Node 后端）已限定为仅回环访问。

---

## 📄 许可证

MIT
