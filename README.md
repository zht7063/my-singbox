**English** | [简体中文](README_CN.md)

# My sing-box

Shadowsocks 2022 and VLESS-Reality-Vision nodes with sing-box in Docker; exports `clash.yaml` for Mihomo clients.

Supported: Debian/Ubuntu VPS, x64 or arm64.

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/zht7063/my-singbox/ts-version/install.sh
sh install.sh && export PATH="$HOME/.local/node/bin:$PATH"
```

The installer installs Node >= 22 to `~/.local/node` without sudo; it skips installation if Node >= 22 is already on PATH.

## Usage

Requirements: Node >= 22, Docker with the Compose plugin, access to the Docker socket, and optionally `ss` for the UDP check.

### init

In a writable deployment directory, such as `/opt/sing-box`, run:

```bash
npx my-singbox init
```

`init` runs doctor, copies `compose.yaml` if missing, generates missing credentials and configs, starts sing-box, checks it, and prints firewall and client import instructions. It keeps existing files on re-run and never uses sudo.

### start

```bash
npx my-singbox start
```

`start` runs Docker Compose and checks that the container stays running, its config passes `sing-box check`, and configured TCP ports accept local connections. It also checks UDP 8388 with `ss` when available and prints container logs on self-check failure.

### isp-outbound

```bash
npx my-singbox isp-outbound --add
npx my-singbox isp-outbound --remove
```

Add an ISP SOCKS5 outbound (it asks for the proxy address and credentials) or remove it. Without an action, the command shows a menu; `--yes` or `-y` skips restart confirmation, and `--help` shows options. Add creates `shadowsocks-isp` on 13839 TCP/UDP and `vless-reality-isp` on 18444 TCP, adding them to `clash.yaml` when it exists. Re-import it in the client. The command saves backups in `.isp-backup`; removal restores a pre-ISP backup, so later edits to managed files are not retained in the restored files. It does not change firewall rules.

### doctor

```bash
npx my-singbox doctor
```

Read-only checks for Node version, Linux and libc, architecture, Docker Compose, and Docker socket access. `OK`, `WARN`, and `FAIL` describe each result; failures produce a nonzero exit status.

| Command | Purpose |
| --- | --- |
| `init` | Prepare missing files and start sing-box. |
| `gen-keys` | Generate credentials; requires `SING_BOX_VERSION`. |
| `gen-config` | Generate the server config. |
| `conf-clash` | Generate the client config. |
| `start` | Start sing-box and run self-checks. |
| `isp-outbound` | Add or remove the ISP outbound. |
| `doctor` | Check prerequisites. |

Use `npx my-singbox --help` or `-h` for command help. For manual setup, copy `compose.yaml` into the deployment directory and run:

```bash
SING_BOX_VERSION=v1.14.4 npx my-singbox gen-keys
npx my-singbox gen-config
npx my-singbox conf-clash
npx my-singbox start
```

## Firewall and ports

Open 8388/tcp, 8388/udp, and 8443/tcp in the local firewall and cloud security group. For ISP outbound, also open 13839/tcp, 13839/udp, and 18444/tcp. The tool never changes firewall rules.

## Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in, or run `newgrp docker`. Docker group membership is equivalent to root access.

## Unsupported systems

`install.sh` and doctor require Linux, glibc >= 2.28, and x64 or arm64. CentOS 7 (glibc < 2.28), Alpine/musl, and other CPU architectures exit with an error. See [shell version v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0).

## Files and config

The deployment directory contains `compose.yaml`, `.env` (credentials), `config.json` (server config), and `clash.yaml` (client config). Compose uses host networking and pins `ghcr.io/sagernet/sing-box:v1.14.4`; the default ports are 8388 TCP/UDP and 8443 TCP. Import `clash.yaml` into a Mihomo-based client such as Clash Verge, FlClash, or Clash Meta.

Generated `.env`, `config.json`, and `clash.yaml` files use mode 600. They contain credentials: never commit them. The REALITY private key is not written to `clash.yaml`.

## Troubleshooting

- If the pinned image fails, change its tag in `compose.yaml` and run `docker compose up -d`.
- To regenerate keys, delete `.env`, `config.json`, and `clash.yaml`, then rerun `npx my-singbox init`.
- Run `npx my-singbox doctor` and address any `FAIL` results; `WARN` indicates a warning, such as legacy Compose.
- If ports are unreachable, check the local firewall and cloud security group.
- To stop and remove the deployment, run `docker compose down` in the deployment directory.

## Legacy shell version (v1.1.0)

See [v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0) and the [shell-version branch](https://github.com/zht7063/my-singbox/tree/shell-version).

## For agents

See [deploy-sing-box-node](skills/deploy-sing-box-node/SKILL.md).
