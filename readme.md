# Quick Sing-box Node

在 Linux 上用 Docker 运行 sing-box，并导出给 Mihomo 使用的 `clash.yaml`。

## 部署内容

- Shadowsocks 2022（`2022-blake3-aes-128-gcm`），端口 `8388`，TCP 和 UDP。
- VLESS + REALITY，`flow` 为 `xtls-rprx-vision`，端口 `8443`，仅 TCP。服务端默认 SNI 为 `www.microsoft.com`。
- 容器镜像 `ghcr.io/sagernet/sing-box:latest`，`network_mode: host`。
- 客户端配置是 `clash.yaml`。默认节点 `My-sing-box`，可切换到 `My-VLESS-Reality`。

`8388` 和 `8443` 需要空闲。端口写在 `templates/config.json.template` 和 `templates/clash.yaml.template`。`compose.yaml` 不映射端口。

## 要求

- Linux。部署目录可写，文件都放在 `/opt/sing-box/`。
- Docker、Docker Compose 插件（`docker compose version`），以及正在运行的 Docker daemon。
- openssl。
- curl 或 wget，用来检测公网 IP。Debian/Ubuntu 可执行 `apt install curl`。两者都没有，或检测失败时，才需要交互式终端。
- 防火墙和安全组放行 `8388/tcp`、`8388/udp`、`8443/tcp`。
- 客户端使用 Mihomo 内核，例如 Clash Verge、FlClash 或 Clash Meta。

## 快速开始

```bash
git clone https://github.com/zht7063/quick-sing-box-node.git /opt/sing-box
cd /opt/sing-box
SING_BOX_VERSION=latest bash scripts/gen-keys.sh
bash scripts/gen-config.sh
bash scripts/conf-clash.sh
bash scripts/start.sh
```

`SING_BOX_VERSION` 只决定 `gen-keys.sh` 用哪个镜像生成密钥。运行中的容器始终使用 `compose.yaml` 里的 `ghcr.io/sagernet/sing-box:latest`。

| 脚本 | 行为 | 产出 |
| --- | --- | --- |
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
