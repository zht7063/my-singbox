# Helpers for tests/isp-outbound.bats. Load with: load isp-helpers
#
# Everything external to the script is a PATH stub driven by files in
# $STUB_STATE, so the tests never touch Docker, a real firewall or the network:
#
#   docker, curl, ss, id, sleep, apt-get, ufw, firewall-cmd, iptables, ip6tables,
#   debconf-set-selections
#
# Failure switches (create the file to turn it on):
#   fail_check       docker run ... check fails (candidate config rejected)
#   break_isp        container crashes when started with the ISP config
#   break_clean      container crashes when started without the ISP config
#   fail_up_isp      compose up fails when the config has the ISP outbound
#   fail_exec_check  sing-box check inside the container fails
#   docker_down      docker info fails
#   no_container     the sing-box container does not exist
#   fail_curl        every curl call fails
#   term_on_up       compose up with the ISP config sends SIGTERM to the script
#                    (the container keeps running the old config)
# Value files: uid (default 0), egress_ip (default 198.51.100.7), backend
# (none|ufw|firewalld|iptables), fail_fw (a command name that must fail),
# fail_fw_rule (optional PORT/PROTO: only that rule fails; default all rules).
# A failing firewall stub prints "stub-<name>: ... " on stderr.

load helpers

ISP_ADDR_FIXTURE="198.51.100.7:1080"
ISP_USER_FIXTURE="isp-user"
ISP_PASS_FIXTURE="S3cret-pass"

# Write one stub script. Usage: write_stub NAME  (body on stdin)
write_stub() {
    cat > "$STUB_DIR/$1"
    chmod +x "$STUB_DIR/$1"
}

install_isp_stubs() {
    REAL_JQ="$(command -v jq)"
    export REAL_JQ STUB_STATE STUB_DIR

    write_stub id <<'STUB'
#!/usr/bin/env bash
echo "id $*" >> "$STUB_LOG"
if [[ "$*" == "-u" ]]; then
    cat "$STUB_STATE/uid" 2>/dev/null || echo 0
else
    exec /usr/bin/id "$@"
fi
STUB

    write_stub sleep <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

    write_stub curl <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
cat > "$STUB_STATE/last-curl-config"
cat "$STUB_STATE/last-curl-config" >> "$STUB_STATE/all-curl-configs"
[[ -e "$STUB_STATE/fail_curl" ]] && exit 7
cat "$STUB_STATE/egress_ip" 2>/dev/null || echo 198.51.100.7
STUB

    write_stub ss <<'STUB'
#!/usr/bin/env bash
echo "ss $*" >> "$STUB_LOG"
case "$*" in
    *-ltn*) proto=tcp; state=LISTEN ;;
    *-lun*) proto=udp; state=UNCONN ;;
    *) exit 0 ;;
esac
while read -r p port; do
    [[ "$p" == "$proto" ]] && echo "$state 0 4096 0.0.0.0:$port 0.0.0.0:*"
done < "$STUB_STATE/listeners"
exit 0
STUB

    write_stub docker <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
S="$STUB_STATE"
case "$1" in
    info)
        [[ -e "$S/docker_down" ]] && exit 1
        exit 0 ;;
    inspect)
        case "$*" in
            *Config.Image*)
                [[ -e "$S/no_container" ]] && exit 1
                echo "ghcr.io/sagernet/sing-box:stub" ;;
            *State.Status*)
                cat "$S/status" 2>/dev/null || echo running ;;
        esac
        exit 0 ;;
    run)
        if [[ -e "$S/fail_check" ]]; then
            echo "FATAL[0000] stub: config check failed" >&2
            exit 1
        fi
        for a in "$@"; do
            if [[ "$a" == *:/etc/sing-box/config.json:ro ]]; then
                cp "${a%%:*}" "$S/last-check-config"
            fi
        done
        exit 0 ;;
    compose)
        shift
        proj=""
        if [[ "$1" == "--project-directory" ]]; then
            proj=$2
            shift 2
        fi
        case "$1" in
            version) echo "Docker Compose version v2.0.0-stub"; exit 0 ;;
            logs) echo "stub container logs"; exit 0 ;;
            exec)
                [[ -e "$S/fail_exec_check" ]] && exit 1
                [[ "$(cat "$S/status" 2>/dev/null || echo running)" == running ]] || exit 1
                exit 0 ;;
            up)
                if grep -q isp-socks "$proj/config.json"; then
                    [[ -e "$S/fail_up_isp" ]] && exit 1
                    if [[ -e "$S/term_on_up" ]]; then
                        kill -TERM "$PPID"
                        exit 0
                    fi
                    if [[ -e "$S/break_isp" ]]; then
                        echo exited > "$S/status"
                        : > "$S/listeners"
                        exit 0
                    fi
                    printf 'tcp 8388\nudp 8388\ntcp 8443\ntcp 13839\nudp 13839\ntcp 18444\n' > "$S/listeners"
                else
                    if [[ -e "$S/break_clean" ]]; then
                        echo exited > "$S/status"
                        : > "$S/listeners"
                        exit 0
                    fi
                    printf 'tcp 8388\nudp 8388\ntcp 8443\n' > "$S/listeners"
                fi
                echo running > "$S/status"
                exit 0 ;;
        esac ;;
esac
exit 0
STUB

    write_stub apt-get <<'STUB'
#!/usr/bin/env bash
echo "apt-get $*" >> "$STUB_LOG"
[[ -e "$STUB_STATE/fail_apt" ]] && exit 100
case "$*" in
    *install*jq*) ln -sf "$REAL_JQ" "$STUB_DIR/jq" ;;
esac
case "$*" in
    *install*netfilter-persistent*)
        printf '#!/usr/bin/env bash\necho "netfilter-persistent $*" >> "$STUB_LOG"\nexit 0\n' > "$STUB_DIR/netfilter-persistent"
        chmod +x "$STUB_DIR/netfilter-persistent" ;;
esac
exit 0
STUB

    write_stub debconf-set-selections <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
echo "debconf-set-selections $*" >> "$STUB_LOG"
exit 0
STUB

    write_stub ufw <<'STUB'
#!/usr/bin/env bash
echo "ufw $*" >> "$STUB_LOG"
if [[ "$1" == status ]]; then
    if [[ "$(cat "$STUB_STATE/backend")" == ufw ]]; then echo "Status: active"; else echo "Status: inactive"; fi
    exit 0
fi
if [[ "$(cat "$STUB_STATE/fail_fw" 2>/dev/null)" == ufw ]]; then
    rule=$2
    [[ "$1" == delete ]] && rule=$3
    only=$(cat "$STUB_STATE/fail_fw_rule" 2>/dev/null || true)
    if [[ -z "$only" || "$only" == "$rule" ]]; then
        echo "stub-ufw: ERROR: could not update rules for $rule" >&2
        exit 1
    fi
fi
exit 0
STUB

    write_stub firewall-cmd <<'STUB'
#!/usr/bin/env bash
echo "firewall-cmd $*" >> "$STUB_LOG"
S="$STUB_STATE"
if [[ "$1" == --state ]]; then
    if [[ "$(cat "$S/backend")" == firewalld ]]; then echo running; exit 0; fi
    echo "not running"; exit 252
fi
if [[ "$(cat "$S/fail_fw" 2>/dev/null)" == firewall-cmd ]]; then
    case "$*" in
        *--add-port=*|*--remove-port=*)
            rule=${*##*-port=}
            rule=${rule%% *}
            only=$(cat "$S/fail_fw_rule" 2>/dev/null || true)
            if [[ -z "$only" || "$only" == "$rule" ]]; then
                echo "stub-firewalld: Error: COMMAND_FAILED: could not change $rule" >&2
                exit 1
            fi ;;
    esac
fi
scope=run
args=()
for a in "$@"; do
    if [[ "$a" == --permanent ]]; then scope=perm; else args+=("$a"); fi
done
case "${args[0]}" in
    --query-port=*) grep -qxF "$scope:${args[0]#--query-port=}" "$S/firewalld_ports" ;;
    --add-port=*) echo "$scope:${args[0]#--add-port=}" >> "$S/firewalld_ports" ;;
    --remove-port=*) grep -vxF "$scope:${args[0]#--remove-port=}" "$S/firewalld_ports" > "$S/fwd.tmp" || true; mv "$S/fwd.tmp" "$S/firewalld_ports" ;;
esac
STUB

    write_stub iptables <<'STUB'
#!/usr/bin/env bash
echo "iptables $*" >> "$STUB_LOG"
S="$STUB_STATE"
rules="$S/ipt_rules"
key() { printf '%s %s' "$1" "$2"; }   # proto port
case "$1" in
    -S)
        if [[ "$(cat "$S/backend")" == iptables ]]; then
            echo "-P INPUT DROP"
            cat "$rules"
        else
            echo "-P INPUT ACCEPT"
        fi
        exit 0 ;;
    -C|-I|-D)
        mode=$1
        proto=""; port=""
        while (($#)); do
            case "$1" in
                -p) proto=$2; shift ;;
                --dport) port=$2; shift ;;
            esac
            shift
        done
        if [[ "$mode" != -C && "$(cat "$S/fail_fw" 2>/dev/null)" == iptables ]]; then
            only=$(cat "$S/fail_fw_rule" 2>/dev/null || true)
            if [[ -z "$only" || "$only" == "$port/$proto" ]]; then
                echo "stub-iptables: iptables: Resource temporarily unavailable ($port/$proto)" >&2
                exit 1
            fi
        fi
        line="-A INPUT -p $proto --dport $port -m comment --comment my-singbox-isp -j ACCEPT"
        case "$mode" in
            -C) grep -qxF -- "$line" "$rules" ;;
            -I) echo "$line" >> "$rules" ;;
            -D) grep -vxF -- "$line" "$rules" > "$S/ipt.tmp" || true; mv "$S/ipt.tmp" "$rules" ;;
        esac
        exit $? ;;
esac
exit 0
STUB

    write_stub ip6tables <<'STUB'
#!/usr/bin/env bash
echo "ip6tables $*" >> "$STUB_LOG"
[[ "$1" == -S ]] && echo "-P INPUT ACCEPT"
[[ "$1" == -C ]] && exit 1
exit 0
STUB
}

# setup_isp_env [config-modifier-jq-filter]
# Fresh project with generated config.json/clash.yaml and the stubs installed.
setup_isp_env() {
    setup_project
    STUB_STATE="$BATS_TEST_TMPDIR/state"
    mkdir -p "$STUB_STATE"
    write_env
    ( cd "$PROJECT" && bash scripts/gen-config.sh >/dev/null && bash scripts/conf-clash.sh >/dev/null )
    if [[ -n "${1:-}" ]]; then
        jq "$1" "$PROJECT/config.json" > "$PROJECT/config.json.mod"
        mv "$PROJECT/config.json.mod" "$PROJECT/config.json"
        chmod 600 "$PROJECT/config.json"
    fi
    printf 'tcp 8388\nudp 8388\ntcp 8443\n' > "$STUB_STATE/listeners"
    echo running > "$STUB_STATE/status"
    echo none > "$STUB_STATE/backend"
    : > "$STUB_STATE/ipt_rules"
    : > "$STUB_STATE/firewalld_ports"
    install_isp_stubs
    ISP="$PROJECT/scripts/isp-outbound.sh"
    export STUB_STATE
}

# reset_isp_env: throw the project and stubs away and start over.
reset_isp_env() {
    rm -rf "$PROJECT" "$STUB_DIR" "$STUB_STATE"
    setup_isp_env "$@"
}

# State switches.
isp_switch() { : > "$STUB_STATE/$1"; }
isp_unswitch() { rm -f "$STUB_STATE/$1"; }
isp_set() { printf '%s\n' "$2" > "$STUB_STATE/$1"; }

# Hash of the three managed files plus the service state, to prove "nothing written".
isp_snapshot() {
    local f
    for f in config.json clash.yaml .env; do
        if [[ -f "$PROJECT/$f" ]]; then
            printf '%s %s\n' "$f" "$(sha256sum < "$PROJECT/$f" | cut -d' ' -f1)"
        else
            printf '%s absent\n' "$f"
        fi
    done
    cat "$STUB_STATE/listeners"
}

# isp_stdin LINE...: use these lines as the script's standard input.
isp_stdin() {
    ISP_STDIN="$BATS_TEST_TMPDIR/stdin.$RANDOM"
    printf '%s\n' "$@" > "$ISP_STDIN"
}

# isp_run ARGS...: run isp-outbound.sh with standard input from $ISP_STDIN.
# With ISP_SPLIT=1, stderr goes to the file $ISP_ERR and $output holds stdout only.
isp_run() {
    if [[ -n "${ISP_SPLIT:-}" ]]; then
        ISP_ERR="$BATS_TEST_TMPDIR/stderr.txt"
        export ISP_ERR
        run bash -c 'exec bash "$@" 2>"$ISP_ERR"' _ "$ISP" "$@" < "${ISP_STDIN:-/dev/null}"
    else
        run bash "$ISP" "$@" < "${ISP_STDIN:-/dev/null}"
    fi
}

# isp_add_fresh [ADDR USER PASS EGRESS]: first-time Add (prompts: address,
# user, password twice, expected egress IP).
isp_add_fresh() {
    local addr=${1:-$ISP_ADDR_FIXTURE} user=${2:-$ISP_USER_FIXTURE} pass=${3:-$ISP_PASS_FIXTURE} egress=${4:-}
    isp_stdin "$addr" "$user" "$pass" "$pass" "$egress"
    isp_run --add --yes
}

# isp_add_keep: re-run Add, keeping every stored value (blank answers).
isp_add_keep() {
    isp_stdin "" "" "" ""
    isp_run --add --yes
}

isp_remove() {
    ISP_STDIN=""
    isp_run --remove --yes
}
