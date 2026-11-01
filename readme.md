# Quick Sing-box Node

在 Linux 服务器上生成 sing-box 节点配置，并导出给 Mihomo 内核客户端使用的 `clash.yaml`。节点提供两条入站：

- Shadowsocks 2022（`2022-blake3-aes-128-gcm`），端口 `8388`
- VLESS + REALITY，端口 `8443`

请确保端口空闲或提前在 `compose.yaml` 中修改端口。

## 要求

- Linux 服务器。`compose.yaml` 使用 `network_mode: host`。
- Docker、Docker Compose 插件、openssl，以及可用的交互式终端。
- 客户端使用 Mihomo 内核，例如 Clash Verge、FlClash 或 Clash Meta。

## 部署

把仓库放在 `/opt/sing-box/`。所有文件都在这个目录里，和 `compose.yaml` 放在一起。例如：

```bash
git clone https://github.com/zht7063/quick-sing-box-node.git /opt/sing-box
cd /opt/sing-box
SING_BOX_VERSION=latest bash scripts/gen-keys.sh
bash scripts/gen-config.sh
bash scripts/conf-clash.sh
bash scripts/start.sh
```

`SING_BOX_VERSION` 是生成密钥时使用的 `ghcr.io/sagernet/sing-box` 镜像标签。`scripts/gen-keys.sh` 会询问本机公网 IP，并把它写入 `.env` 的 `SERVER_ADDRESS`。私网地址、回环地址和保留地址需要重新输入。

| 脚本 | 作用 | 产出 |
| --- | --- | --- |
| `scripts/gen-keys.sh` | 生成密钥和公网地址 | `.env` |
| `scripts/gen-config.sh` | 渲染服务端配置 | `config.json` |
| `scripts/conf-clash.sh` | 渲染客户端配置 | `clash.yaml` |
| `scripts/start.sh` | 启动容器并自检 | 运行中的 sing-box |

`scripts/start.sh` 会执行 `docker compose up -d`，确认容器保持运行，在容器内执行 `sing-box check`，并检查本机 `8388` 和 `8443` 是否接受连接。把生成的 `clash.yaml` 导入客户端即可。客户端默认使用 `My-sing-box`，也可以切换到 `My-VLESS-Reality`。

这三个产出文件已存在时，对应脚本会拒绝覆盖。需要重新生成时，先删除对应文件。`.env`、`config.json` 和 `clash.yaml` 都包含节点凭据。

`compose.yaml` 固定使用 `ghcr.io/sagernet/sing-box:latest`，不会读取 `.env` 中的 `SING_BOX_VERSION`。服务器需要放行 `8388` 和 `8443`，客户端才能连上。
