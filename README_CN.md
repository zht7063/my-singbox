[English](README.md) | **简体中文**

# My sing-box

使用 Docker 中的 sing-box 部署 Shadowsocks 2022 和 VLESS-Reality-Vision 节点，并导出供 Mihomo 客户端使用的 `clash.yaml`。

支持：仅限 Debian 和 Ubuntu VPS，x64 或 arm64。

3.0.0 调整了 ISP 路由方式及库 API。升级已有部署前，请阅读[不兼容变更与迁移步骤](CHANGELOG.md)。

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/zht7063/my-singbox/ts-version/install.sh
sh install.sh && export PATH="$HOME/.local/node/bin:$PATH"
```

安装程序无需 sudo，将 Node >= 22 安装到 `~/.local/node`；如果 PATH 中已有 Node >= 22，则跳过安装。

从 npm 安装命令行工具：

```bash
npm i -g my-singbox   # 之后运行 "my-singbox <cmd>"
```

也可以无需安装直接运行：`npx my-singbox <cmd>`。下文示例写作 `npx my-singbox <cmd>`；全局安装后可省略 `npx`。请在部署目录（例如 `/opt/sing-box`）中运行命令。

## 使用

要求：Node >= 22、Docker 及 Compose 插件、Docker socket 访问权限；UDP 检查可选用 `ss`。

### tui

在可写的部署目录中打开交互界面：

```bash
npx my-singbox tui
```

TUI 提供运行条件检查、首次部署向导、服务器地址和端口选择，以及 ISP 添加、更新和移除。保存前展示文件和服务变更；执行后分别展示配置、容器检查和失败恢复状态。现有文本命令继续可用。

使用 Tab / Shift+Tab 移动焦点，Enter 激活按钮或跳到下一个字段，Esc 返回，Ctrl+C 退出或请求安全停止。输入框支持 Ctrl+A/E 移至开头/结尾、Ctrl+U/K 删除光标前/后的内容；凭据默认隐藏，Ctrl+R 临时显示当前字段。需要交互式 stdin/stdout，至少 60 列 × 18 行；可用 `NO_COLOR=1` 禁用颜色。

首版允许新部署选择端口，已有部署的端口只读。ISP 校验需要 curl；TUI 不安装软件、不提权、不修改防火墙。当前不支持远程 Docker context。恢复说明和开发验证方法见 [TUI 使用指南](docs/tui.md)。

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

`start` 运行 Docker Compose，检查容器是否持续运行、配置是否通过 `sing-box check`，以及配置的 TCP 端口是否接受本地连接。如果有 `ss`，还会检查实际 Shadowsocks 入站端口的 UDP 监听；自检失败时会输出容器日志。

### isp-outbound

```bash
npx my-singbox isp-outbound --add
npx my-singbox isp-outbound --remove
```

添加或更新 ISP SOCKS5 出站（会询问代理地址和凭据），或移除它。不指定操作时显示菜单；`--yes` 或 `-y` 跳过重启确认，`--help` 显示选项。

Clash 保留现有规则、规则集和 DNS 设置，决定流量由客户端直连还是进入 VPS。服务端 `config.json` 独立决定 VPS 的出口：配置 ISP 时，sing-box 先嗅探流量，将模板中指定的域名交给 `isp-socks`，其余流量默认走 `direct`；未配置 ISP 时省略可选 ISP 规则，默认出口仍为 `direct`。两种模式都只使用两个基础入站及对应客户端节点（默认端口 8388 和 8443），ISP 不新增监听端口或客户端节点。

默认 ISP 域名规则来自 `templates/config.json.template`，配置 ISP 后写入服务端 `config.json`，通过 `domain_suffix` 匹配 `anthropic.com`、`claude.ai`、`claude.com`、`claudeusercontent.com`、`http-intake.logs.us5.datadoghq.com` 和 `browser-intake-us5-datadoghq.com`。这些规则控制服务端出口，不会新增或修改 `clash.yaml` 中的规则，仅对客户端已发送到 VPS 的流量生效。

添加和移除只管理 `config.json` 与 `.env`，备份及失败回滚也仅涉及这两个文件，始终不读写 `clash.yaml`。移除直接修改当前配置，保留无关路由和后续自定义修改，无需添加 ISP 前的备份；更新凭据时保留已有 ISP 路由条件。默认域名、自定义路由顺序和旧配置迁移详见 [ISP 路由与迁移说明](docs/ts/isp-outbound.md)。

### doctor

```bash
npx my-singbox doctor
```

只读检查 Node 版本、Linux 和 libc、架构、Docker Compose 及 Docker socket 访问权限。每项结果显示 `OK`、`WARN` 或 `FAIL`；存在失败项时返回非零退出状态。

| 命令 | 用途 |
| --- | --- |
| `tui` | 打开部署向导、运行条件与 ISP 配置界面。 |
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

默认在本机防火墙和云安全组中开放 8388/tcp、8388/udp 和 8443/tcp。如果在 TUI 中选择自定义端口，请按结果页提示放行实际端口。ISP 出站使用相同的监听端口。工具不会修改防火墙规则。

文本流程可在生成配置前向 `.env` 添加可选的 `SS_PORT=18388` 和 `VLESS_PORT=18443`。缺失时使用默认值；空值、非法值或重复端口会报错。修改 `.env` 不会自动更新已有的服务端或客户端文件，生成器仍拒绝覆盖。

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

参见 [v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0) 和 [shell-version 分支](https://github.com/zht7063/my-singbox/tree/shell-version)。旧版 ISP 流程使用额外的服务端端口及客户端节点；TypeScript CLI 改为独立服务端路由，ISP 行为不再与旧版完全相同。服务端按已知标签迁移旧 ISP 入站。若要替换旧四节点客户端配置，请先备份 `clash.yaml`，将原文件移走，再运行 `npx my-singbox conf-clash` 并重新导入客户端。生成器仍拒绝覆盖已有文件，ISP 命令不会迁移客户端文件。

## 给 agent

参见 [deploy-sing-box-node](skills/deploy-sing-box-node/SKILL.md)。
