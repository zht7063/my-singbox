[English](README.md) | **简体中文**

# My sing-box

使用 Docker 中的 sing-box 部署 Shadowsocks 2022 和 VLESS-Reality-Vision 节点，并导出供 Mihomo 客户端使用的 `clash.yaml`。

支持：仅限 Debian 和 Ubuntu VPS，x64 或 arm64。

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/zht7063/my-singbox/ts-version/install.sh
sh install.sh && export PATH="$HOME/.local/node/bin:$PATH"
```

安装程序无需 sudo，将 Node >= 22 安装到 `~/.local/node`；如果 PATH 中已有 Node >= 22，则跳过安装。

> **npm 包 `my-singbox` 尚未发布，目前 `npx my-singbox ...` 无法使用。** 下文示例写作 `npx my-singbox <cmd>`。包发布之前，请改用下面任一方式（均已验证）：
>
> ```bash
> # A) 从本仓库的检出目录运行
> git clone --branch ts-version https://github.com/zht7063/my-singbox.git && cd my-singbox
> npm ci && npm run build
> node dist/cli.js doctor   # 代替 "npx my-singbox doctor"
>
> # B) 安装打包后的 tarball
> npm pack
> npm install -g ./my-singbox-*.tgz   # 之后运行 "my-singbox <cmd>"
> ```
>
> 请在部署目录（例如 `/opt/sing-box`）中运行命令。方式 A 请使用绝对路径：`node /path/to/my-singbox/dist/cli.js <cmd>`。

## 使用

要求：Node >= 22、Docker 及 Compose 插件、Docker socket 访问权限；UDP 检查可选用 `ss`。

### init

在可写的部署目录中（例如 `/opt/sing-box`）运行：

```bash
npx my-singbox init
```

`init` 运行 doctor，复制缺失的 `compose.yaml`，生成缺失的凭据和配置，启动并检查 sing-box，然后输出防火墙和客户端导入说明。重复运行时保留已有文件，且不会使用 sudo。

### start

```bash
npx my-singbox start
```

`start` 运行 Docker Compose，检查容器是否持续运行、配置是否通过 `sing-box check`，以及配置的 TCP 端口是否接受本地连接。如果有 `ss`，还会检查 UDP 8388；自检失败时会输出容器日志。

### isp-outbound

```bash
npx my-singbox isp-outbound --add
npx my-singbox isp-outbound --remove
```

添加 ISP SOCKS5 出站（会询问代理地址和凭据）或移除它。不指定操作时显示菜单；`--yes` 或 `-y` 跳过重启确认，`--help` 显示选项。添加操作创建 13839 TCP/UDP 上的 `shadowsocks-isp` 和 18444 TCP 上的 `vless-reality-isp`，并在 `clash.yaml` 存在时加入其中。请在客户端重新导入该文件。命令将备份保存到 `.isp-backup`；移除时恢复添加 ISP 前的备份，因此受管理文件在此之后的修改不会保留在恢复后的文件中。命令不会修改防火墙规则。

### doctor

```bash
npx my-singbox doctor
```

只读检查 Node 版本、Linux 和 libc、架构、Docker Compose 及 Docker socket 访问权限。每项结果显示 `OK`、`WARN` 或 `FAIL`；存在失败项时返回非零退出状态。

| 命令 | 用途 |
| --- | --- |
| `init` | 准备缺失的文件并启动 sing-box。 |
| `gen-keys` | 生成 `.env` 凭据；单独运行时需要在环境中设置 `SING_BOX_VERSION`（镜像标签）。 |
| `gen-config` | 生成服务端配置。 |
| `conf-clash` | 生成客户端配置。 |
| `start` | 启动 sing-box 并执行自检。 |
| `isp-outbound` | 添加或移除 ISP 出站。 |
| `doctor` | 检查运行条件。 |

使用 `npx my-singbox --help` 或 `-h` 查看命令帮助。手动设置时，先把 `compose.yaml` 复制到部署目录，然后运行：

```bash
SING_BOX_VERSION=v1.14.4 npx my-singbox gen-keys
npx my-singbox gen-config
npx my-singbox conf-clash
npx my-singbox start
```

## 防火墙和端口

在本机防火墙和云安全组中开放 8388/tcp、8388/udp 和 8443/tcp。使用 ISP 出站时，还需开放 13839/tcp、13839/udp 和 18444/tcp。工具不会修改防火墙规则。

## 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

退出并重新登录，或运行 `newgrp docker`。Docker 组成员权限等同于 root。

## 不支持的系统

仅支持 Debian 和 Ubuntu；其他发行版均不受支持。`install.sh` 和 doctor 在 Alpine/musl、glibc 低于 2.28 以及 x64、arm64 以外的 CPU 架构上也会报错退出。请改用 [shell 版本 v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0)（分支 [`shell-version`](https://github.com/zht7063/my-singbox/tree/shell-version)）。

## 文件和配置

部署目录包含 `compose.yaml`、`.env`（凭据）、`config.json`（服务端配置）和 `clash.yaml`（客户端配置）。Compose 使用宿主机网络，镜像固定为 `ghcr.io/sagernet/sing-box:v1.14.4`；默认端口为 8388 TCP/UDP 和 8443 TCP。将 `clash.yaml` 导入基于 Mihomo 的客户端，例如 Clash Verge、FlClash 或 Clash Meta。

生成的 `.env`、`config.json` 和 `clash.yaml` 文件权限为 600。这些文件包含凭据，切勿提交到版本库。REALITY 私钥不会写入 `clash.yaml`。

## 故障排查

- 如果固定版本的镜像无法使用，请修改 `compose.yaml` 中的标签并运行 `docker compose up -d`。
- 如需重新生成密钥，删除 `.env`、`config.json` 和 `clash.yaml`，然后重新运行 `npx my-singbox init`。
- 运行 `npx my-singbox doctor` 并处理所有 `FAIL` 项；`WARN` 表示警告，例如使用旧版 Compose。
- 如果端口无法访问，请检查本机防火墙和云安全组。
- 如需停止并移除部署，在部署目录中运行 `docker compose down`。

## 旧版 shell（v1.1.0）

参见 [v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0) 和 [shell-version 分支](https://github.com/zht7063/my-singbox/tree/shell-version)。

## 给 agent

参见 [deploy-sing-box-node](skills/deploy-sing-box-node/SKILL.md)。
