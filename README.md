**English** | [简体中文](README_CN.md)

# My sing-box

Shadowsocks 2022 and VLESS-Reality-Vision nodes with sing-box in Docker; exports `clash.yaml` for Mihomo clients.

Supported: Debian and Ubuntu VPS only, x64 or arm64.

Version 3.0.0 changes ISP routing and the library API. See the [breaking changes and upgrade steps](CHANGELOG.md) before upgrading an existing deployment.

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/zht7063/my-singbox/ts-version/install.sh
sh install.sh && export PATH="$HOME/.local/node/bin:$PATH"
```

The installer installs Node >= 22 to `~/.local/node` without sudo; it skips installation if Node >= 22 is already on PATH.

Install the CLI from npm:

```bash
npm i -g my-singbox   # then run "my-singbox <cmd>"
```

Or run it without installing: `npx my-singbox <cmd>`. Examples below use `npx my-singbox <cmd>`; after a global install, drop `npx`. Run commands from the deployment directory (for example `/opt/sing-box`).

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

Add or update an ISP SOCKS5 outbound (the command asks for its address and credentials), or remove it. Without an action, the command shows a menu; `--yes` or `-y` skips restart confirmation, and `--help` shows options.

Clash keeps its existing rules, rule providers, and DNS settings: it chooses whether traffic goes directly from the client or enters the VPS. The server's `config.json` independently chooses the VPS's outbound. With ISP configured, sing-box sniffs traffic, sends the template's selected domains through `isp-socks`, and sends other traffic through `direct`. Without ISP, the optional ISP rules are omitted and the final outbound remains `direct`. Both modes use the same two base inbounds and client nodes on ports 8388 and 8443; ISP adds no listening ports or client nodes.

The default ISP domain rule comes from `templates/config.json.template` and is written to the server's `config.json` when ISP is configured. It matches `anthropic.com`, `claude.ai`, `claude.com`, `claudeusercontent.com`, `http-intake.logs.us5.datadoghq.com`, and `browser-intake-us5-datadoghq.com` using `domain_suffix`. These are server egress rules; they do not add or change rules in `clash.yaml` and apply only to traffic the client sends to the VPS.

Add and remove manage only `config.json` and `.env`, including backups and failure rollback; they never read or write `clash.yaml`. Removal edits the current config, preserving unrelated routes and later customizations, and does not require a pre-ISP backup. Existing ISP route conditions are preserved when updating credentials. See [ISP routing and migration](docs/ts/isp-outbound.md) for the default domains, custom route ordering, and legacy configuration migration.

### doctor

```bash
npx my-singbox doctor
```

Read-only checks for Node version, Linux and libc, architecture, Docker Compose, and Docker socket access. `OK`, `WARN`, and `FAIL` describe each result; failures produce a nonzero exit status.

| Command | Purpose |
| --- | --- |
| `init` | Prepare missing files and start sing-box. |
| `gen-keys` | Generate `.env` credentials; needs `SING_BOX_VERSION` (image tag) set in the environment when run on its own. |
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

Open 8388/tcp, 8388/udp, and 8443/tcp in the local firewall and cloud security group. ISP outbound uses these same listening ports. The tool never changes firewall rules.

## Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in, or run `newgrp docker`. Docker group membership is equivalent to root access.

## Unsupported systems

Only Debian and Ubuntu are supported; all other distributions are unsupported. `install.sh` and doctor also exit with an error on Alpine/musl, on glibc older than 2.28, and on CPU architectures other than x64 and arm64. Use the [shell version v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0) (branch [`shell-version`](https://github.com/zht7063/my-singbox/tree/shell-version)) instead.

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

See [v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0) and the [shell-version branch](https://github.com/zht7063/my-singbox/tree/shell-version). Its ISP workflow uses extra server ports and client nodes; the TypeScript CLI uses independent server routing instead and does not provide the same ISP behavior. Known legacy ISP server inbounds are migrated by their labels. To replace an old four-node client configuration, back up `clash.yaml`, move it aside, run `npx my-singbox conf-clash`, and re-import the generated file. Generation continues to refuse overwriting an existing file; ISP commands do not migrate the client file.

## For agents

See [deploy-sing-box-node](skills/deploy-sing-box-node/SKILL.md).
