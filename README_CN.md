[English](README.md) | **简体中文**

# My sing-box

在 Debian/Ubuntu VPS 上用 Docker 构建基于 sing-box 的 shadowsocks 2022 和 vless-reality-vision 节点，并导出给 Mihomo 使用的 `clash.yaml`。

## 部署内容

- Shadowsocks 2022（`2022-blake3-aes-128-gcm`），端口 `8388`，TCP 和 UDP。
- VLESS + REALITY，`flow` 为 `xtls-rprx-vision`，端口 `8443`，仅 TCP。服务端默认 SNI 为 `www.microsoft.com`。
- 容器镜像 `ghcr.io/sagernet/sing-box:latest`，`network_mode: host`。
- 客户端配置是 `clash.yaml`。默认节点 `My-sing-box`，可切换到 `My-VLESS-Reality`。

`8388` 和 `8443` 需要空闲。端口写在 `templates/config.json.template` 和 `templates/clash.yaml.template`。`compose.yaml` 不映射端口。

## 要求

- Debian/Ubuntu。部署目录可写，文件都放在 `/opt/sing-box/`。
- Docker、Docker Compose 插件（`docker compose version`），以及正在运行的 Docker daemon。
- Debian/Ubuntu 先运行 `sudo bash scripts/init.sh`。它只安装缺失的非 Docker 依赖（`ca-certificates`、`curl`、`openssl`、提供 `ss` 的 `iproute2`、`git`；没有 `awk`、`grep` 或 `coreutils` 时也装上），不安装 Docker，也不改 SSH、防火墙、用户或密码。
- openssl、curl（没有 curl 时 `gen-keys.sh` 接受 wget）。检测公网 IP 失败时才需要交互式终端。
- `ss`（`iproute2`）。没有它时 `start.sh` 只警告，并跳过 UDP 检查。
- 防火墙和安全组放行 `8388/tcp`、`8388/udp`、`8443/tcp`。
- 客户端使用 Mihomo 内核，例如 Clash Verge、FlClash 或 Clash Meta。

## 快速开始

```bash
git clone https://github.com/zht7063/my-singbox.git /opt/sing-box
cd /opt/sing-box
sudo bash scripts/init.sh
SING_BOX_VERSION=latest bash scripts/gen-keys.sh
bash scripts/gen-config.sh
bash scripts/conf-clash.sh
bash scripts/start.sh
```

还没有 `git` 时，先 `sudo apt-get update && sudo apt-get install -y git`，再克隆。`init.sh` 之后也会装上 `git`。

`SING_BOX_VERSION` 只决定 `gen-keys.sh` 用哪个镜像生成密钥。运行中的容器始终使用 `compose.yaml` 里的 `ghcr.io/sagernet/sing-box:latest`。

| 脚本 | 行为 | 产出 |
| --- | --- | --- |
| `scripts/init.sh` | 仅 Debian/Ubuntu，且必须 root（否则提示用 `sudo` 重跑）。`apt-get update` 后只安装缺失的非 Docker 依赖，并打印各工具是否存在。Docker 或 Compose 不可用时，提示看附录。 | 无项目文件 |
| `scripts/gen-keys.sh` | 检查 `docker`、`openssl` 和 `docker info`。用 curl（没有则用 wget）访问公网 IP 回显服务，先试 IPv4，没有公网 IPv4 再试 IPv6。成功时打印检测到的地址。失败时才询问 `Public IP address of this machine:`。私网、回环和保留地址会被拒绝。然后用 sing-box 镜像生成 UUID、REALITY 密钥和 Shadowsocks 2022 密码。 | `.env` |
| `scripts/gen-config.sh` | 用 `.env` 渲染服务端模板。配置里没有 `REALITY_PUBLIC_KEY` 和 `SERVER_ADDRESS`。 | `config.json` |
| `scripts/conf-clash.sh` | 用 `.env` 渲染客户端模板。分流规则原样保留。拒绝写入 REALITY 私钥。 | `clash.yaml` |
| `scripts/start.sh` | `docker compose up -d`，确认容器 `sing-box` 保持运行。 | 运行中的 sing-box |

三个产出文件已存在时，对应脚本拒绝覆盖。要重新生成，先删除那个文件。

## 验证、回滚、卸载

`scripts/start.sh` 在容器内执行 `sing-box check`，检查本机 `127.0.0.1` 上每个 `listen_port` 的 TCP，并用 `ss -uln` 检查 `8388` 的 UDP。没有 `ss` 时只警告，不失败。通过时打印 `Self-check passed. Ports: ...`。这只覆盖本机。客户端要连上，公网侧仍需放行上面的三个端口。

`latest` 无法启动或 `sing-box check` 失败时，把 `compose.yaml` 的镜像改为：

```yaml
image: ghcr.io/sagernet/sing-box:1.14.4
```

然后在 `/opt/sing-box` 执行 `docker compose up -d`。密钥也要改由 `1.14.4` 生成时，先删除 `.env`、`config.json`、`clash.yaml`，再用 `SING_BOX_VERSION=1.14.4` 按顺序重跑四个脚本，并让 `compose.yaml` 使用同一标签。

卸载只停掉本目录的容器，不删除仓库：

```bash
cd /opt/sing-box
docker compose down
```

## 目录

```text
/opt/sing-box/
├── compose.yaml
├── scripts/
├── templates/
├── skills/deploy-sing-box-node/SKILL.md
├── .env          # 生成
├── config.json   # 生成
└── clash.yaml    # 生成
```

生成文件和 `compose.yaml` 在同一目录，不要拷到系统其他路径。

## 给代理

代理部署时遵循 [`skills/deploy-sing-box-node/SKILL.md`](skills/deploy-sing-box-node/SKILL.md)。

## 凭据

`.env`、`config.json`、`clash.yaml` 含节点凭据，已写入 `.gitignore`。三个脚本把对应文件设为 `600`。REALITY 私钥只在 `.env` 和 `config.json` 中，不会写入 `clash.yaml`。不要提交这些文件。

## 附录：快速安装 Docker

`init.sh` 不安装 Docker。下面三步对应 [Debian](https://docs.docker.com/engine/install/debian/) 与 [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) 官方文档的 apt 仓库安装，并用 `/etc/os-release` 的 `ID` 区分发行版。

卸掉会和官方包冲突的旧包。包名是两份文档的并集，因此 Debian 和 Ubuntu 用同一条命令。这些包都没装时，`apt-get remove` 不会删任何东西。

```bash
sudo apt-get remove -y $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc | cut -f1)
```

添加 Docker 官方 apt 源：写入 GPG 密钥，并按 `ID` 选择 `debian` 或 `ubuntu` 的仓库。套件名在 Ubuntu 上用 `UBUNTU_CODENAME`，否则用 `VERSION_CODENAME`。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/${ID}
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
```

安装 Docker Engine、CLI、containerd、Buildx 插件和 Compose 插件。

```bash
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```
