# ISP outbound

`my-singbox isp-outbound [--add|--remove] [--yes|-y] [--help]` is compatible with the v1.1.0 shell workflow. Without an action it shows a menu; `--yes` skips the restart confirmation. Run it from the project directory with access to Docker and Docker Compose and read/write access to the project files. Root, `jq`, and `flock` are not required. The SOCKS5 egress check uses `curl`.

`--add` incrementally updates the existing configuration, preserving user edits and Clash comments. Repeating it with the same settings is idempotent. It adds sing-box inbounds `ss-isp-in` on port 13839 and `vless-reality-isp-in` on port 18444, the `isp-socks` outbound and its route. In Clash, the nodes `shadowsocks-isp` and `vless-reality-isp` are added to the existing `Proxy` group. The original nodes and ports remain available. Re-import `clash.yaml` in clients to see the new nodes.

Backups live in `.isp-backup`, with the backup root and directories set to mode 700. Retention keeps the oldest backup and the four newest; a no-op creates no backup. `--remove` restores the files byte for byte from the newest backup taken before ISP was added, after first snapshotting the current files. Edits made after `--add` to `config.json`, `clash.yaml`, or `.env` are not carried into the restored files, but remain in that snapshot. If no pre-ISP backup exists, removal makes no changes.

The command validates the candidate configuration and verifies the service after a restart. If the restart or verification fails, it rolls back to the saved files. INT, TERM, and HUP also trigger rollback while a change is awaiting verification. A PID file lock (`.isp.lock`) prevents concurrent runs; stale locks are taken over and stale temporary files are cleaned up under the lock.

The CLI prints a port notice but never changes firewall rules. Allow 13839 TCP and UDP and 18444 TCP in the local firewall and cloud security group as needed; after removal, close them yourself if appropriate. Credentials are read without echo on a terminal and are not printed in logs or passed to curl in command arguments. Protect `.env`, configuration files, and backups because they contain secrets.

| Difference from `scripts/isp-outbound.sh` v1.1.0 | TypeScript CLI |
| --- | --- |
| `jq` | Not required |
| Lock | PID file instead of `flock` |
| `--remove` | Restores a pre-ISP backup instead of stripping markers |
| Clash markers | Does not write `my-singbox-isp` markers; accepts files with v1.1.0 markers |
