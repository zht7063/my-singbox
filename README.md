**English** | [简体中文](README_CN.md)

# My sing-box

Build sing-box based Shadowsocks 2022 and VLESS-Reality-Vision nodes with Docker on a Linux VPS, and export a `clash.yaml` for Mihomo.

## What gets deployed

- Shadowsocks 2022 (`2022-blake3-aes-128-gcm`), port `8388`, TCP and UDP.
- VLESS + REALITY, with `flow` set to `xtls-rprx-vision`, port `8443`, TCP only. The server's default SNI is `www.microsoft.com`.
- Container image `ghcr.io/sagernet/sing-box:v1.14.4` (pinned), with `network_mode: host`.
- The client config is `clash.yaml`. The nodes are `shadowsocks` and `vless-reality`, both in the `select` group `Proxy` (default: `shadowsocks`).

> **Upgrading from an older version:** the nodes were previously named `My-sing-box` and `My-VLESS-Reality`, and the group `PROXY`. They were renamed. Server ports and credentials are unchanged, but an existing `clash.yaml` keeps the old names. To get the new names, delete `clash.yaml`, run `npx my-singbox conf-clash` again, and **re-import `clash.yaml` in every client** (a client's saved node and group selection is lost when names change).

Ports `8388` and `8443` must be free. The ports are defined in `templates/config.json.template` and `templates/clash.yaml.template`. `compose.yaml` does not map ports.

## Requirements

- Linux x64 or arm64 with glibc >= 2.28, and a deployment directory writable by the current user. Debian/Ubuntu is not required. CentOS 7, Alpine/musl and other architectures are refused with a link to [v1.1.0](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0).
- Node >= 22, Docker with the Compose plugin, a running daemon and access to its socket. See the Docker appendix for Debian/Ubuntu installation. Docker group membership grants root-equivalent access.
- `ss` for the UDP check; without it `start` warns and skips that check. Open `8388/tcp`, `8388/udp`, and `8443/tcp` in the firewall and security group.
- A Mihomo-based client, such as Clash Verge, FlClash or Clash Meta.

If Node >= 22 is missing, run `bash install.sh` from the repository. It uses no sudo and installs Node to `~/.local/node`; add `~/.local/node/bin` to `PATH`. It verifies the tarball against built-in pins for the default version or the official `SHASUMS256.txt` for other versions and aborts on mismatch. The bootstrap requires curl and a SHA-256 utility. Optional overrides are `MY_SINGBOX_NODE_DIR`, `MY_SINGBOX_NODE_VERSION`, `MY_SINGBOX_NODE_MIRROR` and `MY_SINGBOX_FORCE_NODE_INSTALL=1`.

## Quick start

Run the npm package `my-singbox` with npx in a writable deployment directory:

```bash
mkdir -p /opt/sing-box  # create it with appropriate permissions if necessary
cd /opt/sing-box
npx my-singbox init
```

`init` runs doctor checks for Node, platform, architecture, Docker Compose and socket access; copies the packaged `compose.yaml` if absent; runs `gen-keys`, `gen-config`, `conf-clash` and `start`; and prints the ports to open. It defaults `SING_BOX_VERSION` to the compose image tag `v1.14.4` when unset. Existing `.env`, `config.json` and `clash.yaml` are kept, so it can be re-run safely. Unlike v1.1.0's `init.sh`, it does not install apt packages or require root, and never uses sudo. It only prints instructions for root-required operations such as installing Docker or adding a user to the Docker group. Node replaces curl, openssl, jq and git for the TS flow; keys still come from the sing-box Docker image. Public IP detection may prompt if it fails.

For a step-by-step alternative, copy `compose.yaml` from the repository into the deployment directory (or run `init` once) and run:

```bash
SING_BOX_VERSION=v1.14.4 npx my-singbox gen-keys
npx my-singbox gen-config
npx my-singbox conf-clash
npx my-singbox start
```

`SING_BOX_VERSION` selects the image used to generate keys; the running container uses the image in `compose.yaml`, pinned to `v1.14.4` by default. `npx my-singbox doctor` runs the prerequisite checks separately.

| v1.1.0 shell command | TS command (same arguments) |
| --- | --- |
| `scripts/init.sh` | `npx my-singbox init` |
| `scripts/gen-keys.sh` | `npx my-singbox gen-keys` |
| `scripts/gen-config.sh` | `npx my-singbox gen-config` |
| `scripts/conf-clash.sh` | `npx my-singbox conf-clash` |
| `scripts/start.sh` | `npx my-singbox start` |
| `scripts/isp-outbound.sh` | `npx my-singbox isp-outbound` |

### Legacy shell version (v1.1.0)

The shell scripts remain in [`scripts/`](scripts/) as a v1.1.0 reference. For the legacy flow and its prerequisites, see the [v1.1.0 release](https://github.com/zht7063/my-singbox/releases/tag/v1.1.0).

## Verify, roll back, uninstall

`npx my-singbox start` runs `sing-box check` inside the container, checks TCP on `127.0.0.1` for every `listen_port`, and checks UDP on `8388` with `ss -uln`. Without `ss` it only warns and does not fail. On success it prints `Self-check passed. Ports: ...`. This covers the local machine only. For clients to connect, the three ports above must still be open on the public side.

If the pinned image fails to start or `sing-box check` fails, change the tag in `compose.yaml` (default `ghcr.io/sagernet/sing-box:v1.14.4`) to another [released tag](https://github.com/SagerNet/sing-box/releases), then run `docker compose up -d` in the deployment directory. If the keys should also be generated by that version, first delete `.env`, `config.json`, and `clash.yaml`, then run `npx my-singbox init` again: it takes the tag from `compose.yaml`.

Uninstalling only stops the container of this directory. It does not delete the repository:

```bash
cd /opt/sing-box
docker compose down
```

## Optional: ISP outbound (static SOCKS5 egress)

In the TS version, use `npx my-singbox isp-outbound --add|--remove` with the same arguments; this is delivered in phase P3. Until then, use the v1.1.0 shell script.

`scripts/isp-outbound.sh` is optional. Skip it and nothing changes: the two nodes keep using `8388` and `8443`, and no other script depends on it. Use it when you have a static ISP SOCKS5 proxy and want two extra ports whose traffic leaves through that proxy instead of the server's own IP.

```bash
cd /opt/sing-box
bash scripts/isp-outbound.sh            # menu: add / remove
bash scripts/isp-outbound.sh --add      # add or update
bash scripts/isp-outbound.sh --remove   # remove everything it added
```

It needs no `sudo` or root of its own, and it installs nothing. Two things must be in place, and it checks both before it writes anything:

- `jq`. `sudo bash scripts/init.sh` installs it (or `sudo apt-get install -y jq`). If it is missing the script stops with `jq is not installed. Run scripts/init.sh (sudo bash scripts/init.sh) or install jq ... Nothing was changed.`
- Access to Docker. Run it as a user in the `docker` group, or with `sudo`. On `permission denied` on the Docker socket it stops at once with `permission denied while talking to the Docker daemon ... Nothing was changed.` and the two remedies: run the script with `sudo`, or add your user to the group (`sudo usermod -aG docker "$USER"`, then log out and back in). The same early stop, with a matching message, happens when the project directory or one of its files is not writable.

It does not touch the firewall: you open (and later close) the ports yourself, see below. It asks for the proxy address (`IPv4:port` or `[IPv6]:port`), username and password, and an optional expected egress IP.

| Added | Port | Goes out through |
| --- | --- | --- |
| sing-box inbound `ss-isp-in` (clone of `ss-in`, same method and password) | `13839` tcp+udp | the SOCKS5 proxy |
| sing-box inbound `vless-reality-isp-in` (clone of `vless-reality-in`, same UUID and keys) | `18444` tcp | the SOCKS5 proxy |

Traffic is routed by inbound tag, so `8388` and `8443` still go out directly. If the SOCKS5 proxy goes down, the ISP ports fail; they never fall back to a direct connection.

What `--add` does, in this order. If any step before the restart fails (including answering `n` to the restart question), none of your files has been written and the temporary files are deleted again:

1. Tests the proxy with a SOCKS5 TCP request (credentials are passed to `curl` on stdin, never on the command line) and compares the egress IP it reports with `ISP_SOCKS_EGRESS_IP` if you set one, otherwise with the proxy's entry IP. A mismatch stops the run. The request goes through the proxy to public IP echo services, tried in this order until one answers: `https://api.ipify.org`, `https://ipinfo.io/ip`, `https://ipv4.icanhazip.com`, `https://ifconfig.me/ip`. These are the only external hosts the script contacts; the proxy credentials go to the proxy only, never to them. The proxy address, username and password must be valid (the password and username must be valid UTF-8), or the run stops before anything is written.
2. Builds the new `.env`, `config.json` and `clash.yaml` in temporary files. `config.json` is rendered from the values as read back from the new `.env`, and the script checks that they equal what you entered. The config is validated with `sing-box check` using the image your container runs.
3. Backs up all three files to `.isp-backup/<timestamp>/`. Five backups are kept: the oldest one (the files as they were before the first change; it is never rotated away) and the four newest. A run that changes nothing makes no backup. After you re-add with new credentials, the older backups still contain the old password (the directories are `700`, the files `600`).
4. Replaces `config.json`, then `docker compose up -d --force-recreate` and checks that the container is running and the new ports listen. On failure it restores all three files and recreates the container again. The same rollback runs if you interrupt the script (`Ctrl-C`, `SIGTERM`, `SIGHUP`) after `config.json` was replaced and before the service was verified. If `config.json` already has the ISP outbound but the service is not running it, the script restarts sing-box once and checks again; if it is still unhealthy it exits non-zero, never reports success, and changes nothing else (`.env` and `clash.yaml` are not touched).
5. Writes `.env` and `clash.yaml`, and prints the port notice below.

Running `--add` twice with the same values changes nothing (and makes no new backup). `--remove` after `--add` restores `config.json`, `.env` and `clash.yaml` byte for byte for files in the format this project generates, including a `.env` or `clash.yaml` that has no trailing newline (the script leaves a marker comment so it can put that back). `config.json` is re-serialised by `jq`, so formatting you changed by hand in it is normalised. `--remove` also deletes any `ISP_SOCKS_*` keys in `.env`, including ones you wrote yourself.

### Remove it

```bash
bash scripts/isp-outbound.sh --remove
```

`--remove` undoes everything `--add` did:

- `config.json`: the two ISP inbounds, the `isp-socks` outbound and its route rule are deleted, and sing-box is restarted (it asks first, and it rolls back if sing-box does not come up).
- `.env`: the `ISP_SOCKS_*` keys are deleted.
- `clash.yaml`: the `shadowsocks-isp` and `vless-reality-isp` nodes are deleted from `proxies` and from the `Proxy` group, so the file is restored byte for byte. Re-import it in your clients.
- A backup is made first (`.isp-backup/`). If nothing was configured it says so and changes nothing.

It needs no `sudo` or root of its own and does not touch the firewall. It prints a note that `13839/tcp`, `13839/udp` and `18444/tcp` are no longer used and that you can close them yourself, in the local firewall and in the cloud security group.

### Open the ports yourself

After a successful `--add` the script prints this notice (and it does not open anything):

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

followed by example commands for reference:

```text
ufw (rules are persistent already):  ufw allow 13839/tcp ; ufw allow 13839/udp ; ufw allow 18444/tcp
firewalld:  firewall-cmd --permanent --add-port=13839/tcp (and 13839/udp, 18444/tcp) ; firewall-cmd --reload
iptables:   iptables -I INPUT -p tcp --dport 13839 -j ACCEPT (and udp 13839, tcp 18444)
            then: netfilter-persistent save   (or: iptables-save > /etc/iptables/rules.v4)
            (install iptables-persistent first if it is missing)
```

After `--remove` it prints the matching note that the ports are no longer used and you can close them yourself (in both places), with `ufw delete allow`, `firewall-cmd --permanent --remove-port` plus `--reload`, and `iptables -D` commands. The notices are printed on every successful `--add` and `--remove` (also when nothing changed), never after a failure or rollback.

Two caveats about those example commands:

- Closing a `ufw` or `firewalld` rule by port also removes a rule you opened yourself for the same port.
- `netfilter-persistent save` (and `iptables-save`) saves the whole current iptables ruleset, not only these rules, including rules added by other tools such as Docker or fail2ban.

Notes:

- `.env` gets four optional keys: `ISP_SOCKS_ADDR`, `ISP_SOCKS_USER`, `ISP_SOCKS_PASS` and `ISP_SOCKS_EGRESS_IP`. They are stored as plain text, like the other `.env` values, and `.env` stays mode `600`. The username and password are wrapped in double quotes, with `\\` for a backslash, `\"` for a quote and `$$` for a dollar sign inside, so any value stays on one line and Docker Compose (which also reads `.env`) does not interpolate it or fail to parse it. A hand-written value without quotes is read as is. The password is never printed, logged or put on a command line.
- `clash.yaml` gets two new nodes, `shadowsocks-isp` and `vless-reality-isp`, appended to the `proxies` list, and both names are added at the end of the existing `Proxy` group. No new group is created. The additions sit between `# BEGIN my-singbox-isp` and `# END my-singbox-isp` markers, and `--remove` deletes exactly those lines. Every rule stays as it is, so nothing is routed to the ISP nodes unless you pick them in the client. **Re-import `clash.yaml` in your clients afterwards.** `templates/clash.yaml.template` is not changed.
- The script finds the source nodes only by their current names, `shadowsocks` and `vless-reality`, and the `Proxy` group by its name and its `proxies:` list. If your `clash.yaml` was generated before the rename, or no longer has this shape, it stops with a hint; delete `clash.yaml` and run `scripts/conf-clash.sh` again.
- Only TCP egress is tested: the script checks the proxy with a TCP request only. UDP egress is not tested. Whether Shadowsocks UDP on `13839` works depends on your ISP's SOCKS5 proxy: it only works if the proxy supports UDP ASSOCIATE. Do not rely on it until you have tried it yourself.
- Only one run at a time (lock file `.isp.lock`). Runtime files `.isp-backup/`, `.isp.lock` and `.isp-tmp.*` are in `.gitignore`. The `.isp-tmp.*` files can hold the password; they are deleted when the script ends, and leftovers from a killed run are swept at the start of the next run.

## Directory layout

```text
/opt/sing-box/
├── compose.yaml
├── .env          # generated
├── config.json   # generated
└── clash.yaml    # generated
```

The generated files live in the same directory as `compose.yaml`. Do not copy them to other locations on the system.

## For agents

When deploying, agents should follow [`skills/deploy-sing-box-node/SKILL.md`](skills/deploy-sing-box-node/SKILL.md).

## Credentials

`.env`, `config.json`, and `clash.yaml` contain node credentials and are listed in `.gitignore`. The `gen-keys`, `gen-config`, and `conf-clash` commands set their corresponding files to mode `600`. The npm package ships none of these generated files or tests. The REALITY private key appears only in `.env` and `config.json`, and is never written to `clash.yaml`. Do not commit these files.

## Appendix: Quick Docker installation

`init` does not install Docker.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in, or run `newgrp docker`, for the group change to take effect.

Docker group membership is equivalent to root access.
