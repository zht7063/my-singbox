# Changelog

## 3.0.1

### Fixes

- Rendering a server config template whose `route.rules` is not an array now fails with a clear error: `Invalid config.json template: route.rules must be an array.` (#23)
- Remove the unused `GROUP_MAIN` export and the obsolete `'clash.yaml'` member of `ManagedFile`. (#24)
- Docs: state clearly that the default Anthropic/Claude/Datadog domain rule is written to the server's `config.json` and does not change client `clash.yaml` rules. (#25)

## 3.0.0

### Breaking changes

- ISP exit selection moves from separate SS/VLESS listeners and client nodes into native sing-box `route` rules. Generated configurations always use the two base listeners on 8388 and 8443 and the corresponding two Clash nodes. Client rules, rule providers, and DNS policy keep their existing behavior.
- `Model.nodes` no longer includes separate ISP nodes, and the `Node.egress` property is removed. Use the independent `Model.isp` outbound settings and server routing policy instead.
- Remove the obsolete library helpers `addIspToClash`, `clashHasIsp`, `findCleanBackup`, and `IspService.portsFree`. ISP commands no longer inspect or modify client configuration. Call `IspService.verifyService()` without an ISP flag; listener checks come from the actual server config.
- `isp-outbound --remove` edits the current server configuration and environment rather than restoring a historical clean backup. It preserves unrelated changes made after ISP was enabled. Transaction backups and rollback manage only `config.json` and `.env` by default.

### Migration

Back up existing deployment files before upgrading. Adding or removing ISP migrates recognized legacy server listeners and their dedicated routing rules. When listeners are actually retired, the command reminds you to regenerate `clash.yaml` and close the old 13839/18444 ports. The command leaves the existing client file untouched.

To replace a legacy four-node client config, back it up and move it out of the deployment directory, run `my-singbox conf-clash`, then re-import the resulting two-node configuration. Keep client customizations in the effective template or merge them into the new file. Generation continues to refuse overwriting an existing file. See [ISP routing and migration](docs/ts/isp-outbound.md).

### Routing and compatibility

The server template owns the optional domain rules selecting `isp-socks`, including the intended Anthropic, Claude, and Datadog defaults. With no ISP credentials, generation omits these optional rules and retains sniffing and a default direct exit. Updating ISP credentials preserves existing route matchers and rule order.

The legacy Shell workflow retains its separate-listener behavior. Its base generator omits optional ISP-targeted rules from the shared template so that it does not reference a missing outbound. It preserves sniffing and unrelated native rules.
