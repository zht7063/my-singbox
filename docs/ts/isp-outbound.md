# ISP outbound

`my-singbox isp-outbound [--add|--remove] [--yes|-y] [--help]` manages server-side ISP routing. Without an action it shows a menu; `--yes` skips the restart confirmation. Run it from the deployment directory with access to Docker and Docker Compose and read/write access to `config.json` and `.env`. Root, `jq`, and `flock` are not required. The SOCKS5 egress check uses `curl`.

## Two routing decisions

Clash's existing rules, rule providers, and DNS settings remain unchanged. They decide whether traffic goes directly from the client or enters the VPS. Only traffic sent to the VPS reaches sing-box's independent server route in `config.json`.

| Server setting | No ISP configured | ISP configured |
| --- | --- | --- |
| Inbounds | `ss-in:8388`, `vless-reality-in:8443` | Same two inbounds |
| Client nodes | `shadowsocks`, `vless-reality` | Same two nodes |
| Outbounds | `direct` | `direct`, `isp-socks` |
| Route | Sniff, then default `direct` | Sniff, selected domains to `isp-socks`, then default `direct` |

ISP adds no listening ports. Continue allowing 8388 TCP/UDP and 8443 TCP for the base nodes; the command never changes firewall rules. Both protocols follow the same server route, so choosing a client node no longer selects the ISP exit.

The default server template, `templates/config.json.template`, contains the optional `domain_suffix` rule for:

- `anthropic.com`
- `claude.ai`
- `claude.com`
- `claudeusercontent.com`
- `http-intake.logs.us5.datadoghq.com`
- `browser-intake-us5-datadoghq.com`

The server template owns this list; changing it does not change the client's domain list. Edit the effective server template before generation, or edit an existing `config.json` to adjust its current policy. With no ISP settings, generation omits top-level rules whose `outbound` is `isp-socks`, retaining sniffing and `route.final: "direct"`. Unsupported dependencies on a missing ISP outbound, such as `route.final: "isp-socks"` or an outbound `detour`, produce an error instead of silently changing the policy.

## Add and update

`--add` reads the SOCKS5 address and credentials, upserts the single `isp-socks` outbound, and saves the `ISP_SOCKS_*` settings in `.env`. It preserves existing ISP route conditions and their order when updating credentials. Repeating the operation with the same settings is idempotent.

When the current config has no ISP rules, the command copies the optional ISP rules from the effective server template. It adds a missing sniff rule at the beginning, appends the template's ISP rules after existing rules, and sets `route.final` to `direct` only when no final outbound exists. Existing terminal rules can therefore take priority over the appended ISP rules; review rule order when adding ISP to a customized server config. Editing the template alone does not replace ISP rules already present in the current config.

Add and remove manage only `config.json` and `.env`. They never read or write `clash.yaml`, including during backup, failure rollback, or recovery from an older backup that contains a client file. A missing or unwritable `clash.yaml` does not block the command. No client re-import is needed for ordinary ISP changes to a configuration that already uses the two base nodes.

Library callers use `addIspToConfig(config, isp, routeDefaults?)`. Pass `loadSingboxTemplate(projectDir).route` as `routeDefaults` when the current config has no ISP rules and should receive the template policy. The defaults are not a replacement for existing ISP rules. Version 3 removes `Node.egress`, `addIspToClash`, `clashHasIsp`, `findCleanBackup`, and `IspService.portsFree`; `IspService.verifyService()` takes no arguments. See the [3.0.0 breaking changes](../../CHANGELOG.md).

## Remove and rollback

`--remove` edits the current config: it removes the ISP outbound and top-level rules pointing to it, then clears the ISP settings from `.env`. It preserves unrelated routing, rule order, DNS, outbounds, and edits made after ISP was enabled. Removal works without a historical pre-ISP backup. Unsupported remaining references to ISP are reported with their location before files are modified; resolve those references manually before retrying.

Backups in `.isp-backup` support transaction rollback, rather than serving as the source of a normal removal. The backup root and directories use mode 700. Retention keeps the oldest backup and the four newest; a no-op creates no backup. Protect `.env`, server configuration, and backups because they contain secrets.

The command validates the candidate configuration and verifies the service after a restart, using listening ports from the actual server config. If installation, restart, or verification fails, it rolls back `config.json` and `.env`, restoring the original files from the transaction snapshot. INT, TERM, and HUP also trigger rollback while a change is awaiting verification. A PID file lock (`.isp.lock`) prevents concurrent runs; stale locks are taken over and stale temporary files are cleaned up under the lock. Credentials are read without echo on a terminal and are not printed in logs or passed to curl in command arguments.

Configuration validation and direct SOCKS5/egress checks do not prove that application traffic follows the intended domain route. Verify the selected domains and the default VPS exit in the deployment environment.

## Migrate an older ISP configuration

The TypeScript ISP model differs from `scripts/isp-outbound.sh` and the `shell-version` v1.1.0 release. The legacy shell workflow remains available and retains its extra-port, four-node behavior; full ISP parity is no longer a goal.

The server migration recognizes the known legacy inbound tags `ss-isp-in` and `vless-reality-isp-in` and their dedicated routes. It removes only these managed legacy objects; mixed inbound matches retain their other tags. If a custom reference cannot be migrated safely, the command stops before changing files and requests manual migration. Port numbers alone do not identify legacy objects. After a successful add or remove actually retires legacy listeners, the command prints a reminder to regenerate the client `clash.yaml` and close the old ISP ports. No migration reminder is printed for an ordinary two-node update, a no-op, or a failed transaction.

Old client files may still contain `shadowsocks-isp` and `vless-reality-isp` on the retired extra ports. ISP commands leave those files untouched. Explicitly replace them before using the migrated server:

1. Back up `clash.yaml`, including any custom client settings.
2. Move the original file out of the deployment directory. `conf-clash` continues to refuse overwriting an existing file.
3. Run `my-singbox conf-clash` to generate the two-node client config from the effective client template. Put any client customizations into that template first, or merge them into the generated file afterward.
4. Re-import the generated `clash.yaml` in each client and select a base node.

| Difference from the legacy shell workflow | TypeScript CLI |
| --- | --- |
| ISP selection | Independent server domain route, using two base nodes |
| ISP listening ports | No additional ports |
| Client config | Never read or written by ISP commands |
| `--remove` | Targeted changes to the current server config and `.env` |
| `jq` | Not required |
| Lock | PID file instead of `flock` |
