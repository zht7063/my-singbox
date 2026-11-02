# Helpers for tests/isp-outbound.bats. Load with: load isp-helpers
#
# Everything external to the script is a PATH stub driven by files in
# $STUB_STATE, so the tests never touch Docker, a real firewall or the network:
#
#   docker, curl, ss, sleep
# plus tripwires that only log their call and succeed: apt-get, sudo, ufw,
# firewall-cmd, iptables, ip6tables, netfilter-persistent, debconf-set-selections.
# isp-outbound.sh must never call them (see assert_no_system_changes).
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
#   docker_denied    docker info fails with "permission denied" (socket not accessible)
# Value files: egress_ip (default 198.51.100.7).

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
# Emit one small write: grep -q may close the pipe after the first match,
# and per-listener writes would turn that success into SIGPIPE under pipefail.
listener_output=''
while read -r p port; do
    if [[ "$p" == "$proto" ]]; then
        listener_output+="$state 0 4096 0.0.0.0:$port 0.0.0.0:*"$'\n'
    fi
done < "$STUB_STATE/listeners"
printf '%s' "$listener_output"
exit 0
STUB

    write_stub docker <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
S="$STUB_STATE"
case "$1" in
    info)
        if [[ -e "$S/docker_denied" ]]; then
            echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info\": dial unix /var/run/docker.sock: connect: permission denied" >&2
            exit 1
        fi
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

    # Tripwires: the script must never install anything, use sudo or touch a firewall.
    local t
    for t in apt-get sudo ufw firewall-cmd iptables ip6tables netfilter-persistent debconf-set-selections; do
        write_stub "$t" <<'STUB'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_LOG"
exit 0
STUB
    done
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
