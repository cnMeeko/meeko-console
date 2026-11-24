# Meeko 面板 — SSL 证书 + DDNS + EasyTier 一体化控制台

一个容器搞定 **SSL 证书自动签发/续期**、**DDNS 动态解析**、**EasyTier 组网**，全部在同一个 Web 控制台里配置。

基于 Caddy + Node.js，单镜像、单容器，开箱即用。

---

## ✨ 功能特性

- **SSL 证书管理**：Caddy 自动向 Let's Encrypt 申请并续期（90 天），支持为每个域名配置反向代理目标。
- **DDNS 动态解析**：内置支持阿里云、腾讯云、Cloudflare、Spaceship，可同时配置多个服务商，IPv4 / IPv6 分别管理。
- **EasyTier 组网**：内置 EasyTier 服务端，控制台内可配置主机名、网络、密码、虚拟 IP、监听端口等。
- **备份与恢复**：支持本地导入/导出配置，以及七牛云 Kodo 对象存储备份（含区域选择）。
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
    image: ghcr.io/你的用户名/meeko-console:latest
    container_name: meeko-console
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
      - NET_RAW
    devices:
      - /dev/net/tun:/dev/net/tun
    ports:
      - "443:443"
      - "443:443/udp"
      - "9443:9443"
      - "11010:11010/tcp"
      - "11010:11010/udp"
      - "11011:11011/tcp"
      - "11011:11011/udp"
      - "11012:11012/tcp"
      - "11012:11012/udp"
    environment:
      TZ: Asia/Shanghai
      # 管理后台账号密码（务必修改，勿使用默认值）
      CONSOLE_USER: admin
      CONSOLE_PASS: 你的强密码
    volumes:
      - ./console-data:/console-data
      - ./data:/data
      - ./domains.caddy:/etc/caddy/domains.caddy
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### 3. 启动

```bash
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

# 国内可指定 EasyTier 镜像加速源
docker build \
  --build-arg EASYTIER_IMAGE=m.daocloud.io/docker.io/easytier/easytier:latest \
  -t meeko-console:latest .
```

---

## 🔧 配置说明

### 端口

| 端口 | 协议 | 用途 |
|------|------|------|
| 443 | TCP/UDP | Caddy HTTPS（证书签发与域名反代） |
| 9443 | TCP | 控制台 Web 入口（Caddy 反代到内部 Node 9600） |
| 11010–11012 | TCP/UDP | EasyTier 组网监听端口 |

> `9600` 是容器内部 Node 后端端口，不对外暴露。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CONSOLE_USER` | `admin` | 后台登录用户名 |
| `CONSOLE_PASS` | `admin` | 后台登录密码（**请务必修改**） |
| `DDNS_INTERVAL` | `300` | DDNS 检查间隔（秒） |
| `PORT` | `9600` | 容器内 Node 监听端口 |
| `DATA_DIR` | `/console-data` | 控制台数据存储目录 |
| `CADDY_DATA` | `/data` | Caddy 证书存储目录 |

### 数据卷

| 宿主机路径 | 容器路径 | 说明 |
|------------|----------|------|
| `./console-data` | `/console-data` | 账号、域名、DDNS、EasyTier、备份配置 |
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

### 备份与恢复

在「备份与恢复」标签页：
- **本地**：导出配置为 `.tar.gz`，或上传备份包恢复
- **七牛云**：配置 AccessKey / SecretKey / Bucket / 存储区域 / 下载域名后，可上传备份到对象存储并随时恢复

---

## 🤖 GitHub Actions 自动构建

仓库内置 `.github/workflows/docker-build.yml`，推送代码到 `main` 分支或打 `v*` 标签时，会自动构建多架构（`linux/amd64`、`linux/arm64`）镜像并推送到 **GHCR**（GitHub Container Registry）。

镜像地址格式：

```
ghcr.io/<你的用户名>/<仓库名>:latest
```

首次使用需在仓库 **Settings → Actions → General → Workflow permissions** 中勾选 **Read and write permissions**，并在 **Packages** 设置中将镜像可见性设为 Public 或按需授权。

---

## ⚠️ 安全提示

- **务必修改默认密码** `CONSOLE_PASS`，切勿使用默认的 `admin`。
- 服务器凭据、AccessKey 等敏感信息请勿提交到代码仓库。
- 控制台建议仅在内网或通过 VPN 访问，或在 Caddy 中为 9443 配置访问控制。

---

## 📄 许可证

MIT
