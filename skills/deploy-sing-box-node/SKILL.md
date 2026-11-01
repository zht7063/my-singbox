---
name: deploy-sing-box-node
description: 'Deploys this repository''s sing-box node on a Linux server at /opt/sing-box by running its scripts, then hands the exported clash.yaml to a mihomo client. Applies when the user asks to install, deploy, start, verify, roll back, or uninstall this node; to open 8388/tcp, 8388/udp, or 8443/tcp; to pin or roll back the sing-box image; to change the Reality SNI; or to produce a mihomo profile from this repo, even if they never say "skill". Does not apply when the task is to reconfigure a sing-box install this repository did not create.'
---

# Deploy this sing-box node

The scripts do the work. Stay inside `/opt/sing-box/` and do not invent a second install path, a systemd unit, or extra config files elsewhere on the system.

## Prerequisites

- Linux server with root or sudo.
- Docker, the Docker Compose plugin (`docker compose version`), openssl, and curl or wget. On Debian/Ubuntu, run `sudo bash scripts/init.sh` first. It installs missing non-Docker packages only. `docker info` must succeed before key generation.
- Ports free on the host, and open in the host firewall and the cloud security group: `8388/tcp`, `8388/udp`, `8443/tcp`.
- An interactive terminal only if public IP detection fails.

## Leave other sing-box installs alone

If the server already runs sing-box from anything other than this repo, stop. Read that install's `config.json` and do not write to it, restart it, or remove it.

Match a client to that file:

- Copy listen ports, UUIDs, Reality public key, short ID, server name, and Shadowsocks method and password only as they appear in the server file.
- Set `flow: xtls-rprx-vision` on the client only when that server user already sets `flow`.
- Do not derive or change the server private key.

This repo's install is the git checkout at `/opt/sing-box/` whose `compose.yaml` is the one from this repo. If that directory already has `.env`, `config.json`, or `clash.yaml`, the matching script refuses to overwrite. Leave those files in place and run only the scripts whose outputs are missing.

## Install

```bash
git clone https://github.com/zht7063/my-singbox.git /opt/sing-box
cd /opt/sing-box
```

Generated files stay in this directory, next to `compose.yaml`. Do not copy them to `/etc`, `/usr/local`, or a home directory.

Run, from `/opt/sing-box`:

```bash
sudo bash scripts/init.sh
SING_BOX_VERSION=latest bash scripts/gen-keys.sh
bash scripts/gen-config.sh
bash scripts/conf-clash.sh
bash scripts/start.sh
```

| Script | Asks | Writes |
| --- | --- | --- |
| `scripts/init.sh` | Root on Debian or Ubuntu (`sudo bash scripts/init.sh`). Installs missing apt packages other than Docker. Does not change SSH, the firewall, users, or passwords. | No project files. Prints which tools are present, and warns when docker or Compose is missing. |
| `scripts/gen-keys.sh` | Requires `SING_BOX_VERSION`. Checks `docker` and `openssl`, then `docker info`. Detects the public IP with curl or wget, preferring IPv4 and then IPv6. Prompts `Public IP address of this machine:` only when detection fails, and repeats until the address is a public IP. Private, loopback, and reserved addresses are rejected. | `.env` (mode `600`): image tag, VLESS UUID, Reality private and public keys, Reality short ID, Shadowsocks 2022 password, `SERVER_ADDRESS`. |
| `scripts/gen-config.sh` | Nothing. Requires `.env` and `templates/config.json.template`. | `config.json` (mode `600`). Server inbound only. It does not embed `REALITY_PUBLIC_KEY` or `SERVER_ADDRESS`. |
| `scripts/conf-clash.sh` | Nothing. Loads `templates/.env.template`, then `.env` overrides it. | `clash.yaml` (mode `600`) for mihomo. The Reality private key is refused. Rules are copied from the template. |
| `scripts/start.sh` | Nothing. Requires `compose.yaml`, `config.json`, the Compose plugin, and a running daemon. | Runs `docker compose up -d`, waits until container `sing-box` stays up, runs `sing-box check` inside it, checks each `listen_port` on `127.0.0.1`, and checks UDP `8388` with `ss -uln` when `ss` exists. Missing `ss` is a warning, not a failure. Prints `Self-check passed. Ports: ...` |

`compose.yaml` uses `network_mode: host` and the image `ghcr.io/sagernet/sing-box:latest`. It does not read `SING_BOX_VERSION`.

## Image

Use `sing-box:latest` by default (`SING_BOX_VERSION=latest` and the image line already in `compose.yaml`).

If that image fails to start or fails `sing-box check`, pin the image and stop there. In `/opt/sing-box/compose.yaml` set:

```yaml
image: ghcr.io/sagernet/sing-box:1.14.4
```

Then run `docker compose up -d` again from `/opt/sing-box`. If key generation itself failed on `latest`, delete only this repo's generated `.env`, `config.json`, and `clash.yaml`, and rerun `gen-keys.sh`, `gen-config.sh`, `conf-clash.sh`, and `start.sh` with `SING_BOX_VERSION=1.14.4`. Do not edit the scripts.

## Reality SNI

The default is `www.microsoft.com` (`server_name`, the Reality handshake server, and the client `servername`).

If a real client connection fails, change those three fields together and restart. Do not change anything under `rules:` or `rule-providers:` in the template or in `clash.yaml`. Try `www.intel.com`, then `www.nvidia.com`. Keep the server name and the client `servername` identical.

## Client

Hand over `/opt/sing-box/clash.yaml`. The mihomo client selects `shadowsocks` by default and can switch to `vless-reality`. Both are under the `select` group `Proxy`. (They were previously named `My-sing-box`, `My-VLESS-Reality` and `PROXY`; clients holding an old `clash.yaml` must re-import a regenerated one.)

Do not edit the clash template's rules. Do not add `url-test`, `fallback`, `load-balance`, or any other automatic speed-test selection.

## ISP outbound (optional)

Do not run `scripts/isp-outbound.sh` as part of a normal deployment. Run it only when the user explicitly asks for an ISP/static SOCKS5 egress and supplies the proxy address, username and password. It needs root, restarts the container, opens firewall ports and edits `config.json`, `.env` and `clash.yaml` (backups go to `.isp-backup/`). It never touches SSH. Never print the proxy password. After it succeeds, tell the user to open `13839/tcp`, `13839/udp` and `18444/tcp` in the cloud security group and to re-import `clash.yaml` (new group `Proxy-ISP`). If it exits non-zero after printing a firewall hint on stderr, the service is healthy and was deliberately not rolled back; relay the hint (ports, backend, commands, security group, re-run `--add`). The egress check contacts only api.ipify.org, ipinfo.io, icanhazip.com and ifconfig.me through the proxy. `--remove` undoes it.

## Verify

1. `bash scripts/start.sh` prints `Self-check passed`.
2. From a machine other than the server, check the public IP: `8388/tcp`, `8388/udp`, and `8443/tcp`. A successful localhost check is not this step.
3. Domestic direct-connection is a mihomo-core check. Terminal commands stay off the mihomo listen port: do not `curl -x` that port and do not export `http_proxy`, `https_proxy`, or `all_proxy` to it. Verify in a browser by following the `vercel-labs/agent-browser` skill. Open a destination the exported rules send `DIRECT` and confirm it loads.

## SSH

Never modify SSH configuration. That includes `sshd_config`, `authorized_keys`, passwords, and user accounts. Opening 8388 and 8443 does not involve SSH.

## Rollback

From the install directory only:

```bash
cd /opt/sing-box
docker compose down
```

This stops and removes this repo's container. It does not delete the checkout. Do not run it against a sing-box install that this repo did not create.
