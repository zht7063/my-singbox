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

# env_value KEY: the raw text stored after "KEY=" in .env.
env_value() { grep -m1 "^$1=" "$PROJECT/.env" | cut -d= -f2-; }

# env_expect_quoted TEXT: the form the script must store a username/password
# in, computed independently of the script: wrapped in double quotes, with
# \ -> \\, " -> \" and $ -> $$ (the dotenv form Docker Compose reads).
env_expect_quoted() {
    local v=$1
    v=${v//\\/\\\\}
    v=${v//\"/\\\"}
    v=${v//\$/\$\$}
    printf '"%s"' "$v"
}

# read_back_pass FILE: load the script's own .env reader and set READ_BACK to
# the password it reads from FILE (and check the user and address too).
read_back_pass() {
    local f
    for f in env_get env_unquote env_get_plain is_ipv4 is_ipv6 parse_addr load_isp_from_env; do
        # shellcheck disable=SC1090
        source <(sed -n "/^${f}() {/,/^}/p" "$ISP")
    done
    load_isp_from_env "$1"
    READ_BACK=$ISP_PASS
}

# compose_sees_pass TEXT: Docker Compose, which also parses .env, must read
# exactly TEXT for ISP_SOCKS_PASS without an error or a warning. Skipped when
# no usable compose is installed (the stub docker is taken off the PATH first).
# A tiny compose file that interpolates the variable is used, so nothing but
# that one value is ever printed.
compose_sees_pass() {
    local want=$1 clean_path out err dir="$BATS_TEST_TMPDIR/compose-check" cmd=()
    clean_path=${PATH//"$STUB_DIR:"/}
    if PATH=$clean_path docker compose version >/dev/null 2>&1; then
        cmd=(docker compose)
    elif PATH=$clean_path command -v docker-compose >/dev/null 2>&1; then
        cmd=(docker-compose)
    else
        return 0
    fi
    rm -rf "$dir"
    mkdir -p "$dir"
    cp "$PROJECT/.env" "$dir/.env"
    printf 'services:\n  t:\n    image: scratch\n    environment:\n      P: "${ISP_SOCKS_PASS}"\n' > "$dir/compose.yaml"
    if ! out=$(cd "$dir" && PATH=$clean_path "${cmd[@]}" config --format json 2>"$dir/err"); then
        echo "docker compose cannot parse .env: $(cat "$dir/err")" >&2
        return 1
    fi
    err=$(cat "$dir/err")
    [ -z "$err" ] || { echo "docker compose warned about .env: $err" >&2; return 1; }
    # "config" prints every "$" of a value as "$$"
    local want_out=${want//\$/\$\$}
    [ "$(jq -r '.services.t.environment.P' <<< "$out")" = "$want_out" ] || { echo "docker compose reads a different password: want [$want]" >&2; return 1; }
    rm -rf "$dir"
}

# The commands isp-outbound.sh must never run (it installs nothing, never uses
# sudo and never touches a firewall).
assert_no_system_changes() {
    if grep -Eq '^(apt-get|sudo|ufw|firewall-cmd|iptables|ip6tables|netfilter-persistent|debconf-set-selections)( |$)' "$STUB_LOG"; then
        echo "a forbidden command was run:" >&2
        grep -E '^(apt-get|sudo|ufw|firewall-cmd|iptables|ip6tables|netfilter-persistent|debconf-set-selections)( |$)' "$STUB_LOG" >&2
        return 1
    fi
}

# Nothing was created or changed: the three files, no lock, no backup, no temp file.
assert_nothing_written() {
    assert_original_files
    assert_no_tmp
    [ ! -e "$PROJECT/.isp-backup" ]
    [ ! -e "$PROJECT/.isp.lock" ]
}

# No temp file (they can hold the plaintext password) may be left behind.
assert_no_tmp() {
    local left
    left=$(find "$PROJECT" -maxdepth 1 -name '.isp-tmp.*')
    if [ -n "$left" ]; then
        echo "temp files left behind: $left" >&2
        return 1
    fi
}

backup_count() { find "$PROJECT/.isp-backup" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l; }

# ---------------------------------------------------------------- basics

@test "repo: .gitignore covers the script's runtime files" {
    grep -qxF '.isp-backup/' "$REPO_ROOT/.gitignore"
    grep -qxF '.isp.lock' "$REPO_ROOT/.gitignore"
    grep -qxF '.isp-tmp.*' "$REPO_ROOT/.gitignore"
}

@test "--help prints usage and needs neither root nor jq nor docker" {
    make_min_path
    PATH="$MINBIN" run bash "$ISP" --help
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

@test "no root or sudo is needed: the script never checks the uid and never calls sudo" {
    refute grep -Eq 'EUID|id -u|\$\(id\)' "$ISP"
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
    assert_no_system_changes
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

@test "add: .env gets the four keys as plain text (no b64), mode 600" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    grep -qxF 'ISP_SOCKS_ADDR=198.51.100.7:1080' "$PROJECT/.env"
    grep -qxF 'ISP_SOCKS_USER="isp-user"' "$PROJECT/.env"
    grep -qxF 'ISP_SOCKS_PASS="S3cret-pass"' "$PROJECT/.env"
    grep -qx 'ISP_SOCKS_EGRESS_IP=' "$PROJECT/.env"
    refute grep -qiE 'b64|base64' "$PROJECT/.env"
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
    refute grep -qF "$ISP_PASS_FIXTURE" config.json clash.yaml
}

@test "add: config.json is written from the values stored in .env" {
    isp_add_fresh "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" 'Str@nge "pw" $x \'
    [ "$status" -eq 0 ]
    grep -qxF "ISP_SOCKS_PASS=$(env_expect_quoted 'Str@nge "pw" $x \')" "$PROJECT/.env"
    [ "$(jq -r '.outbounds[1].password' "$PROJECT/config.json")" = 'Str@nge "pw" $x \' ]
    # A hand-edited, unquoted plain-text value in .env is read the same way.
    sed -i 's/^ISP_SOCKS_PASS=.*/ISP_SOCKS_PASS=hand-written pw/; s/^ISP_SOCKS_USER=.*/ISP_SOCKS_USER=hand-user/' "$PROJECT/.env"
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(jq -r '.outbounds[1].password' "$PROJECT/config.json")" = 'hand-written pw' ]
    [ "$(jq -r '.outbounds[1].username' "$PROJECT/config.json")" = 'hand-user' ]
    grep -qxF 'ISP_SOCKS_PASS="hand-written pw"' "$PROJECT/.env"
}

@test "no base64 anywhere: the ISP script, gen-config.sh, conf-clash.sh and the .env template do not mention it" {
    refute grep -niE 'b64|base64' "$REPO_ROOT/scripts/isp-outbound.sh" "$REPO_ROOT/scripts/gen-config.sh" \
        "$REPO_ROOT/scripts/conf-clash.sh" "$REPO_ROOT/templates/.env.template"
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

@test "add: a run that changes nothing makes no backup" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    [ "$(backup_count)" -eq 1 ]
    local _
    for _ in 1 2 3 4 5 6 7; do
        isp_add_keep
        [ "$status" -eq 0 ]
        [[ "$output" != *"Backup saved"* ]]
    done
    [ "$(backup_count)" -eq 1 ]
}

@test "add: keeps five backups, and the oldest one (the original files) is never rotated away" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local first i
    first=$(find "$PROJECT/.isp-backup" -mindepth 1 -maxdepth 1 -type d)
    for i in 1 2 3 4 5 6 7 8; do
        isp_add_fresh "" "isp-user$i"
        [ "$status" -eq 0 ]
    done
    [ "$(backup_count)" -eq 5 ]
    [ -d "$first" ]
    cmp "$first/config.json" "$BATS_TEST_TMPDIR/orig.json"
    cmp "$first/.env" "$BATS_TEST_TMPDIR/orig.env"
}

@test "add: output carries the UDP caveat and the no-fallback note" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    [[ "$output" == *"UDP"* ]]
    [[ "$output" == *"fall back"* ]]
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

@test "clash: both ISP nodes are added to the existing Proxy group; no new group; the rest is untouched" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    local y="$PROJECT/clash.yaml" o="$BATS_TEST_TMPDIR/orig.yaml"
    # The Proxy group: the original lines, then a marker block with the two names.
    local g1 g2
    g1=$(awk '/^  - name: Proxy$/{p=1;print;next} p&&/^$/{exit} p{print}' "$o")
    g2=$(awk '/^  - name: Proxy$/{p=1;print;next} p&&/^$/{exit} p{print}' "$y")
    [ "$g2" = "$(printf '%s\n%s\n%s\n%s\n%s' "$g1" '# BEGIN my-singbox-isp' '      - shadowsocks-isp' '      - vless-reality-isp' '# END my-singbox-isp')" ]
    [ "$(grep -c '^  - name: ' "$y")" -eq "$(( $(grep -c '^  - name: ' "$o") + 2 ))" ]
    # Exactly one Proxy group and no other group was added or changed.
    [ "$(grep -c '^  - name: Proxy$' "$y")" -eq 1 ]
    [ "$(grep -c '^    type: select$' "$y")" -eq "$(grep -c '^    type: select$' "$o")" ]
    # The ISP names are listed once in a group and once as a node.
    [ "$(grep -cx '      - shadowsocks-isp' "$y")" -eq 1 ]
    [ "$(grep -cx '      - vless-reality-isp' "$y")" -eq 1 ]
    # Rules and everything else are exactly the original (checked by the marker strip above) and
    # no rule points at an ISP node or group.
    refute grep -Eq '^  - [A-Z-]+,.*-isp' "$y"
    # The template is not touched.
    cmp "$PROJECT/templates/clash.yaml.template" "$REPO_ROOT/templates/clash.yaml.template"
}

@test "clash: the Proxy group keeps its order, the ISP names follow its last entry" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    run awk '/^  - name: Proxy$/{p=1;next} p&&/^    proxies:$/{q=1;next} q&&/^  - name:|^[^ #]/{exit} q&&!/^#/{print}' "$PROJECT/clash.yaml"
    [ "$output" = "$(printf '%s\n' '      - shadowsocks' '      - vless-reality' '      - DIRECT' '      - shadowsocks-isp' '      - vless-reality-isp')" ]
}

@test "clash: add is idempotent; re-running changes nothing and never duplicates the entries" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    cp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/clash.after-add"
    local _
    for _ in 1 2 3; do
        isp_add_keep
        [ "$status" -eq 0 ]
        cmp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/clash.after-add"
    done
    # same values typed again, and changed credentials: still one entry each
    isp_add_fresh "" "other-user" "other-pass"
    [ "$status" -eq 0 ]
    cmp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/clash.after-add"
    [ "$(grep -c '^# BEGIN my-singbox-isp$' "$PROJECT/clash.yaml")" -eq 2 ]
    [ "$(grep -cx '      - shadowsocks-isp' "$PROJECT/clash.yaml")" -eq 1 ]
    [ "$(grep -cx '      - vless-reality-isp' "$PROJECT/clash.yaml")" -eq 1 ]
}

@test "clash: remove deletes the nodes and their Proxy entries and restores clash.yaml byte for byte" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    grep -q 'vless-reality-isp' "$PROJECT/clash.yaml"
    isp_remove
    [ "$status" -eq 0 ]
    cmp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    refute grep -q -- '-isp\|my-singbox-isp' "$PROJECT/clash.yaml"
    # and again after remove -> add -> remove
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_remove
    [ "$status" -eq 0 ]
    cmp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
}

@test "clash: a Proxy group that is missing or has no proxies list is refused, nothing written" {
    sed -i 's/^  - name: Proxy$/  - name: Main/' "$PROJECT/clash.yaml"
    cp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    local before
    before=$(isp_snapshot)
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"'Proxy' proxy group"* ]]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(up_count)" -eq 0 ]
}

@test "clash: parses as YAML; the ISP nodes are in the Proxy group, nothing else changed" {
    python3 -c 'import yaml' 2>/dev/null || skip "PyYAML not installed"
    isp_add_fresh
    [ "$status" -eq 0 ]
    run python3 - "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml" <<'PY'
import sys, yaml
new = yaml.safe_load(open(sys.argv[1]))
old = yaml.safe_load(open(sys.argv[2]))
names = [p["name"] for p in new["proxies"]]
assert names == ["shadowsocks", "vless-reality", "shadowsocks-isp", "vless-reality-isp"], names
assert len(new["proxy-groups"]) == len(old["proxy-groups"]) == 1
g = new["proxy-groups"][0]
assert g["name"] == "Proxy" and g["type"] == "select"
assert g["proxies"] == old["proxy-groups"][0]["proxies"] + ["shadowsocks-isp", "vless-reality-isp"], g["proxies"]
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
    if ! assert_no_tmp; then
        echo "case '$desc' left temp files" >&2
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
    expect_add_failure "ipv6 with 3 groups" "[1:2:3]:1080" u p p ""
    expect_add_failure "ipv6 with a 5-digit group" "[abcde::1]:1080" u p p ""
    expect_add_failure "bad expected egress (ipv6, 5 digits)" 198.51.100.7:1080 u p p "abcde::1"
    expect_add_failure "password that is not UTF-8" 198.51.100.7:1080 u $'ab\xffcd' $'ab\xffcd' ""
    expect_add_failure "user name that is not UTF-8" 198.51.100.7:1080 $'u\xfe' p p ""
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
    assert_no_system_changes
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

@test "special-character passwords round-trip through .env into config.json and never reach output or logs" {
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
        # .env holds it as plain text in the quoted one-line form...
        grep -qxF -- "ISP_SOCKS_PASS=$(env_expect_quoted "$pw")" "$PROJECT/.env"
        [ "$(grep -c '^ISP_SOCKS_PASS=' "$PROJECT/.env")" -eq 1 ]
        [ "$(wc -l < "$PROJECT/.env")" -eq "$(( $(wc -l < "$BATS_TEST_TMPDIR/orig.env") + 6 ))" ]
        [ "$(stat -c %a "$PROJECT/.env")" = 600 ]
        # ...that the script reads back to the exact password
        read_back_pass "$PROJECT/.env"
        [ "$READ_BACK" = "$pw" ]
        # ...and that gen-config.sh / conf-clash.sh accept without rendering it
        ( cd "$PROJECT" && mkdir -p "$BATS_TEST_TMPDIR/chk" && cp -r scripts templates .env "$BATS_TEST_TMPDIR/chk/" \
            && cd "$BATS_TEST_TMPDIR/chk" && bash scripts/gen-config.sh >/dev/null && bash scripts/conf-clash.sh >/dev/null \
            && ! grep -qF -- "$pw" config.json clash.yaml )
        rm -rf "$BATS_TEST_TMPDIR/chk"
        # Docker Compose (which also parses .env) sees the exact value, with no warning or error
        compose_sees_pass "$pw"
        # curl got a correctly quoted value on stdin
        local esc=${pw//\\/\\\\}
        esc=${esc//\"/\\\"}
        grep -qF -- "proxy-user = \"$user:$esc\"" "$STUB_STATE/last-curl-config"
        # never in the output, in any command line (stub log), or in clash.yaml (it is only in .env)
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

@test "special-character: a re-run keeps the stored credentials without prompting for them" {
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

# ---------------------------------------------------------------- preflight errors

make_min_path() {
    MINBIN="$BATS_TEST_TMPDIR/minbin"
    mkdir -p "$MINBIN"
    local t p
    for t in bash env flock mktemp cmp date tr grep find sort rm mv cp chmod chown mkdir \
             basename dirname cat head tail sed awk wc cut stat ls tee readlink realpath uniq \
             touch ln diff sha256sum xargs printf true false test dd od hostname uname iconv; do
        p=$(command -v "$t" 2>/dev/null || true)
        [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" "$MINBIN/$t"
    done
    true
}

@test "jq missing: fails early with a clear error, installs nothing, writes nothing (add, remove, menu)" {
    make_min_path
    [ ! -e "$STUB_DIR/jq" ]
    export PATH="$STUB_DIR:$MINBIN"
    ISP_SPLIT=1 isp_add_fresh
    [ "$status" -eq 1 ]
    [[ "$(cat "$ISP_ERR")" == *"jq is not installed"* ]]
    [[ "$(cat "$ISP_ERR")" == *"Run scripts/init.sh"* ]]
    [[ "$(cat "$ISP_ERR")" == *"install jq"* ]]
    isp_remove
    [ "$status" -eq 1 ]
    [[ "$output" == *"jq is not installed"* ]]
    isp_stdin 1
    isp_run
    [ "$status" -eq 1 ]
    [[ "$output" == *"jq is not installed"* ]]
    assert_nothing_written
    assert_no_system_changes
    # it failed before even looking at docker
    refute grep -q '^docker' "$STUB_LOG"
}

@test "docker permission denied: fails early on stderr with both remedies, writes nothing (add, remove, menu)" {
    isp_switch docker_denied
    ISP_SPLIT=1 isp_add_fresh
    [ "$status" -eq 1 ]
    local err
    err=$(cat "$ISP_ERR")
    [[ "$err" == *"permission denied while talking to the Docker daemon"* ]]
    [[ "$err" == *"Nothing was changed"* ]]
    [[ "$err" == *"run this script with sudo:  sudo bash scripts/isp-outbound.sh --add"* ]]
    [[ "$err" == *'sudo usermod -aG docker "$USER"'* ]]
    [[ "$err" == *"log out and back in"* ]]
    [ -z "$output" ]
    ISP_SPLIT=1 isp_remove
    [ "$status" -eq 1 ]
    [[ "$(cat "$ISP_ERR")" == *"sudo bash scripts/isp-outbound.sh --remove"* ]]
    isp_stdin 1
    isp_run
    [ "$status" -eq 1 ]
    [[ "$output" == *"permission denied while talking to the Docker daemon"* ]]
    [[ "$output" != *"Choose"* ]]
    assert_nothing_written
    assert_no_system_changes
    [ "$(up_count)" -eq 0 ]
    refute grep -q '^docker run' "$STUB_LOG"
}

@test "docker not running: fails early with its own message, writes nothing" {
    isp_switch docker_down
    isp_add_fresh
    [ "$status" -eq 1 ]
    [[ "$output" == *"Docker daemon is not running"* ]]
    [[ "$output" != *"permission denied"* ]]
    assert_nothing_written
}

@test "project directory not writable: fails early with a clear error, writes nothing" {
    if [ "$EUID" -eq 0 ]; then
        skip "root ignores directory permissions"
    fi
    chmod a-w "$PROJECT"
    isp_add_fresh
    chmod u+w "$PROJECT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"No permission to write in"* ]]
    [[ "$output" == *"Nothing was changed"* ]]
    assert_nothing_written
    [ "$(up_count)" -eq 0 ]
}

@test "config.json not writable: fails early with a clear error, writes nothing" {
    if [ "$EUID" -eq 0 ]; then
        skip "root ignores file permissions"
    fi
    chmod a-w "$PROJECT/config.json"
    cp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/orig.json"
    isp_add_fresh
    chmod u+w "$PROJECT/config.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"No permission to read and write"* ]]
    assert_nothing_written
}

# ---------------------------------------------------------------- port notices

# The notices go to stdout; everything else (prompts, warnings) to stderr.
assert_add_notice() {
    local out=$1
    [[ "$out" == *"ACTION REQUIRED: allow these ports yourself. This script does not open any port."* ]]
    [[ "$out" == *"13839/tcp  (ss-isp-in, Shadowsocks)"* ]]
    [[ "$out" == *"13839/udp  (ss-isp-in, Shadowsocks)"* ]]
    [[ "$out" == *"18444/tcp  (vless-reality-isp-in, VLESS Reality)"* ]]
    [[ "$out" == *"BOTH places"* ]]
    [[ "$out" == *"the local firewall on this server"* ]]
    [[ "$out" == *"cloud provider's security group"* ]]
    [[ "$out" == *"Ports 8388 and 8443 are not affected"* ]]
    # reference commands, per backend, with the real ports and protocols
    [[ "$out" == *"ufw allow 13839/tcp"* ]]
    [[ "$out" == *"ufw allow 13839/udp"* ]]
    [[ "$out" == *"ufw allow 18444/tcp"* ]]
    [[ "$out" == *"firewall-cmd --permanent --add-port=13839/tcp"* ]]
    [[ "$out" == *"firewall-cmd --permanent --add-port=13839/udp"* ]]
    [[ "$out" == *"firewall-cmd --permanent --add-port=18444/tcp"* ]]
    [[ "$out" == *"firewall-cmd --reload"* ]]
    [[ "$out" == *"iptables -I INPUT -p tcp --dport 13839 -j ACCEPT"* ]]
    [[ "$out" == *"iptables -I INPUT -p udp --dport 13839 -j ACCEPT"* ]]
    [[ "$out" == *"iptables -I INPUT -p tcp --dport 18444 -j ACCEPT"* ]]
    [[ "$out" == *"netfilter-persistent save"* ]]
    [[ "$out" == *"iptables-save > /etc/iptables/rules.v4"* ]]
    [[ "$out" == *"whole current iptables ruleset"* ]]
}

assert_remove_notice() {
    local out=$1
    [[ "$out" == *"NOTE: the ISP ports are no longer used, so you can now close them yourself. This script does not close any port."* ]]
    [[ "$out" == *"13839/tcp"* && "$out" == *"13839/udp"* && "$out" == *"18444/tcp"* ]]
    [[ "$out" == *"BOTH places"* ]]
    [[ "$out" == *"cloud provider's security group"* ]]
    [[ "$out" == *"also removes a rule you added yourself for the same port"* ]]
    [[ "$out" == *"ufw delete allow 13839/tcp"* ]]
    [[ "$out" == *"ufw delete allow 13839/udp"* ]]
    [[ "$out" == *"ufw delete allow 18444/tcp"* ]]
    [[ "$out" == *"firewall-cmd --permanent --remove-port=13839/tcp"* ]]
    [[ "$out" == *"firewall-cmd --permanent --remove-port=13839/udp"* ]]
    [[ "$out" == *"firewall-cmd --permanent --remove-port=18444/tcp"* ]]
    [[ "$out" == *"iptables -D INPUT -p tcp --dport 13839 -j ACCEPT"* ]]
    [[ "$out" == *"iptables -D INPUT -p udp --dport 13839 -j ACCEPT"* ]]
    [[ "$out" == *"iptables -D INPUT -p tcp --dport 18444 -j ACCEPT"* ]]
    [[ "$out" == *"netfilter-persistent save"* ]]
}

@test "notice: a successful add prints the complete allow-the-ports notice on stdout" {
    ISP_SPLIT=1 isp_add_fresh
    [ "$status" -eq 0 ]
    assert_add_notice "$output"
    [[ "$(cat "$ISP_ERR")" != *"ACTION REQUIRED"* ]]
    refute grep -qF "$ISP_PASS_FIXTURE" <<< "$output"
    # it is the last thing printed, after the success line
    [[ "$output" == *"ISP outbound is active"*"ACTION REQUIRED"* ]]
    assert_no_system_changes
}

@test "notice: a no-change re-run of add prints it again" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    ISP_SPLIT=1 isp_add_keep
    [ "$status" -eq 0 ]
    assert_add_notice "$output"
}

@test "notice: a successful remove prints the ports-can-be-closed note" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    ISP_SPLIT=1 isp_remove
    [ "$status" -eq 0 ]
    assert_remove_notice "$output"
    [[ "$output" != *"ACTION REQUIRED"* ]]
    assert_original_files
    assert_no_system_changes
}

@test "notice: remove with nothing configured still prints the note" {
    isp_remove
    [ "$status" -eq 0 ]
    assert_remove_notice "$output"
}

@test "notice: not printed when the add fails, is declined or is rolled back" {
    isp_switch break_isp
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" != *"ACTION REQUIRED"* ]]
    reset_isp_env
    isp_stdin "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" "$ISP_PASS_FIXTURE" "" n
    isp_run --add
    [ "$status" -ne 0 ]
    [[ "$output" != *"ACTION REQUIRED"* ]]
    reset_isp_env
    isp_switch fail_check
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" != *"ACTION REQUIRED"* ]]
}

@test "notice: not printed when a remove is rolled back" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_switch break_clean
    isp_remove
    [ "$status" -ne 0 ]
    [[ "$output" != *"no longer used"* ]]
}

@test "no firewall is touched, nothing is installed and sudo is never called, in any flow" {
    isp_add_fresh
    assert_no_system_changes
    isp_add_keep
    assert_no_system_changes
    isp_remove
    assert_no_system_changes
    isp_remove
    assert_no_system_changes
    isp_switch break_isp
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"Rolling back"* ]]
    assert_no_system_changes
}

# ---------------------------------------------------------------- temp files

@test "temp files: nothing is left behind after answering n to the restart prompt" {
    isp_stdin "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" "$ISP_PASS_FIXTURE" "$ISP_PASS_FIXTURE" "" n
    isp_run --add
    [ "$status" -ne 0 ]
    [[ "$output" == *"Aborted"* ]]
    assert_no_tmp
    assert_original_files
}

@test "temp files: nothing is left behind after answering n to the restart prompt of --remove" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_stdin n
    isp_run --remove
    [ "$status" -ne 0 ]
    assert_no_tmp
}

@test "temp files: nothing is left behind after a rollback" {
    isp_switch break_isp
    isp_add_fresh
    [ "$status" -ne 0 ]
    [[ "$output" == *"Rolling back"* ]]
    assert_no_tmp
    assert_original_files
}

@test "temp files: nothing is left behind after a successful add, a no-op add and a remove" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    assert_no_tmp
    isp_add_keep
    assert_no_tmp
    isp_remove
    assert_no_tmp
}

@test "temp files: leftovers from an older run are swept at the start of the next run" {
    printf 'ISP_SOCKS_PASS="old"\n' > "$PROJECT/.isp-tmp.stale1"
    printf 'plaintext\n' > "$PROJECT/.isp-tmp.stale2"
    isp_add_fresh
    [ "$status" -eq 0 ]
    assert_no_tmp
}

# ---------------------------------------------------------------- unhealthy re-run

@test "add again with the ISP config present but the service on the old config: restarts once, verifies, then succeeds" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    printf 'tcp 8388\nudp 8388\ntcp 8443\n' > "$STUB_STATE/listeners"
    : > "$STUB_LOG"
    isp_add_keep
    [ "$status" -eq 0 ]
    grep -q 'Restarting' <<< "$output"
    [ "$(up_count)" -eq 1 ]
    grep -qx 'tcp 13839' "$STUB_STATE/listeners"
}

@test "add again with the ISP config present and the service still unhealthy after one restart: exit non-zero, nothing reported active, no system change" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    cp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/cfg.after-add"
    cp "$PROJECT/.env" "$BATS_TEST_TMPDIR/env.after-add"
    isp_switch break_isp
    printf 'tcp 8388\nudp 8388\ntcp 8443\n' > "$STUB_STATE/listeners"
    : > "$STUB_LOG"
    isp_add_keep
    [ "$status" -ne 0 ]
    [[ "$output" == *"still does not run the ISP outbound"* ]]
    [[ "$output" != *"ISP outbound is active"* ]]
    [ "$(up_count)" -eq 1 ]
    assert_no_system_changes
    assert_no_tmp
    [ "$(backup_count)" -eq 1 ]
    cmp "$PROJECT/config.json" "$BATS_TEST_TMPDIR/cfg.after-add"
    cmp "$PROJECT/.env" "$BATS_TEST_TMPDIR/env.after-add"
}

@test "add again, unhealthy, answering n to the restart question: nothing changes" {
    isp_add_fresh
    [ "$status" -eq 0 ]
    printf 'tcp 8388\nudp 8388\ntcp 8443\n' > "$STUB_STATE/listeners"
    : > "$STUB_LOG"
    isp_stdin "" "" "" "" n
    isp_run --add
    [ "$status" -ne 0 ]
    [[ "$output" == *"Aborted"* ]]
    [ "$(up_count)" -eq 0 ]
    assert_no_tmp
}

# ---------------------------------------------------------------- signals

@test "signal: SIGTERM after config.json was replaced but before the service is verified rolls everything back" {
    isp_switch term_on_up
    isp_add_fresh
    [ "$status" -eq 143 ]
    [[ "$output" == *"Interrupted by TERM"* ]]
    [[ "$output" == *"Rolling back"* ]]
    assert_original_files
    assert_no_tmp
    [ "$(up_count)" -eq 2 ]
    [ "$(cat "$STUB_STATE/listeners")" = "$(printf 'tcp 8388\nudp 8388\ntcp 8443')" ]
    refute grep -q isp-socks "$PROJECT/config.json"
}

# ---------------------------------------------------------------- validation details

# The address and egress-IP checks use is_ipv6; load just that function.
load_is_ipv6() {
    # shellcheck disable=SC1090
    source <(sed -n '/^is_ipv6() {/,/^}/p' "$REPO_ROOT/scripts/isp-outbound.sh")
}

@test "is_ipv6: accepts well-formed addresses" {
    load_is_ipv6
    local a
    for a in ::1 :: 2001:db8::1 fe80::1 1:2:3:4:5:6:7:8 1:2:3:4:5:6:7:: ::2:3:4:5:6:7:8 1::8 ABCD:ef01::1 0:0:0:0:0:0:0:1; do
        is_ipv6 "$a" || { echo "should accept: $a" >&2; return 1; }
    done
}

@test "is_ipv6: rejects 1:2:3, abcde::1 and other malformed input" {
    load_is_ipv6
    local a
    for a in 1:2:3 abcde::1 :1:2 1:2: 1::2::3 1:::2 12345::1 1:2:3:4:5:6:7 1:2:3:4:5:6:7:8:9 1:2:3:4:5:6:7:8:: ::1:2:3:4:5:6:7:8 \
             :1:2:3:4:5:6:7 1:2:3:4:5:6:7: g::1 ::ffff:1.2.3.4 fe80::1%eth0 "" : 1.2.3.4; do
        if is_ipv6 "$a"; then echo "should reject: '$a'" >&2; return 1; fi
    done
}

@test "password and user name must be valid UTF-8: refused before anything is written" {
    isp_stdin "$ISP_ADDR_FIXTURE" "$ISP_USER_FIXTURE" $'ab\xffcd' $'ab\xffcd' ""
    isp_run --add --yes
    [ "$status" -ne 0 ]
    [[ "$output" == *"UTF-8"* ]]
    assert_original_files
    assert_no_tmp
    refute grep -q '^docker run' "$STUB_LOG"
    refute test -d "$PROJECT/.isp-backup"
}

@test "a valid multi-byte UTF-8 password is accepted" {
    isp_add_fresh "" "" "pässwörd-密码"
    [ "$status" -eq 0 ]
    jq -e '.outbounds[] | select(.tag=="isp-socks") | .password == "pässwörd-密码"' "$PROJECT/config.json"
}

# ---------------------------------------------------------------- missing trailing newline

@test "add then remove is byte-exact even when .env and clash.yaml have no trailing newline" {
    head -c -1 "$PROJECT/.env" > "$PROJECT/.env.x" && mv "$PROJECT/.env.x" "$PROJECT/.env"
    head -c -1 "$PROJECT/clash.yaml" > "$PROJECT/clash.yaml.x" && mv "$PROJECT/clash.yaml.x" "$PROJECT/clash.yaml"
    chmod 600 "$PROJECT/.env" "$PROJECT/clash.yaml"
    [ -n "$(tail -c1 "$PROJECT/.env")" ]
    [ -n "$(tail -c1 "$PROJECT/clash.yaml")" ]
    cp "$PROJECT/.env" "$BATS_TEST_TMPDIR/orig.env"
    cp "$PROJECT/clash.yaml" "$BATS_TEST_TMPDIR/orig.yaml"
    isp_add_fresh
    [ "$status" -eq 0 ]
    # a second add with the same values is stable
    local before
    before=$(isp_snapshot)
    isp_add_keep
    [ "$status" -eq 0 ]
    [ "$(isp_snapshot)" = "$before" ]
    [ "$(backup_count)" -eq 1 ]
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
}

@test "add then remove is byte-exact for a .env with trailing blank lines" {
    printf '\n\n' >> "$PROJECT/.env"
    cp "$PROJECT/.env" "$BATS_TEST_TMPDIR/orig.env"
    isp_add_fresh
    [ "$status" -eq 0 ]
    isp_remove
    [ "$status" -eq 0 ]
    assert_original_files
}
