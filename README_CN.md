[English](README.md) | **简体中文**

> **已弃用：本 shell 版本（v1.1.0）不再维护。** 新安装请使用 [`ts-version` 分支](https://github.com/zht7063/my-singbox/tree/ts-version)上的 TypeScript 版本，今后只开发该版本。其安装命令：
>
> ```bash
> curl -fsSLo install.sh https://raw.githubusercontent.com/zht7063/my-singbox/ts-version/install.sh
> sh install.sh && export PATH="$HOME/.local/node/bin:$PATH"
> ```
>
> 以下内容保留为 v1.1.0 的参考。

# My sing-box

在 Debian/Ubuntu VPS 上用 Docker 构建基于 sing-box 的 shadowsocks 2022 和 vless-reality-vision 节点，并导出给 Mihomo 使用的 `clash.yaml`。

## 部署内容

- Shadowsocks 2022（`2022-blake3-aes-128-gcm`），端口 `8388`，TCP 和 UDP。
- VLESS + REALITY，`flow` 为 `xtls-rprx-vision`，端口 `8443`，仅 TCP。服务端默认 SNI 为 `www.microsoft.com`。
- 容器镜像 `ghcr.io/sagernet/sing-box:latest`，`network_mode: host`。
- 客户端配置是 `clash.yaml`。节点为 `shadowsocks` 和 `vless-reality`，位于 `select` 组 `Proxy` 下（默认 `shadowsocks`）。

> **从旧版本升级：** 节点原名 `My-sing-box`、`My-VLESS-Reality`，组原名 `PROXY`，现已改名。服务端端口和凭据不变，但已有的 `clash.yaml` 仍是旧名字。要使用新名字，请删除 `clash.yaml`，重新运行 `bash scripts/conf-clash.sh`，并在**每个客户端里重新导入 `clash.yaml`**（名字变了，客户端里保存的节点和分组选择会丢失）。

`8388` 和 `8443` 需要空闲。端口写在 `templates/config.json.template` 和 `templates/clash.yaml.template`。`compose.yaml` 不映射端口。

## 要求

- Debian/Ubuntu。部署目录可写，文件都放在 `/opt/sing-box/`。
- Docker、Docker Compose 插件（`docker compose version`），以及正在运行的 Docker daemon。
- Debian/Ubuntu 先运行 `sudo bash scripts/init.sh`。它只安装缺失的非 Docker 依赖（`ca-certificates`、`curl`、`openssl`、提供 `ss` 的 `iproute2`、`git`、`jq`（`isp-outbound.sh` 要用）；没有 `awk`、`grep` 或 `coreutils` 时也装上），不安装 Docker，也不改 SSH、防火墙、用户或密码。
- openssl、curl（没有 curl 时 `gen-keys.sh` 接受 wget）。检测公网 IP 失败时才需要交互式终端。
- `ss`（`iproute2`）。没有它时 `start.sh` 只警告，并跳过 UDP 检查。
- 防火墙和安全组放行 `8388/tcp`、`8388/udp`、`8443/tcp`。
- 客户端使用 Mihomo 内核，例如 Clash Verge、FlClash 或 Clash Meta。

## 快速开始

```bash
git clone --branch shell-version https://github.com/zht7063/my-singbox.git /opt/sing-box
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
| `scripts/isp-outbound.sh` | 可选，不属于快速开始。`--add` 额外开两个端口（`13839` tcp+udp、`18444` tcp），流量经你的静态 ISP SOCKS5 代理出去，并把节点 `shadowsocks-isp`、`vless-reality-isp` 加入 `Proxy` 组；`--remove` 撤销。需要 `jq` 和 Docker 访问权限，本身不需要 `sudo`，也不碰防火墙：端口需要你自己放行。详见 [可选：ISP 出口](#可选isp-出口静态-socks5)。 | 修改 `config.json`、`.env`、`clash.yaml`；备份在 `.isp-backup/` |

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

## 可选：ISP 出口（静态 SOCKS5）

`scripts/isp-outbound.sh` 是可选脚本。不运行就什么都不变：两个节点仍用 `8388` 和 `8443`，其他脚本也不依赖它。已有静态 ISP SOCKS5 代理、想多开两个出口走该代理（而不是服务器自身 IP）的端口时才用。

```bash
cd /opt/sing-box
bash scripts/isp-outbound.sh            # 菜单：添加 / 移除
bash scripts/isp-outbound.sh --add      # 添加或更新
bash scripts/isp-outbound.sh --remove   # 移除它添加的全部内容
```

本身不需要 `sudo` 或 root，也不安装任何东西。写入任何文件之前，它会先检查两个前提：

- `jq`。`sudo bash scripts/init.sh` 会安装它（或 `sudo apt-get install -y jq`）。缺少时脚本立即停止，提示 `jq is not installed. Run scripts/init.sh (sudo bash scripts/init.sh) or install jq ... Nothing was changed.`
- 能访问 Docker。用 `docker` 组里的用户运行，或用 `sudo`。Docker socket 报 `permission denied` 时立即停止，提示 `permission denied while talking to the Docker daemon ... Nothing was changed.` 并给出两种办法：用 `sudo` 运行，或把当前用户加入该组（`sudo usermod -aG docker "$USER"`，然后退出并重新登录）。项目目录或其中的文件不可写时同样提前停止，并给出对应提示。

脚本不碰防火墙：端口需要你自己放行（以及之后自己关闭），见下文。脚本会询问代理地址（`IPv4:端口` 或 `[IPv6]:端口`）、用户名、密码，以及可选的预期出口 IP。

| 新增 | 端口 | 出口 |
| --- | --- | --- |
| sing-box 入站 `ss-isp-in`（克隆自 `ss-in`，加密方式和密码相同） | `13839` tcp+udp | SOCKS5 代理 |
| sing-box 入站 `vless-reality-isp-in`（克隆自 `vless-reality-in`，UUID 和密钥相同） | `18444` tcp | SOCKS5 代理 |

流量按入站 tag 分流，`8388` 和 `8443` 仍然直连出站。SOCKS5 代理不可用时，ISP 端口会失败，绝不会回退到直连。

`--add` 的顺序如下。重启之前任何一步失败（包括在重启确认处回答 `n`），都不会写入你的任何文件，临时文件也会被删除：

1. 用 SOCKS5 TCP 请求测试代理（凭据通过 stdin 交给 `curl`，不出现在命令行），并把返回的出口 IP 与 `ISP_SOCKS_EGRESS_IP`（设置了的话）比较，否则与代理入口 IP 比较。不一致就停止。请求经代理访问公共 IP 回显服务，依次尝试直到有一个应答：`https://api.ipify.org`、`https://ipinfo.io/ip`、`https://ipv4.icanhazip.com`、`https://ifconfig.me/ip`。这是脚本唯一访问的外部主机；代理凭据只发给代理，不会发给它们。地址、用户名和密码必须合法（用户名和密码必须是合法的 UTF-8），否则在写入任何文件之前就停止。
2. 在临时文件中生成新的 `.env`、`config.json`、`clash.yaml`。`config.json` 用从新 `.env` 读回的值生成，脚本会检查读回的值与你输入的一致。并用容器正在使用的镜像执行 `sing-box check` 校验配置。
3. 把三个文件备份到 `.isp-backup/<时间戳>/`。共保留 5 份备份：最旧的一份（第一次修改之前的原始文件，永远不会被轮转删除）加最新的 4 份。没有任何变化的运行不会产生备份。用新凭据重新添加之后，较旧的备份里仍含旧密码（目录权限 `700`，文件 `600`）。
4. 替换 `config.json`，执行 `docker compose up -d --force-recreate`，确认容器在运行且新端口在监听。失败时恢复三个文件并重新创建容器。如果在 `config.json` 已被替换、服务尚未验证通过之前中断脚本（`Ctrl-C`、`SIGTERM`、`SIGHUP`），同样会执行这个回滚。若 `config.json` 已含 ISP 出口但服务没有在运行它，脚本会重启 sing-box 一次并再次检查；仍不健康就以非零状态退出，不会报告成功，也不会改动其他任何东西（`.env` 和 `clash.yaml` 都不碰）。
5. 写入 `.env` 和 `clash.yaml`，并打印下面的端口提示。

用相同的值连续执行两次 `--add`，结果不变（也不会产生新备份）。`--add` 之后再 `--remove`，对于本项目生成格式的文件，`config.json`、`.env`、`clash.yaml` 逐字节恢复；`.env` 或 `clash.yaml` 末尾没有换行时也会原样恢复（脚本会留一条标记注释用来还原）。`config.json` 由 `jq` 重新序列化，你手工改过的格式会被规范化。`--remove` 还会删除 `.env` 中所有 `ISP_SOCKS_*` 键，包括你自己手写的。

### 移除

```bash
bash scripts/isp-outbound.sh --remove
```

`--remove` 会撤销 `--add` 做的全部修改：

- `config.json`：删除两个 ISP 入站、`isp-socks` 出站及其路由规则，并重启 sing-box（会先询问，sing-box 没有起来时会回滚）。
- `.env`：删除 `ISP_SOCKS_*` 键。
- `clash.yaml`：从 `proxies` 和 `Proxy` 组中删除 `shadowsocks-isp`、`vless-reality-isp`，文件逐字节恢复。请在客户端重新导入。
- 修改之前会先备份（`.isp-backup/`）。如果本来就没有配置过，会提示并且不改动任何东西。

本身不需要 `sudo` 或 root，也不碰防火墙。它会打印提示：`13839/tcp`、`13839/udp`、`18444/tcp` 不再使用，可以自己关闭（本机防火墙和云安全组两处）。

### 自己放行端口

`--add` 成功后脚本不会开放任何端口，只会打印下面的提示（脚本输出为英文）。意思是：你必须自己放行 `13839/tcp`、`13839/udp`、`18444/tcp`，本机防火墙和云厂商的安全组两处都要放行：

```text
ACTION REQUIRED: allow these ports yourself. This script does not open any port.
  13839/tcp  (ss-isp-in, Shadowsocks)
  13839/udp  (ss-isp-in, Shadowsocks)
  18444/tcp  (vless-reality-isp-in, VLESS Reality)
Allow them in BOTH places, otherwise the new ports are not reachable from outside:
  1. the local firewall on this server, if you run one (ufw, firewalld or iptables);
  2. your cloud provider's security group (or network ACL) for this server.
Ports 8388 and 8443 are not affected.
```

之后是供参考的示例命令：

```text
ufw（规则本身已持久化）：  ufw allow 13839/tcp ; ufw allow 13839/udp ; ufw allow 18444/tcp
firewalld：  firewall-cmd --permanent --add-port=13839/tcp（以及 13839/udp、18444/tcp）；firewall-cmd --reload
iptables：   iptables -I INPUT -p tcp --dport 13839 -j ACCEPT（以及 udp 13839、tcp 18444）
             然后：netfilter-persistent save   （或：iptables-save > /etc/iptables/rules.v4）
             （缺少时先安装 iptables-persistent）
```

`--remove` 之后会打印对应的提示：这些端口不再使用，可以自己关闭（本机防火墙和云安全组两处），并附 `ufw delete allow`、`firewall-cmd --permanent --remove-port` 加 `--reload`、`iptables -D` 命令。每次成功的 `--add` 和 `--remove` 都会打印提示（没有任何变化时也会），失败或回滚之后不会打印。

关于这些示例命令的两点说明：

- 按端口关闭 `ufw` 或 `firewalld` 规则时，也会删掉你自己为同一端口放行的规则。
- `netfilter-persistent save`（以及 `iptables-save`）保存的是当前**整个** iptables 规则集，不只是这几条规则，其中包括 Docker、fail2ban 等其他工具添加的规则。

说明：

- `.env` 增加四个可选键：`ISP_SOCKS_ADDR`、`ISP_SOCKS_USER`、`ISP_SOCKS_PASS`、`ISP_SOCKS_EGRESS_IP`。和 `.env` 里的其他值一样以明文存储，`.env` 权限保持 `600`。用户名和密码用双引号包住，里面的反斜杠写成 `\\`，双引号写成 `\"`，美元符号写成 `$$`，这样任何值都只占一行，Docker Compose（它也会读取 `.env`）不会对它做变量替换，也不会解析失败。手写的不带引号的值按原样读取。密码不会被打印、写入日志或出现在命令行。
- `clash.yaml` 新增两个节点 `shadowsocks-isp`、`vless-reality-isp`，追加到 `proxies` 列表末尾，并把这两个名字加到已有 `Proxy` 组的末尾，不创建新的组。新增内容位于 `# BEGIN my-singbox-isp` 和 `# END my-singbox-isp` 标记之间，`--remove` 恰好删掉这些行。所有规则不变，不在客户端里选择 ISP 节点就不会有流量走它们。**之后请在客户端重新导入 `clash.yaml`。** `templates/clash.yaml.template` 不会被修改。
- 脚本只按当前名称 `shadowsocks`、`vless-reality` 查找源节点，并按名称和 `proxies:` 列表查找 `Proxy` 组。如果 `clash.yaml` 是改名之前生成的，或结构已不是这样，会提示并停止；删除 `clash.yaml` 后重新运行 `scripts/conf-clash.sh`。
- 只测试 TCP 出口：脚本只用 TCP 请求检查代理，没有测试 UDP 出口。`13839` 上的 Shadowsocks UDP 能否使用取决于你的 ISP 提供的 SOCKS5 代理：只有代理支持 UDP ASSOCIATE 才行。自己试过之前不要依赖它。
- 同一时间只能运行一次（锁文件 `.isp.lock`）。运行时文件 `.isp-backup/`、`.isp.lock`、`.isp-tmp.*` 已写入 `.gitignore`。`.isp-tmp.*` 可能含密码；脚本结束时会删除它们，被强杀的运行留下的残留会在下次运行开始时清掉。

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
