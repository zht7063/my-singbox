#!/usr/bin/env bats
# scripts/isp-outbound.sh, end to end in a temp copy of the project with every
# external command stubbed (see isp-helpers.bash). No Docker, firewall or network.
# shellcheck disable=SC2030,SC2031  # bats runs each test in its own subshell on purpose
# shellcheck disable=SC1003         # a literal trailing backslash in a password is intended

load isp-helpers

setup() {
    setup_isp_env
    cp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/orig.json"
    cp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    cp "$PROJECT/.env" "$BATS_TEST_TMPDIR/orig.env"
}

assert_original_files() {
    cmp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/orig.json"
    cmp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    cmp "$PROJECT/.env" "$BATS_TEST_TMPDIR/orig.env"
}

up_count() { grep -c 'docker compose.* up ' "$STUB_LOG" || true; }

env_value() { grep -m1 "^$1=" "$PROJECT/.env" | cut -d= -f2-; }

# ---------------------------------------------------------------- basics

@test "repo: .gitignore covers the script's runtime files" {
    grep -qxF '.isp-backup/' "$REPO_ROOT/.gitignore"
    grep -qxF '.isp.lock' "$REPO_ROOT/.gitignore"
    grep -qxF '.isp-tmp.*' "$REPO_ROOT/.gitignore"
}

@test "--help prints usage and needs no root" {
    isp_set uid 1000
    isp_run --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"--add"* ]]
    [[ "$output" == *"--remove"* ]]
    [ ! -s "$STUB_LOG" ] || ! grep -q '^docker' "$STUB_LOG"
}

@test "unknown argument is rejected" {
    isp_run --frobnicate
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown"* ]]
    assert_original_files
}

@test "not root: dies before touching anything (add and remove)" {
    isp_set uid 1000
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"root"* ]]
    isp_remove
    [ "$status" -ne 0 ]
    [[ "$output" == *"root"* ]]
    assert_original_files
    refute grep -q '^docker' "$STUB_LOG"
    refute test -d "$PROJECT/.isp-backup"
}

@test "menu: q quits, junk is rejected" {
    isp_stdin q
    isp_run
    [ "$status" -eq 0 ]
    assert_original_files
    isp_stdin 9
    isp_run
    [ "$status" -ne 0 ]
    assert_original_files
}

@test "menu: 1 adds and 2 removes" {
    isp_stdin 1 "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" "$ISP_PASS_FIXTURE" "" y
    isp_run
    [ "$status" -eq 0 ]
    grep -q isp-socks "$PROJECT/config.json"
    isp_stdin 2 y
    isp_run
    [ "$status" -eq 0 ]
    assert_original_files
}

@test "declining the confirmation changes nothing" {
    isp_stdin "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" "$ISP_PASS_FIXTURE" "" n
    isp_run --add
    [ "$status" -ne 0 ]
    [[ "$output" == *"Aborted"* ]]
    assert_original_files
    [ "$(up_count)" -eq 0 ]
}

# ---------------------------------------------------------------- add

@test "add: config.json gets the two ISP inbounds, the socks outbound and the route rule" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local c="$PROJECT/config.json" o="$BATS_TEST_TMPDIR/orig.json"
    # Original inbounds untouched, same order, at the front.
    [ "$(jq -c '.inbounds[0:2]' "$c")" = "$(jq -c '.inbounds' "$o")" ]
    [ "$(jq '.inbounds | length' "$c")" -eq 4 ]
    # Clones: identical except tag and port.
    [ "$(jq -c '.inbounds[2] | .tag="X" | .listen_port=0' "$c")" = \
      "$(jq -c '.inbounds[] | select(.tag=="ss-in") | .tag="X" | .listen_port=0' "$o")" ]
    [ "$(jq -c '.inbounds[3] | .tag="X" | .listen_port=0' "$c")" = \
      "$(jq -c '.inbounds[] | select(.tag=="vless-reality-in") | .tag="X" | .listen_port=0' "$o")" ]
    [ "$(jq -r '.inbounds[2].tag' "$c")" = ss-isp-in ]
    [ "$(jq -r '.inbounds[2].listen_port' "$c")" = 13839 ]
    [ "$(jq -r '.inbounds[3].tag' "$c")" = vless-reality-isp-in ]
    [ "$(jq -r '.inbounds[3].listen_port' "$c")" = 18444 ]
    # Outbounds: the original ones, plus the socks one.
    [ "$(jq -c '.outbounds[0:1]' "$c")" = "$(jq -c '.outbounds' "$o")" ]
    [ "$(jq -c '.outbounds[1]' "$c")" = \
      '{"type":"socks","tag":"isp-socks","server":"198.51.100.7","server_port":1080,"version":"5","username":"isp-user","password":"S3cret-pass"}' ]
    # Routing by inbound tag.
    [ "$(jq -c '.route.rules' "$c")" = \
      '[{"inbound":["ss-isp-in","vless-reality-isp-in"],"outbound":"isp-socks"}]' ]
    [ "$(stat -c %a "$c")" = 600 ]
}

@test "add: .env gets the four keys, credentials as b64:" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    [ "$(env_value ISP_SOCKS_ADDR)" = "$ISP_ADDR_FIXTURE" ]
    [ "$(env_value ISP_SOCKS_USER)" = "b64:$(printf %s "$ISP_USER_FIXTURE" | base64)" ]
    [ "$(env_value ISP_SOCKS_PASS)" = "b64:$(printf %s "$ISP_PASS_FIXTURE" | base64)" ]
    grep -q '^ISP_SOCKS_EGRESS_IP=$' "$PROJECT/.env"
    refute grep -qF "$ISP_PASS_FIXTURE" "$PROJECT/.env"
    # The original lines are all still there, in order, at the top.
    head -n "$(wc -l < "$BATS_TEST_TMPDIR/orig.env")" "$PROJECT/.env" | cmp - "$BATS_TEST_TMPDIR/orig.env"
    [ "$(stat -c %a "$PROJECT/.env")" = 600 ]
    # gen-config.sh / conf-clash.sh still accept the file (whitelisted keys).
    cd "$PROJECT"
    rm config.json clash.yaml
    run bash scripts/gen-config.sh
    [ "$status" -eq 0 ]
    run bash scripts/conf-clash.sh
    [ "$status" -eq 0 ]
    cmp config.json "$BATS_TEST_TMPDIR/orig.json"
    cmp clash.yaml "$BATS_TEST_TMPDIR/orig.yaml"
}

@test "add: validates with the container's own image, restarts once, verifies" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    grep -q 'docker run .*ghcr.io/sagernet/sing-box:stub.* check -c /etc/sing-box/config.json' "$STUB_LOG"
    grep -q isp-socks "$STUB_STATE/last-check-config"
    [ "$(up_count)" -eq 1 ]
    grep -q "docker compose --project-directory $PROJECT up -d --force-recreate" "$STUB_LOG"
    # check runs before the restart
    local check_line up_line
    check_line=$(grep -n 'docker run' "$STUB_LOG" | head -1 | cut -d: -f1)
    up_line=$(grep -n ' up -d' "$STUB_LOG" | head -1 | cut -d: -f1)
    [ "$check_line" -lt "$up_line" ]
    # the SOCKS5 test used curl with the config on stdin, no secrets in argv
    grep -q '^curl .*-K -' "$STUB_LOG"
    refute grep -F "$ISP_PASS_FIXTURE" "$STUB_LOG"
    grep -q 'proxy = "socks5h://198.51.100.7:1080"' "$STUB_STATE/last-curl-config"
    grep -q 'proxy-user = "isp-user:S3cret-pass"' "$STUB_STATE/last-curl-config"
}

@test "add: makes a private backup of all three files first" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local d
    d=$(find "$PROJECT/.isp-backup" -mindepth 1 -maxdepth 1 -type d)
    [ -n "$d" ]
    [ "$(stat -c %a "$PROJECT/.isp-backup")" = 700 ]
    [ "$(stat -c %a "$d")" = 700 ]
    cmp "$d/config.json" "$BATS_TEST_TMPDIR/orig.json"
    cmp "$d/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    cmp "$d/.env" "$BATS_TEST_TMPDIR/orig.env"
}

@test "add: keeps only the last 5 backups" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local _
    for _ in 1 2 3 4 5 6 7; do
        isp_add_keep
        [ "$status" -eq 0 ]
    done
    [ "$(find "$PROJECT/.isp-backup" -mindepth 1 -maxdepth 1 -type d | wc -l)" -le 5 ]
}

@test "add: output carries the UDP caveat, the no-fallback note and the cloud security group reminder" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    [[ "$output" == *"UDP"* ]]
    [[ "$output" == *"fall back"* ]]
    [[ "$output" == *"security group"* ]]
    [[ "$output" == *"13839/tcp"* ]]
    [[ "$output" == *"13839/udp"* ]]
    [[ "$output" == *"18444/tcp"* ]]
    refute grep -qF "$ISP_PASS_FIXTURE" <<< "$output"
}

@test "add: IPv6 entry address" {
    isp_set egress_ip 2001:db8::1
    isp_add_fresh "[2001:db8::1]:1080"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.outbounds[1].server' "$PROJECT/config.json")" = 2001:db8::1 ]
    [ "$(jq -r '.outbounds[1].server_port' "$PROJECT/config.json")" = 1080 ]
    grep -q 'proxy = "socks5h://\[2001:db8::1\]:1080"' "$STUB_STATE/last-curl-config"
}

@test "add: existing route rules and other config keys survive add and remove" {
    reset_isp_env '.route = {"final":"direct","rules":[{"domain":["example.com"],"outbound":"direct"}]} | .log = {"level":"warn"}'
    cp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/orig.json"
    cp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    cp "$PROJECT/.env" "$BATS_TEST_TMPDIR/orig.env"
    isp_add_fresh
    [ "$status" -eq 0 ]
    [ "$(jq -c '.route.rules[0]' "$PROJECT/config.json")" = '{"domain":["example.com"],"outbound":"direct"}' ]
    [ "$(jq -c '.route.rules | length' "$PROJECT/config.json")" -eq 2 ]
    [ "$(jq -r '.route.final' "$PROJECT/config.json")" = direct ]
    [ "$(jq -r '.log.level' "$PROJECT/config.json")" = warn ]
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
}

# ---------------------------------------------------------------- clash.yaml

@test "clash: only marker blocks are added; the clones differ from the originals only in name and port" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local y="$PROJECT/clash.yaml" o="$BATS_TEST_TMPDIR/orig.yaml"
    [ "$(grep -c '^# BEGIN my-singbox-isp$' "$y")" -eq 2 ]
    [ "$(grep -c '^# END my-singbox-isp$' "$y")" -eq 2 ]
    # Dropping the marker blocks gives the original file back.
    awk '/^# BEGIN my-singbox-isp$/{skip=1} !skip{print} /^# END my-singbox-isp$/{skip=0}' "$y" | cmp - "$o"
    # First block = the two proxies.
    local block
    block=$(awk '/^# BEGIN my-singbox-isp$/{n++} n==1 && !/^# (BEGIN|END)/{print} /^# END my-singbox-isp$/{if(n==1) exit}' "$y")
    local ss_orig vless_orig
    ss_orig=$(awk '/^  - name: "shadowsocks"$/{p=1;print;next} p&&/^  - name:/{exit} p{print}' "$o")
    vless_orig=$(awk '/^  - name: vless-reality$/{p=1;print;next} p&&/^[^ ]/{exit} p&&/^  - name:/{exit} p{print}' "$o")
    [ -n "$ss_orig" ] && [ -n "$vless_orig" ]
    local expected
    expected=$(printf '%s\n%s' \
        "$(sed -e 's/"shadowsocks"/"shadowsocks-isp"/' -e 's/^    port: 8388$/    port: 13839/' <<< "$ss_orig")" \
        "$(sed -e 's/vless-reality$/vless-reality-isp/' -e 's/^    port: 8443$/    port: 18444/' <<< "$vless_orig")")
    [ "$block" = "$expected" ]
}

@test "clash: Proxy-ISP is a select group of the two ISP nodes; Proxy and the rules are untouched" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local y="$PROJECT/clash.yaml"
    grep -q '^  - name: Proxy-ISP$' "$y"
    run awk '/^  - name: Proxy-ISP$/{p=1;print;next} p&&/^# END/{exit} p{print}' "$y"
    [ "$output" = "$(printf '%s\n' '  - name: Proxy-ISP' '    type: select' '    proxies:' '      - shadowsocks-isp' '      - vless-reality-isp')" ]
    # Proxy group lines identical to the original.
    local g1 g2
    g1=$(awk '/^  - name: Proxy$/{p=1;print;next} p&&/^  - name:|^# /{exit} p{print}' "$BATS_TEST_TMPDIR/orig.yaml")
    g2=$(awk '/^  - name: Proxy$/{p=1;print;next} p&&/^  - name:|^# /{exit} p{print}' "$y")
    [ -n "$g1" ]
    [ "$g1" = "$g2" ]
    refute grep -q 'ISP' <<< "$g2"
    # No rule or dns line points at the ISP group.
    refute grep -Eq '^  - [A-Z-]+,.*Proxy-ISP|#Proxy-ISP' "$y"
}

@test "clash: parses as YAML with the expected proxies and groups" {
    python3 -c 'import yaml' 2>/dev/null || skip "PyYAML not installed"
    isp_add_fresh
    [ "$status" -eq 0 ]
    run python3 - "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml" <<'PY'
import sys, yaml
new = yaml.safe_load(open(sys.argv[1]))
old = yaml.safe_load(open(sys.argv[2]))
names = [p["name"] for p in new["proxies"]]
assert names == ["shadowsocks", "vless-reality", "shadowsocks-isp", "vless-reality-isp"], names
assert new["proxy-groups"][0] == old["proxy-groups"][0]
isp = [g for g in new["proxy-groups"] if g["name"] == "Proxy-ISP"]
assert len(isp) == 1 and isp[0]["type"] == "select"
assert isp[0]["proxies"] == ["shadowsocks-isp", "vless-reality-isp"]
assert new["rules"] == old["rules"]
assert new["dns"] == old["dns"]
by = {p["name"]: p for p in new["proxies"]}
assert by["shadowsocks-isp"]["port"] == 13839 and by["vless-reality-isp"]["port"] == 18444
assert by["shadowsocks-isp"]["password"] == by["shadowsocks"]["password"]
assert by["vless-reality-isp"]["uuid"] == by["vless-reality"]["uuid"]
PY
    [ "$status" -eq 0 ]
}

@test "clash: old node names (My-sing-box / My-VLESS-Reality) are refused with a regenerate hint, nothing written" {
    sed -i -e 's/"shadowsocks"/"My-sing-box"/g' -e 's/vless-reality/My-VLESS-Reality/g' "$PROJECT/clash.yaml"
    cp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"conf-clash.sh"* ]]
    [[ "$output" == *"shadowsocks"* ]]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(up_count)" -eq 0 ]
}

@test "clash: a missing source node is refused, nothing written" {
    local node
    for node in '"shadowsocks"' 'vless-reality'; do
        reset_isp_env
        awk -v n="$node" '$0 ~ "^  - name: " n "$" {skip=1; next} skip && /^  - name:|^[^ ]/ {skip=0} !skip' \
            "$PROJECT/clash.yaml" > "$PROJECT/clash.tmp"
        mv "$PROJECT/clash.tmp" "$PROJECT/clash.yaml"
        local before
        before=$(isp_snapshot)
        isp_add_fresh
        [ "$status" -ne 0 ]
        [[ "$output" == *"conf-clash.sh"* ]]
        [ "$(isp_snapshot)" = "$before" ]
        [ "$(up_count)" -eq 0 ]
    done
}

@test "clash: unbalanced markers are refused, nothing written" {
    printf '# BEGIN my-singbox-isp\n' >> "$PROJECT/clash.yaml"
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"marker"* ]]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(up_count)" -eq 0 ]
}

@test "clash: no clash.yaml is not fatal, config is still updated and a hint is printed" {
    rm "$PROJECT/clash.yaml"
    isp_add_fresh
    [ "$status" -eq 0 ]
    grep -q isp-socks "$PROJECT/config.json"
    [ ! -e "$PROJECT/clash.yaml" ]
    [[ "$output" == *"clash.yaml"* ]]
    isp_remove
    [ "$status" -eq 0 ]
    cmp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/orig.json"
}

# ---------------------------------------------------------------- idempotency

@test "add twice (keeping stored values) is byte-identical and restarts once" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local s1
    s1=$(isp_snapshot)
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(isp_snapshot)" = "$s1" ]
    [ "$(up_count)" -eq 1 ]
}

@test "add twice with the same values typed again is byte-identical" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local s1
    s1=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -eq 0 ]
    [ "$(isp_snapshot)" = "$s1" ]
    [ "$(grep -c 'my-singbox-isp' "$PROJECT/.env" || true)" -le 1 ]
    [ "$(jq '.inbounds | length' "$PROJECT/config.json")" -eq 4 ]
}

@test "add with new credentials replaces the old ones in place" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_set egress_ip 192.0.2.9
    isp_add_fresh "192.0.2.9:2080" other-user other-pass
    [ "$status" -eq 0 ]
    [ "$(jq -c '.outbounds | map(select(.tag=="isp-socks")) | length' "$PROJECT/config.json")" -eq 1 ]
    [ "$(jq -r '.outbounds[1].server' "$PROJECT/config.json")" = 192.0.2.9 ]
    [ "$(jq -r '.outbounds[1].password' "$PROJECT/config.json")" = other-pass ]
    [ "$(grep -c '^ISP_SOCKS_ADDR=' "$PROJECT/.env")" -eq 1 ]
    [ "$(env_value ISP_SOCKS_ADDR)" = 192.0.2.9:2080 ]
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
}

@test "add then remove restores config.json, clash.yaml and .env byte for byte" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
    [ "$(cat "$STUB_STATE/listeners")" = "$(printf 'tcp 8388\nudp 8388\ntcp 8443')" ]
    [ "$(up_count)" -eq 2 ]
}

@test "remove twice, and remove when nothing is configured, is a harmless no-op" {
    local before
    before=$(isp_snapshot)
    isp_remove
    [ "$status" -eq 0 ]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(up_count)" -eq 0 ]
    isp_add_fresh
    isp_remove
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
}

@test "remove validates, restarts and verifies like add" {
    isp_add_fresh
    : > "$STUB_LOG"
    isp_remove
    [ "$status" -eq 0 ]
    grep -q 'docker run' "$STUB_LOG"
    [ "$(up_count)" -eq 1 ]
    refute grep -q isp-socks "$STUB_STATE/last-check-config"
}

@test "remove keeps unrelated lines the user added to .env" {
    isp_add_fresh
    printf '# my note\nCUSTOM_NOTE=1\n' >> "$PROJECT/.env"
    isp_remove
    # CUSTOM_NOTE is not whitelisted so gen-config would die, but remove must
    # not care: it only strips its own lines.
    [ "$status" -eq 0 ]
    grep -q '^CUSTOM_NOTE=1$' "$PROJECT/.env"
    refute grep -q 'ISP_SOCKS' "$PROJECT/.env"
}

# ---------------------------------------------------------------- egress IP

@test "egress: defaults to the entry IP, mismatch is refused" {
    isp_set egress_ip 203.0.113.50
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"203.0.113.50"* ]]
    [[ "$output" == *"198.51.100.7"* ]]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(up_count)" -eq 0 ]
    refute test -d "$PROJECT/.isp-backup"
}

@test "egress: an expected egress IP differing from the entry IP is accepted and stored" {
    isp_set egress_ip 203.0.113.50
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" 203.0.113.50
    [ "$status" -eq 0 ]
    [ "$(env_value ISP_SOCKS_EGRESS_IP)" = 203.0.113.50 ]
    # Kept on a re-run with blank answers.
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(env_value ISP_SOCKS_EGRESS_IP)" = 203.0.113.50 ]
}

@test "egress: an expected IP that does not match what the proxy shows is refused" {
    isp_set egress_ip 198.51.100.7
    local before
    before=$(isp_snapshot)
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" 203.0.113.50
    [ "$status" -ne 0 ]
    [ "$(isp_snapshot)" = "$before" ]
}

@test "egress: '-' clears a stored expected IP (back to the entry IP)" {
    isp_set egress_ip 203.0.113.50
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" 203.0.113.50
    [ "$status" -eq 0 ]
    isp_stdin "" "" "" "-"
    isp_run --add --yes
    # The proxy still shows 203.0.113.50, which is not the entry IP any more.
    [ "$status" -ne 0 ]
    [ "$(env_value ISP_SOCKS_EGRESS_IP)" = 203.0.113.50 ]
}

# ---------------------------------------------------------------- failures write nothing

# expect_add_failure DESC LINES...: reset, run a fresh Add with these answers, require
# a non-zero exit, unchanged files and no restart.
expect_add_failure() {
    local desc=$1
    shift
    reset_isp_env
    local before
    before=$(isp_snapshot)
    isp_stdin "$@"
    isp_run --add --yes
    if [ "$status" -eq 0 ]; then
        echo "case '$desc' unexpectedly succeeded: $output" >&2
        return 1
    fi
    if [ "$(isp_snapshot)" != "$before" ]; then
        echo "case '$desc' modified files" >&2
        return 1
    fi
    if [ "$(up_count)" -ne 0 ]; then
        echo "case '$desc' restarted the service" >&2
        return 1
    fi
    if [ -e "$PROJECT/.isp-backup" ] && [ -n "$(ls -A "$PROJECT/.isp-backup")" ]; then
        echo "case '$desc' left a backup" >&2
        return 1
    fi
}

@test "failure paths: bad input is rejected and writes nothing" {
    expect_add_failure "hostname" example.com:1080 u p p ""
    expect_add_failure "no port" 198.51.100.7 u p p ""
    expect_add_failure "port 0" 198.51.100.7:0 u p p ""
    expect_add_failure "port too big" 198.51.100.7:70000 u p p ""
    expect_add_failure "bad ipv6 bracket" "[2001:db8::1:1080" u p p ""
    expect_add_failure "octet too big" 300.1.1.1:1080 u p p ""
    expect_add_failure "empty user" 198.51.100.7:1080 "" p p ""
    expect_add_failure "colon in user" 198.51.100.7:1080 "a:b" p p ""
    expect_add_failure "empty password" 198.51.100.7:1080 u "" "" ""
    expect_add_failure "password mismatch" 198.51.100.7:1080 u p1 p2 ""
    expect_add_failure "bad expected egress" 198.51.100.7:1080 u p p "not-an-ip"
    expect_add_failure "eof" 198.51.100.7:1080
}

@test "failure paths: SOCKS check, egress mismatch, docker and sing-box check failures write nothing" {
    isp_switch_and_fail() {
        reset_isp_env
        isp_switch "$1"
        local before
        before=$(isp_snapshot)
        isp_add_fresh
        if [ "$status" -eq 0 ]; then echo "$1: unexpectedly succeeded" >&2; return 1; fi
        [ "$(isp_snapshot)" = "$before" ]
        [ "$(up_count)" -eq 0 ]
        refute test -d "$PROJECT/.isp-backup"
    }
    isp_switch_and_fail fail_curl
    isp_switch_and_fail docker_down
    isp_switch_and_fail no_container
    isp_switch_and_fail fail_check
}

@test "failure paths: a rejected candidate config shows sing-box's message" {
    isp_switch fail_check
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"config check failed"* ]]
}

@test "failure paths: jq missing and apt-get failing writes nothing" {
    make_min_path
    isp_switch fail_apt
    local before
    before=$(isp_snapshot)
    PATH="$STUB_DIR:$MINBIN" isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"jq"* ]]
    [ "$(isp_snapshot)" = "$before" ]
}

@test "failure paths: the ISP port is already taken by something else" {
    printf 'tcp 8388\nudp 8388\ntcp 8443\ntcp 13839\n' > "$STUB_STATE/listeners"
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"13839"* ]]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(up_count)" -eq 0 ]
}

@test "failure paths: another inbound in config.json already uses an ISP port" {
    reset_isp_env '.inbounds += [{"type":"direct","tag":"other","listen":"0.0.0.0","listen_port":18444}]'
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"18444"* ]]
    [ "$(isp_snapshot)" = "$before" ]
}

@test "failure paths: config.json without ss-in or vless-reality-in is refused" {
    reset_isp_env 'del(.inbounds[] | select(.tag=="vless-reality-in"))'
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"vless-reality-in"* ]]
    [ "$(isp_snapshot)" = "$before" ]
}

@test "failure paths: missing config.json is refused" {
    rm "$PROJECT/config.json"
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"config.json"* ]]
}

@test "lock: a second instance is refused while the lock is held" {
    ( exec 9> "$PROJECT/.isp.lock"; flock 9; exec /bin/sleep 15 ) > /dev/null 2>&1 &
    local holder=$!
    /bin/sleep 0.5
    isp_add_fresh
    kill "$holder" 2>/dev/null || true
    wait "$holder" 2>/dev/null || true
    [ "$status" -ne 0 ]
    [[ "$output" == *"in progress"* ]]
    assert_original_files
}

# ---------------------------------------------------------------- rollback

@test "rollback: container crashes with the ISP config -> all three files restored, old config running again" {
    isp_switch break_isp
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"Rolling back"* ]]
    assert_original_files
    [ "$(cat "$STUB_STATE/status")" = running ]
    [ "$(cat "$STUB_STATE/listeners")" = "$(printf 'tcp 8388\nudp 8388\ntcp 8443')" ]
    [ "$(up_count)" -eq 2 ]
    [ "$(isp_snapshot)" = "$before" ]
    # no firewall change was made (config-first ordering)
    refute grep -qE '^(ufw|firewall-cmd|iptables) ' <(grep -vE '^iptables -S|^ufw status|^firewall-cmd --state' "$STUB_LOG")
    # the backup of the failed attempt is kept for inspection
    [ -d "$PROJECT/.isp-backup" ]
}

@test "rollback: compose up fails -> files restored" {
    isp_switch fail_up_isp
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"Rolling back"* ]]
    assert_original_files
}

@test "rollback: if even the rollback cannot be verified, say so and still leave the old files in place" {
    isp_switch break_isp
    isp_switch fail_exec_check
    isp_add_fresh
    [ "$status" -ne 0 ]
    assert_original_files
    [[ "$output" == *"rollback"* ]] || [[ "$output" == *"Rolling back"* ]]
}

@test "rollback: a failed remove puts the ISP setup back" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local before
    before=$(isp_snapshot)
    isp_switch break_clean       # the container dies when started without the ISP config
    isp_remove
    [ "$status" -ne 0 ]
    [[ "$output" == *"Rolling back"* ]]
    isp_unswitch break_clean
    [ "$(isp_snapshot)" = "$before" ]
    grep -q isp-socks "$PROJECT/config.json"
}

# ---------------------------------------------------------------- special characters

@test "special-character passwords round-trip into config.json and .env and never leak" {
    local -a pws=(
        'p@ss:w/rd#1'
        'a"b'\''c\d'
        '$HOME'
        '`id`'
        '$(id)'
        ';rm -rf /'
        'with space s'
        '  padded  '
        '%41%2f'
        '-leading-dash'
        '--insecure'
        'ünï/日本語'
        'x&y|z>w<v*?[a]{b}~'
        '!bang!'
    )
    local pw user='u:ser' n=0
    user='user.name@host'
    for pw in "${pws[@]}"; do
        n=$((n + 1))
        reset_isp_env
        isp_add_fresh "$ISP_ADDR_FIXTURE" "$user" "$pw"
        if [ "$status" -ne 0 ]; then
            echo "password #$n failed: $output" >&2
            return 1
        fi
        # config.json holds the exact password
        [ "$(jq -r '.outbounds[1].password' "$PROJECT/config.json")" = "$pw" ]
        [ "$(jq -r '.outbounds[1].username' "$PROJECT/config.json")" = "$user" ]
        # .env holds it base64-encoded, and decodes to the exact password
        local stored
        stored=$(env_value ISP_SOCKS_PASS)
        [[ "$stored" == b64:* ]]
        [ "$(printf %s "${stored#b64:}" | base64 -d)" = "$pw" ]
        refute grep -qF -- "$pw" "$PROJECT/.env"
        # curl got a correctly quoted value on stdin
        local esc=${pw//\\/\\\\}
        esc=${esc//\"/\\\"}
        grep -qF -- "proxy-user = \"$user:$esc\"" "$STUB_STATE/last-curl-config"
        # never in the output, in any command line (stub log), or in clash.yaml
        if grep -qF -- "$pw" <<< "$output"; then echo "password #$n leaked into the output" >&2; return 1; fi
        if grep -qF -- "$pw" "$STUB_LOG"; then echo "password #$n leaked into a command line" >&2; return 1; fi
        if grep -qF -- "$pw" "$PROJECT/clash.yaml"; then echo "password #$n leaked into clash.yaml" >&2; return 1; fi
        # an injected command did not run
        [ ! -e /tmp/pwned-by-isp-test ]
        # Add -> Remove still restores everything
        isp_remove
        [ "$status" -eq 0 ]
        assert_original_files
    done
}

@test "special-character: a re-run keeps the stored b64 credentials without prompting for them" {
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" 'p@ss:w/rd#1 "q" \'
    [ "$status" -eq 0 ]
    local s1
    s1=$(isp_snapshot)
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(isp_snapshot)" = "$s1" ]
    [ "$(jq -r '.outbounds[1].password' "$PROJECT/config.json")" = 'p@ss:w/rd#1 "q" \' ]
}

@test "special-character: control characters in the password are refused" {
    expect_add_failure "tab in password" "$ISP_ADDR_FIXTURE" u $'pa\tss' $'pa\tss' ""
}

@test "secrets: failure output does not show the password either" {
    isp_switch fail_curl
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" 'Un1queSecretValue!'
    [ "$status" -ne 0 ]
    refute grep -qF 'Un1queSecretValue!' <<< "$output"
    refute grep -qF 'Un1queSecretValue!' "$STUB_LOG"
    reset_isp_env
    isp_switch break_isp
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" 'Un1queSecretValue!'
    [ "$status" -ne 0 ]
    refute grep -qF 'Un1queSecretValue!' <<< "$output"
    refute grep -qF 'Un1queSecretValue!' "$STUB_LOG"
}

# ---------------------------------------------------------------- jq

make_min_path() {
    MINBIN="$BATS_TEST_TMPDIR/minbin"
    mkdir -p "$MINBIN"
    local t p
    for t in bash env flock base64 mktemp cmp date tr grep find sort rm mv cp chmod chown mkdir \
             basename dirname cat head tail sed awk wc cut stat ls tee readlink realpath uniq \
             touch ln diff sha256sum xargs printf true false test dd od hostname uname; do
        p=$(command -v "$t" 2>/dev/null || true)
        [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" "$MINBIN/$t"
    done
    true
}

@test "jq is installed through apt-get when missing" {
    make_min_path
    [ ! -e "$STUB_DIR/jq" ]
    PATH="$STUB_DIR:$MINBIN" isp_add_fresh
    [ "$status" -eq 0 ]
    grep -q '^apt-get .*install.* jq' "$STUB_LOG"
    grep -q isp-socks "$PROJECT/config.json"
}

@test "jq present: apt-get is not called" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    refute grep -q '^apt-get' "$STUB_LOG"
}

# ---------------------------------------------------------------- firewall

@test "firewall none: no firewall commands, reminder still printed" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    refute grep -qE '^(ufw (allow|delete)|firewall-cmd .*(add|remove)-port|iptables -I|netfilter-persistent)' "$STUB_LOG"
    [[ "$output" == *"security group"* ]]
}

@test "firewall ufw: allows the three rules and removes them again" {
    isp_set backend ufw
    isp_add_fresh
    [ "$status" -eq 0 ]
    grep -q '^ufw allow 13839/tcp' "$STUB_LOG"
    grep -q '^ufw allow 13839/udp' "$STUB_LOG"
    grep -q '^ufw allow 18444/tcp' "$STUB_LOG"
    refute grep -qE '^ufw allow (8388|8443)' "$STUB_LOG"
    isp_remove
    [ "$status" -eq 0 ]
    grep -q '^ufw delete allow 13839/tcp' "$STUB_LOG"
    grep -q '^ufw delete allow 13839/udp' "$STUB_LOG"
    grep -q '^ufw delete allow 18444/tcp' "$STUB_LOG"
    assert_original_files
}

@test "firewall ufw: rules are only added after the new service is verified" {
    isp_set backend ufw
    isp_add_fresh
    [ "$status" -eq 0 ]
    local up_line fw_line
    up_line=$(grep -n ' up -d' "$STUB_LOG" | head -1 | cut -d: -f1)
    fw_line=$(grep -n '^ufw allow' "$STUB_LOG" | head -1 | cut -d: -f1)
    [ "$up_line" -lt "$fw_line" ]
}

@test "firewall ufw: a failing ufw is reported with the ports to open by hand; the working service is kept; a re-run converges" {
    isp_set backend ufw
    isp_set fail_fw ufw
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"firewall"* ]]
    [[ "$output" == *"13839/tcp"* ]]
    [[ "$output" == *"18444/tcp"* ]]
    # The server side is up and consistent.
    grep -q isp-socks "$PROJECT/config.json"
    grep -q '^ISP_SOCKS_ADDR=' "$PROJECT/.env"
    refute grep -qF "$ISP_PASS_FIXTURE" <<< "$output"
    # Once the firewall works again, re-running finishes the job.
    rm "$STUB_STATE/fail_fw"
    isp_add_keep
    [ "$status" -eq 0 ]
    grep -q '^ufw allow 18444/tcp' "$STUB_LOG"
}

@test "firewall firewalld: opens permanent and runtime ports, removes both" {
    isp_set backend firewalld
    isp_add_fresh
    [ "$status" -eq 0 ]
    local p
    for p in 13839/tcp 13839/udp 18444/tcp; do
        grep -qxF "perm:$p" "$STUB_STATE/firewalld_ports"
        grep -qxF "run:$p" "$STUB_STATE/firewalld_ports"
    done
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(grep -c '^perm:13839/tcp$' "$STUB_STATE/firewalld_ports")" -eq 1 ]
    isp_remove
    [ "$status" -eq 0 ]
    [ ! -s "$STUB_STATE/firewalld_ports" ]
    assert_original_files
}

@test "firewall iptables: inserts tagged rules once, installs and calls netfilter-persistent" {
    isp_set backend iptables
    isp_add_fresh
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$STUB_STATE/ipt_rules")" -eq 3 ]
    grep -q -- '--dport 13839 .*my-singbox-isp' "$STUB_STATE/ipt_rules"
    grep -q 'apt-get .*install.*netfilter-persistent' "$STUB_LOG"
    grep -q '^debconf-set-selections' "$STUB_LOG"
    grep -q '^netfilter-persistent save' "$STUB_LOG"
    # Idempotent: a second run adds nothing.
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$STUB_STATE/ipt_rules")" -eq 3 ]
    # Remove deletes them and saves again.
    : > "$STUB_LOG"
    isp_remove
    [ "$status" -eq 0 ]
    [ ! -s "$STUB_STATE/ipt_rules" ]
    grep -q '^netfilter-persistent save' "$STUB_LOG"
    assert_original_files
}

@test "firewall iptables: netfilter-persistent already present is not reinstalled" {
    isp_set backend iptables
    printf '#!/usr/bin/env bash\necho "netfilter-persistent $*" >> "$STUB_LOG"\n' > "$STUB_DIR/netfilter-persistent"
    chmod +x "$STUB_DIR/netfilter-persistent"
    isp_add_fresh
    [ "$status" -eq 0 ]
    refute grep -q '^apt-get .*install.*netfilter-persistent' "$STUB_LOG"
    grep -q '^netfilter-persistent save' "$STUB_LOG"
}

@test "firewall iptables: a failing iptables is reported and no rule is recorded" {
    isp_set backend iptables
    isp_set fail_fw iptables
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"firewall"* ]]
    [ ! -s "$STUB_STATE/ipt_rules" ]
}

@test "remove cleans up firewall rules even when the config is already clean" {
    isp_set backend ufw
    isp_remove
    [ "$status" -eq 0 ]
    grep -q '^ufw delete allow 13839/tcp' "$STUB_LOG"
    assert_original_files
}
