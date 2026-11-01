#!/usr/bin/env bash
# Optional: add or remove an ISP (static SOCKS5) egress for two extra ports.
#
#   sudo bash scripts/isp-outbound.sh            interactive menu
#   sudo bash scripts/isp-outbound.sh --add      add or update the ISP outbound
#   sudo bash scripts/isp-outbound.sh --remove   remove everything this script added
#   --yes / -y skips the restart confirmation.
#
# Adds sing-box inbounds ss-isp-in (13839) and vless-reality-isp-in (18444),
# cloned from ss-in and vless-reality-in, whose traffic leaves through the
# SOCKS5 proxy. The original ports 8388 and 8443 keep going out directly.
# Optional: nothing else depends on this script.
set -euo pipefail
umask 077

# Project paths
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="$PROJECT_DIR/config.json"
CLASH_FILE="$PROJECT_DIR/clash.yaml"
ENV_FILE="$PROJECT_DIR/.env"
BACKUP_ROOT="$PROJECT_DIR/.isp-backup"
LOCK_FILE="$PROJECT_DIR/.isp.lock"
CONTAINER_NAME="sing-box"
CONTAINER_CONFIG="/etc/sing-box/config.json"

# Fixed identifiers
SS_PORT=8388
VLESS_PORT=8443
SS_ISP_PORT=13839
VLESS_ISP_PORT=18444
SS_ISP_TAG="ss-isp-in"
VLESS_ISP_TAG="vless-reality-isp-in"
OUT_TAG="isp-socks"
FW_COMMENT="my-singbox-isp"
FW_RULES=("${SS_ISP_PORT}/tcp" "${SS_ISP_PORT}/udp" "${VLESS_ISP_PORT}/tcp")
MARK_BEGIN="# BEGIN my-singbox-isp"
MARK_END="# END my-singbox-isp"
ENV_HEADER="# ISP outbound (managed by scripts/isp-outbound.sh)"
ENV_KEY_RE='^(ISP_SOCKS_ADDR|ISP_SOCKS_USER|ISP_SOCKS_PASS|ISP_SOCKS_EGRESS_IP)='
NODE_SS="shadowsocks"
NODE_VLESS="vless-reality"
GROUP_ISP="Proxy-ISP"

# Mutable state
ASSUME_YES=0
ACTION=""
BACKUP_DIR=""
TMP_FILES=()
FW_FAILED=()
IMAGE=""

die() {
    echo "Error: $*" >&2
    exit 1
}

warn() {
    echo "Warning: $*" >&2
}

info() {
    echo "$*"
}

usage() {
    cat <<'USAGE'
Usage: sudo bash scripts/isp-outbound.sh [--add | --remove] [--yes]

  --add      add or update the ISP outbound (ports 13839 and 18444)
  --remove   remove the ISP outbound and everything this script added
  --yes, -y  do not ask before restarting sing-box
  --help     show this help

Without --add or --remove, a menu is shown.
USAGE
}

cleanup() {
    local f
    for f in "${TMP_FILES[@]+"${TMP_FILES[@]}"}"; do
        rm -f -- "$f"
    done
}
trap cleanup EXIT

mktmp() {
    local f
    f="$(mktemp "$PROJECT_DIR/.isp-tmp.XXXXXX")"
    TMP_FILES+=("$f")
    printf '%s' "$f"
}

compose() {
    docker compose --project-directory "$PROJECT_DIR" "$@"
}

# ---------------------------------------------------------------------------
# Checks and prompts
# ---------------------------------------------------------------------------

require_root() {
    if [[ "$(id -u)" -ne 0 ]]; then
        die "This script must run as root. Re-run with: sudo bash scripts/isp-outbound.sh"
    fi
}

ensure_jq() {
    if command -v jq >/dev/null 2>&1; then
        return 0
    fi
    info "jq is not installed. Installing it with apt-get..."
    command -v apt-get >/dev/null 2>&1 || die "jq is missing and apt-get is not available. Install jq and re-run."
    DEBIAN_FRONTEND=noninteractive apt-get update -qq || die "apt-get update failed."
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq || die "Failed to install jq."
    command -v jq >/dev/null 2>&1 || die "jq is still missing after installation."
}

require_commands() {
    local cmd
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed."
    done
}

ask() {
    local prompt=$1 answer
    printf '%s' "$prompt" >&2
    IFS= read -r answer || die "Input ended unexpectedly."
    printf '%s' "${answer%$'\r'}"
}

ask_secret() {
    local prompt=$1 answer
    printf '%s' "$prompt" >&2
    IFS= read -rs answer || die "Input ended unexpectedly."
    printf '\n' >&2
    printf '%s' "${answer%$'\r'}"
}

confirm_restart() {
    local answer
    if [[ "$ASSUME_YES" -eq 1 ]]; then
        return 0
    fi
    echo "This restarts sing-box. Connections on 8388 and 8443 drop for a few seconds."
    answer="$(ask "Continue? [y/N] ")"
    [[ "$answer" == y || "$answer" == Y ]] || die "Aborted. Nothing was changed."
}

is_ipv4() {
    local value=$1 octet
    [[ "$value" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    for octet in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
        if ((10#$octet > 255)); then
            return 1
        fi
        if [[ ${#octet} -gt 1 && "$octet" == 0* ]]; then
            return 1
        fi
    done
}

is_ipv6() {
    local value=$1 colons
    [[ "$value" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
    [[ "$value" == *::*::* ]] && return 1
    [[ "$value" == *:::* ]] && return 1
    colons=${value//[^:]}
    [[ ${#colons} -ge 2 && ${#colons} -le 7 ]]
}

is_ip() {
    is_ipv4 "$1" || is_ipv6 "$1"
}

trim() {
    local value=$1
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

lower() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# Parse HOST:PORT or [IPv6]:PORT into ISP_HOST, ISP_PORT. ISP_ADDR keeps the
# canonical text (with brackets for IPv6), which curl needs.
parse_addr() {
    local value=$1
    if [[ "$value" =~ ^\[([0-9A-Fa-f:]+)\]:([0-9]{1,5})$ ]]; then
        ISP_HOST="${BASH_REMATCH[1]}"
        ISP_PORT="${BASH_REMATCH[2]}"
        is_ipv6 "$ISP_HOST" || return 1
    elif [[ "$value" =~ ^([0-9.]+):([0-9]{1,5})$ ]]; then
        ISP_HOST="${BASH_REMATCH[1]}"
        ISP_PORT="${BASH_REMATCH[2]}"
        is_ipv4 "$ISP_HOST" || return 1
    else
        return 1
    fi
    ((10#$ISP_PORT >= 1 && 10#$ISP_PORT <= 65535)) || return 1
    ISP_PORT=$((10#$ISP_PORT))
    if [[ "$ISP_HOST" == *:* ]]; then
        ISP_ADDR="[${ISP_HOST}]:${ISP_PORT}"
    else
        ISP_ADDR="${ISP_HOST}:${ISP_PORT}"
    fi
}

# SOCKS5 username and password are limited to 255 bytes each (RFC 1929).
valid_cred() {
    local LC_ALL=C
    local value=$1
    [[ ${#value} -ge 1 && ${#value} -le 255 ]] || return 1
    [[ ! "$value" =~ [[:cntrl:]] ]]
}

# ---------------------------------------------------------------------------
# .env helpers (values are read, never sourced)
# ---------------------------------------------------------------------------

env_get() {
    local key=$1 line
    [[ -f "$ENV_FILE" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line=${line%$'\r'}
        if [[ "$line" =~ ^${key}=(.*)$ ]]; then
            printf '%s' "${BASH_REMATCH[1]}"
            return 0
        fi
    done < "$ENV_FILE"
}

b64_encode() {
    printf 'b64:%s' "$(printf '%s' "$1" | base64 -w0)"
}

# Decode "b64:..." to plain text. Prints nothing and fails on bad input.
b64_decode() {
    local value=$1
    [[ "$value" == b64:* ]] || return 1
    value=${value#b64:}
    [[ "$value" =~ ^[A-Za-z0-9+/]*={0,2}$ ]] || return 1
    printf '%s' "$value" | base64 -d 2>/dev/null
}

# Print .env without the keys and header this script manages.
env_without_isp() {
    local file=$1 line
    local -a kept=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$ENV_HEADER" ]]; then
            if ((${#kept[@]} > 0)) && [[ -z "${kept[${#kept[@]}-1]}" ]]; then
                unset "kept[${#kept[@]}-1]"
            fi
            continue
        fi
        if [[ "$line" =~ $ENV_KEY_RE ]]; then
            continue
        fi
        kept+=("$line")
    done < "$file"
    if ((${#kept[@]} > 0)); then
        printf '%s\n' "${kept[@]}"
    fi
}

# ---------------------------------------------------------------------------
# config.json (jq)
# ---------------------------------------------------------------------------

# Remove everything this script owns. Used by Add (before re-adding) and Remove.
readonly JQ_STRIP='
  .inbounds = ((.inbounds // []) | map(select(.tag != $ss_tag and .tag != $vl_tag)))
  | .outbounds = ((.outbounds // []) | map(select(.tag != $out_tag)))
  | if .route then .route.rules = ((.route.rules // []) | map(select(.outbound != $out_tag))) else . end
  | if ((.route.rules? // null) == []) then del(.route.rules) else . end
  | if .route == {} then del(.route) else . end
'

readonly JQ_ADD='
  (.inbounds | map(select(.tag == "ss-in"))[0]) as $ss
  | (.inbounds | map(select(.tag == "vless-reality-in"))[0]) as $vl
  | '"$JQ_STRIP"'
  | .inbounds += [
      ($ss | .tag = $ss_tag | .listen_port = $ss_port),
      ($vl | .tag = $vl_tag | .listen_port = $vl_port)
    ]
  | .outbounds += [{
      "type": "socks",
      "tag": $out_tag,
      "server": $host,
      "server_port": $port,
      "version": "5",
      "username": $user,
      "password": $pass
    }]
  | .route.rules = ((.route.rules // []) + [{"inbound": [$ss_tag, $vl_tag], "outbound": $out_tag}])
'

jq_common_args() {
    JQ_ARGS=(
        --arg ss_tag "$SS_ISP_TAG"
        --arg vl_tag "$VLESS_ISP_TAG"
        --arg out_tag "$OUT_TAG"
    )
}

# render_config_add OUTFILE: credentials reach jq through process substitution,
# never through argv or the environment.
render_config_add() {
    local out=$1
    jq_common_args
    jq "${JQ_ARGS[@]}" \
        --argjson ss_port "$SS_ISP_PORT" \
        --argjson vl_port "$VLESS_ISP_PORT" \
        --arg host "$ISP_HOST" \
        --argjson port "$ISP_PORT" \
        --rawfile user <(printf '%s' "$ISP_USER") \
        --rawfile pass <(printf '%s' "$ISP_PASS") \
        "$JQ_ADD" "$CONFIG_FILE" > "$out"
}

render_config_remove() {
    local out=$1
    jq_common_args
    jq "${JQ_ARGS[@]}" "$JQ_STRIP" "$CONFIG_FILE" > "$out"
}

config_has_isp() {
    jq -e --arg a "$SS_ISP_TAG" --arg b "$VLESS_ISP_TAG" --arg c "$OUT_TAG" \
        '[.inbounds[]?.tag, .outbounds[]?.tag] | any(. == $a or . == $b or . == $c)' \
        "$CONFIG_FILE" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# clash.yaml (text-level, marker based)
# ---------------------------------------------------------------------------

# clash_strip OUT_ARRAY IN_ARRAY: copy IN without marker blocks. Fails when
# markers are unbalanced.
clash_strip() {
    local -n _cs_out=$1
    local -n _cs_in=$2
    local line inblock=0
    _cs_out=()
    for line in "${_cs_in[@]+"${_cs_in[@]}"}"; do
        if [[ "$line" =~ ^[[:space:]]*#\ BEGIN\ my-singbox-isp[[:space:]]*$ ]]; then
            if ((inblock)); then return 1; fi
            inblock=1
            continue
        fi
        if [[ "$line" =~ ^[[:space:]]*#\ END\ my-singbox-isp[[:space:]]*$ ]]; then
            if ((inblock == 0)); then return 1; fi
            inblock=0
            continue
        fi
        if ((inblock == 0)); then
            _cs_out+=("$line")
        fi
    done
    ((inblock == 0))
}

# clash_find_top ARRAY KEY: print the index of the single top-level "KEY:" line.
clash_find_top() {
    local -n _ft_arr=$1
    local key=$2 i found=-1 count=0
    for ((i = 0; i < ${#_ft_arr[@]}; i++)); do
        if [[ "${_ft_arr[i]}" =~ ^${key}:[[:space:]]*$ ]]; then
            found=$i
            count=$((count + 1))
        fi
    done
    [[ "$count" -eq 1 ]] || return 1
    printf '%s' "$found"
}

# clash_find_node ARRAY NAME: set NODE_START and NODE_END (inclusive) for the
# proxy named NAME inside the proxies list.
clash_find_node() {
    local -n _fn_arr=$1
    local name=$2 i j count=0
    NODE_START=-1
    for ((i = 0; i < ${#_fn_arr[@]}; i++)); do
        if [[ "${_fn_arr[i]}" =~ ^\ \ -\ name:\ \"?${name}\"?[[:space:]]*$ ]]; then
            NODE_START=$i
            count=$((count + 1))
        fi
    done
    [[ "$count" -eq 1 ]] || return 1
    NODE_END=$NODE_START
    for ((j = NODE_START + 1; j < ${#_fn_arr[@]}; j++)); do
        if [[ "${_fn_arr[j]}" =~ ^[[:space:]]*$ || "${_fn_arr[j]}" =~ ^\ \ -\  || "${_fn_arr[j]}" =~ ^[^[:space:]] ]]; then
            break
        fi
        NODE_END=$j
    done
}

# clash_clone_node ARRAY OLD_NAME NEW_NAME OLD_PORT NEW_PORT: print the node
# block with only the name and port changed.
clash_clone_node() {
    local -n _cn_arr=$1
    local old=$2 new=$3 old_port=$4 new_port=$5
    local i line ports=0
    clash_find_node "$1" "$old" || return 1
    for ((i = NODE_START; i <= NODE_END; i++)); do
        line="${_cn_arr[i]}"
        if ((i == NODE_START)); then
            line="${line/"$old"/"$new"}"
        elif [[ "$line" =~ ^\ \ \ \ port:\ ([0-9]+)[[:space:]]*$ ]]; then
            [[ "${BASH_REMATCH[1]}" == "$old_port" ]] || return 1
            line="    port: ${new_port}"
            ports=$((ports + 1))
        fi
        printf '%s\n' "$line"
    done
    [[ "$ports" -eq 1 ]]
}

clash_missing_nodes_hint() {
    die "clash.yaml has no usable node named \"$NODE_SS\" and \"$NODE_VLESS\". It was probably generated by an older version (My-sing-box / My-VLESS-Reality). Delete clash.yaml, run scripts/conf-clash.sh to regenerate it, re-import it in your clients, then re-run this script."
}

# clash_render_add OUTFILE: write clash.yaml with the ISP nodes and group.
clash_render_add() {
    local out=$1
    local -a raw=() base=() nodes=() new=()
    local proxies_i groups_i rules_i node_after group_after i j
    mapfile -t raw < "$CLASH_FILE"
    clash_strip base raw || die "clash.yaml has unbalanced '$MARK_BEGIN' / '$MARK_END' markers. Fix or delete them and re-run."

    proxies_i="$(clash_find_top base proxies)" || die "clash.yaml must contain exactly one top-level 'proxies:'."
    groups_i="$(clash_find_top base proxy-groups)" || die "clash.yaml must contain exactly one top-level 'proxy-groups:'."
    rules_i="$(clash_find_top base rules)" || die "clash.yaml must contain exactly one top-level 'rules:'."
    ((proxies_i < groups_i && groups_i < rules_i)) || die "clash.yaml sections are not in the expected order (proxies, proxy-groups, rules)."

    if printf '%s\n' "${base[@]}" | grep -Eq "${NODE_SS}-isp|${NODE_VLESS}-isp|${GROUP_ISP}"; then
        die "clash.yaml already uses ISP names outside the '$MARK_BEGIN' markers. Remove them and re-run."
    fi

    local ss_block vl_block
    ss_block="$(clash_clone_node base "$NODE_SS" "${NODE_SS}-isp" "$SS_PORT" "$SS_ISP_PORT")" || clash_missing_nodes_hint
    vl_block="$(clash_clone_node base "$NODE_VLESS" "${NODE_VLESS}-isp" "$VLESS_PORT" "$VLESS_ISP_PORT")" || clash_missing_nodes_hint

    # The nodes go after the last non-blank line before proxy-groups:, the
    # group after the last non-blank, non-comment line before rules:.
    node_after=$((groups_i - 1))
    while ((node_after > proxies_i)) && [[ "${base[node_after]}" =~ ^[[:space:]]*$ ]]; do
        node_after=$((node_after - 1))
    done
    group_after=$((rules_i - 1))
    while ((group_after > groups_i)) && [[ "${base[group_after]}" =~ ^[[:space:]]*$ || "${base[group_after]}" =~ ^# ]]; do
        group_after=$((group_after - 1))
    done

    for ((i = 0; i < ${#base[@]}; i++)); do
        new+=("${base[i]}")
        if ((i == node_after)); then
            new+=("$MARK_BEGIN")
            mapfile -t nodes <<< "$ss_block"
            new+=("${nodes[@]}")
            mapfile -t nodes <<< "$vl_block"
            new+=("${nodes[@]}")
            new+=("$MARK_END")
        fi
        if ((i == group_after)); then
            new+=("$MARK_BEGIN"
                  "  - name: ${GROUP_ISP}"
                  "    type: select"
                  "    proxies:"
                  "      - ${NODE_SS}-isp"
                  "      - ${NODE_VLESS}-isp"
                  "$MARK_END")
        fi
    done
    printf '%s\n' "${new[@]}" > "$out"

    # Assertions: only marker blocks were added, and the names are unique.
    local -a check_in=() check_base=()
    # shellcheck disable=SC2034  # check_in is read through a nameref in clash_strip
    mapfile -t check_in < "$out"
    clash_strip check_base check_in || die "Internal error: clash.yaml markers are unbalanced."
    [[ "$(printf '%s\n' "${check_base[@]}")" == "$(printf '%s\n' "${base[@]}")" ]] || die "Internal error: clash.yaml edit changed lines outside the markers."
    [[ "$(grep -cF -- "${NODE_SS}-isp" "$out")" -eq 2 ]] || die "Internal error: unexpected ${NODE_SS}-isp count in clash.yaml."
    [[ "$(grep -cF -- "${NODE_VLESS}-isp" "$out")" -eq 2 ]] || die "Internal error: unexpected ${NODE_VLESS}-isp count in clash.yaml."
    [[ "$(grep -cF -- "$GROUP_ISP" "$out")" -eq 1 ]] || die "Internal error: unexpected $GROUP_ISP count in clash.yaml."
    j="$(env_get REALITY_PRIVATE_KEY)"
    if [[ -n "$j" ]] && grep -qF -- "$j" "$out"; then
        die "Refusing to write REALITY_PRIVATE_KEY into clash.yaml."
    fi
}

# clash_render_remove OUTFILE: clash.yaml without the marker blocks.
clash_render_remove() {
    local out=$1
    local -a raw=() base=()
    mapfile -t raw < "$CLASH_FILE"
    clash_strip base raw || die "clash.yaml has unbalanced '$MARK_BEGIN' / '$MARK_END' markers. Fix them by hand and re-run."
    if ((${#base[@]} > 0)); then
        printf '%s\n' "${base[@]}" > "$out"
    else
        : > "$out"
    fi
}

# ---------------------------------------------------------------------------
# Listening ports and container verification
# ---------------------------------------------------------------------------

# listening PROTO PORT: 0 listening, 1 not listening, 2 cannot tell.
listening() {
    local proto=$1 port=$2
    if command -v ss >/dev/null 2>&1; then
        if [[ "$proto" == tcp ]]; then
            ss -H -ltn 2>/dev/null | grep -Eq "[:.]${port}[[:space:]]"
        else
            ss -H -lun 2>/dev/null | grep -Eq "[:.]${port}[[:space:]]"
        fi
        return
    fi
    if [[ "$proto" == tcp ]]; then
        bash -c "echo >/dev/tcp/127.0.0.1/${port}" 2>/dev/null
        return
    fi
    return 2
}

# wait_listening PROTO PORT: retry for up to 15 seconds.
wait_listening() {
    local proto=$1 port=$2 rc=1
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        rc=0
        listening "$proto" "$port" || rc=$?
        if [[ "$rc" -eq 0 ]]; then
            return 0
        fi
        if [[ "$rc" -eq 2 ]]; then
            warn "ss is not installed. Skipping the ${proto^^} listener check for port ${port}."
            return 0
        fi
        sleep 1
    done
    return 1
}

show_logs() {
    compose logs --tail 50 "$CONTAINER_NAME" >&2 || true
}

recreate() {
    compose up -d --force-recreate
}

# verify_service EXPECT_ISP: 0 when the container runs the current config and
# the expected ports listen.
verify_service() {
    local expect_isp=$1 status port
    status="missing"
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        status="$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo missing)"
        if [[ "$status" == running ]]; then
            break
        fi
        sleep 1
    done
    if [[ "$status" != running ]]; then
        warn "sing-box did not stay running (status: $status)."
        return 1
    fi
    if ! compose exec -T "$CONTAINER_NAME" sing-box check -c "$CONTAINER_CONFIG"; then
        warn "sing-box config check failed inside the container."
        return 1
    fi
    for port in "$SS_PORT" "$VLESS_PORT"; do
        if ! wait_listening tcp "$port"; then
            warn "Port ${port}/tcp is not accepting connections."
            return 1
        fi
    done
    if [[ "$expect_isp" -eq 1 ]]; then
        for port in "$SS_ISP_PORT" "$VLESS_ISP_PORT"; do
            if ! wait_listening tcp "$port"; then
                warn "Port ${port}/tcp is not accepting connections."
                return 1
            fi
        done
        if ! wait_listening udp "$SS_ISP_PORT"; then
            warn "Port ${SS_ISP_PORT}/udp is not listening."
            return 1
        fi
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Files: install, backup, rollback
# ---------------------------------------------------------------------------

# install_file SRC DEST: replace DEST atomically with mode 600 and DEST's owner.
install_file() {
    local src=$1 dest=$2
    chmod 600 "$src"
    if [[ -e "$dest" ]]; then
        chown --reference="$dest" "$src" 2>/dev/null || true
    fi
    mv -f -- "$src" "$dest"
}

make_backup() {
    local stamp f
    stamp="$(date +%Y%m%d-%H%M%S)-$$"
    BACKUP_DIR="$BACKUP_ROOT/$stamp"
    mkdir -p "$BACKUP_ROOT" "$BACKUP_DIR"
    chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"
    for f in "$CONFIG_FILE" "$CLASH_FILE" "$ENV_FILE"; do
        if [[ -f "$f" ]]; then
            cp -p -- "$f" "$BACKUP_DIR/$(basename "$f")"
        fi
    done
    # Keep the five newest backups.
    local -a all=()
    mapfile -t all < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)
    if ((${#all[@]} > 5)); then
        local i
        for ((i = 0; i < ${#all[@]} - 5; i++)); do
            rm -rf -- "${all[i]}"
        done
    fi
}

restore_backup_files() {
    local f name
    for f in "$CONFIG_FILE" "$CLASH_FILE" "$ENV_FILE"; do
        name="$(basename "$f")"
        if [[ -f "$BACKUP_DIR/$name" ]]; then
            cp -p -- "$BACKUP_DIR/$name" "$f"
        fi
    done
}

# rollback: put the backed-up files back and recreate the container.
rollback() {
    warn "Rolling back to the previous configuration..."
    restore_backup_files
    if ! recreate; then
        show_logs
        die "Rollback failed to restart sing-box. Previous files are restored from $BACKUP_DIR; run: docker compose up -d --force-recreate"
    fi
    if verify_service 0; then
        echo "Rollback complete. sing-box is running the previous configuration." >&2
    else
        show_logs
        die "Rollback restored the files, but sing-box is not healthy. Check: docker compose logs sing-box"
    fi
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight_docker() {
    require_commands docker flock base64 mktemp cmp date
    docker compose version >/dev/null 2>&1 || die "docker compose is not available."
    docker info >/dev/null 2>&1 || die "Docker daemon is not running."
    IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    [[ -n "$IMAGE" ]] || die "Container $CONTAINER_NAME not found. Run scripts/start.sh first."
}

preflight_config() {
    [[ -f "$CONFIG_FILE" ]] || die "config.json does not exist. Run scripts/gen-config.sh first."
    jq -e . "$CONFIG_FILE" >/dev/null 2>&1 || die "config.json is not valid JSON."
    jq -e '(.inbounds | map(.tag)) as $t | ($t | index("ss-in")) != null and ($t | index("vless-reality-in")) != null' \
        "$CONFIG_FILE" >/dev/null 2>&1 \
        || die "config.json has no inbounds tagged ss-in and vless-reality-in."
    if jq -e --argjson a "$SS_ISP_PORT" --argjson b "$VLESS_ISP_PORT" --arg x "$SS_ISP_TAG" --arg y "$VLESS_ISP_TAG" \
        '[.inbounds[] | select(.tag != $x and .tag != $y) | .listen_port] | any(. == $a or . == $b)' \
        "$CONFIG_FILE" >/dev/null 2>&1; then
        die "Another inbound in config.json already uses port ${SS_ISP_PORT} or ${VLESS_ISP_PORT}."
    fi
}

preflight_ports() {
    local spec proto port rc
    if config_has_isp; then
        return 0  # a re-run: sing-box itself already owns these ports
    fi
    if ! command -v ss >/dev/null 2>&1; then
        warn "ss is not installed. Skipping the check that ports ${SS_ISP_PORT} and ${VLESS_ISP_PORT} are free."
        return 0
    fi
    for spec in "tcp:${SS_ISP_PORT}" "udp:${SS_ISP_PORT}" "tcp:${VLESS_ISP_PORT}"; do
        proto=${spec%%:*}
        port=${spec##*:}
        rc=0
        listening "$proto" "$port" || rc=$?
        if [[ "$rc" -eq 0 ]]; then
            die "Port ${port}/${proto} is already in use by another process."
        fi
    done
}

# ---------------------------------------------------------------------------
# SOCKS5 egress check
# ---------------------------------------------------------------------------

# curl_quote VALUE: escape for a double-quoted curl config value.
curl_quote() {
    local value=$1
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '%s' "$value"
}

# socks_egress_ip: print the IP the SOCKS5 proxy exits from. The credentials go
# to curl on stdin (-K -), so they never appear in argv or the process list.
socks_egress_ip() {
    local url body ip
    for url in "https://api.ipify.org" "https://ipinfo.io/ip" "https://ipv4.icanhazip.com" "https://ifconfig.me/ip"; do
        body="$(
            {
                printf 'proxy = "socks5h://%s"\n' "$(curl_quote "$ISP_ADDR")"
                printf 'proxy-user = "%s:%s"\n' "$(curl_quote "$ISP_USER")" "$(curl_quote "$ISP_PASS")"
                printf 'url = "%s"\n' "$url"
                printf 'silent\nshow-error\nfail\nmax-time = 15\n'
            } | curl -K - 2>/dev/null || true
        )"
        ip="$(trim "$body")"
        if is_ip "$ip"; then
            printf '%s' "$ip"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

fw_run() {
    if ! "$@" >/dev/null 2>&1; then
        warn "Firewall command failed: $*"
        FW_FAILED+=("$*")
        return 1
    fi
}

ipt_active() {
    local cmd=$1 rules
    command -v "$cmd" >/dev/null 2>&1 || return 1
    rules="$("$cmd" -S INPUT 2>/dev/null)" || return 1
    [[ -n "$rules" ]] || return 1
    if [[ "$rules" == *"-P INPUT DROP"* || "$rules" == *"-P INPUT REJECT"* ]]; then
        return 0
    fi
    printf '%s\n' "$rules" | grep -qv '^-P INPUT '
}

fw_backend() {
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
        echo ufw
        return
    fi
    if command -v firewall-cmd >/dev/null 2>&1 && [[ "$(firewall-cmd --state 2>/dev/null || true)" == running ]]; then
        echo firewalld
        return
    fi
    if ipt_active iptables || ipt_active ip6tables; then
        echo iptables
        return
    fi
    echo none
}

fw_persist_iptables() {
    if ! command -v netfilter-persistent >/dev/null 2>&1; then
        info "Installing netfilter-persistent so the iptables rules survive a reboot..."
        command -v apt-get >/dev/null 2>&1 || { warn "apt-get is not available; iptables rules will not survive a reboot."; FW_FAILED+=("persist iptables"); return 1; }
        if command -v debconf-set-selections >/dev/null 2>&1; then
            printf '%s\n' \
                'iptables-persistent iptables-persistent/autosave_v4 boolean true' \
                'iptables-persistent iptables-persistent/autosave_v6 boolean true' \
                | debconf-set-selections || true
        fi
        DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
        if ! DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends netfilter-persistent iptables-persistent; then
            warn "Failed to install netfilter-persistent; iptables rules will not survive a reboot."
            FW_FAILED+=("persist iptables")
            return 1
        fi
    fi
    fw_run netfilter-persistent save
}

fw_iptables_apply() {
    local mode=$1 cmd rule proto port
    for cmd in iptables ip6tables; do
        ipt_active "$cmd" || continue
        for rule in "${FW_RULES[@]}"; do
            port=${rule%%/*}
            proto=${rule##*/}
            if [[ "$mode" == add ]]; then
                "$cmd" -C INPUT -p "$proto" --dport "$port" -m comment --comment "$FW_COMMENT" -j ACCEPT >/dev/null 2>&1 \
                    || fw_run "$cmd" -I INPUT -p "$proto" --dport "$port" -m comment --comment "$FW_COMMENT" -j ACCEPT || true
            else
                while "$cmd" -C INPUT -p "$proto" --dport "$port" -m comment --comment "$FW_COMMENT" -j ACCEPT >/dev/null 2>&1; do
                    fw_run "$cmd" -D INPUT -p "$proto" --dport "$port" -m comment --comment "$FW_COMMENT" -j ACCEPT || break
                done
            fi
        done
    done
}

# firewall_apply add|remove
firewall_apply() {
    local mode=$1 backend rule done_word=added
    [[ "$mode" == remove ]] && done_word=removed
    backend="$(fw_backend)"
    case "$backend" in
        ufw)
            for rule in "${FW_RULES[@]}"; do
                if [[ "$mode" == add ]]; then
                    fw_run ufw allow "$rule" comment "$FW_COMMENT" || true
                else
                    fw_run ufw delete allow "$rule" || true
                fi
            done
            info "Firewall: ufw rules ${done_word} (ufw persists them itself)."
            ;;
        firewalld)
            for rule in "${FW_RULES[@]}"; do
                if [[ "$mode" == add ]]; then
                    firewall-cmd --permanent --query-port="$rule" >/dev/null 2>&1 || fw_run firewall-cmd --permanent --add-port="$rule" || true
                    firewall-cmd --query-port="$rule" >/dev/null 2>&1 || fw_run firewall-cmd --add-port="$rule" || true
                else
                    if firewall-cmd --permanent --query-port="$rule" >/dev/null 2>&1; then
                        fw_run firewall-cmd --permanent --remove-port="$rule" || true
                    fi
                    if firewall-cmd --query-port="$rule" >/dev/null 2>&1; then
                        fw_run firewall-cmd --remove-port="$rule" || true
                    fi
                fi
            done
            info "Firewall: firewalld ports ${done_word} (permanent and runtime)."
            ;;
        iptables)
            fw_iptables_apply "$mode"
            if [[ "$mode" == add ]] || command -v netfilter-persistent >/dev/null 2>&1; then
                fw_persist_iptables || true
            fi
            info "Firewall: iptables rules ${done_word}."
            ;;
        *)
            info "Firewall: no active local firewall detected. Nothing to change."
            ;;
    esac
}

cloud_reminder() {
    local mode=$1
    echo
    if [[ "$mode" == add ]]; then
        echo "Cloud security group: allow ${SS_ISP_PORT}/tcp, ${SS_ISP_PORT}/udp and ${VLESS_ISP_PORT}/tcp in your provider's console too."
    else
        echo "Cloud security group: you can now close ${SS_ISP_PORT}/tcp, ${SS_ISP_PORT}/udp and ${VLESS_ISP_PORT}/tcp in your provider's console."
    fi
}

report_firewall_failures() {
    if ((${#FW_FAILED[@]} > 0)); then
        echo >&2
        warn "Some firewall steps failed. Open or remove these ports by hand: ${FW_RULES[*]}"
        local f
        for f in "${FW_FAILED[@]}"; do
            echo "  failed: $f" >&2
        done
        return 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Add
# ---------------------------------------------------------------------------

collect_inputs() {
    local cur_addr cur_user cur_pass cur_egress raw pass2 expected_default

    cur_addr="$(env_get ISP_SOCKS_ADDR)"
    cur_user="$(b64_decode "$(env_get ISP_SOCKS_USER)" || true)"
    cur_pass="$(b64_decode "$(env_get ISP_SOCKS_PASS)" || true)"
    cur_egress="$(env_get ISP_SOCKS_EGRESS_IP)"

    if [[ -n "$cur_addr" ]]; then
        raw="$(ask "ISP SOCKS5 entry address host:port [${cur_addr}]: ")"
        raw="$(trim "$raw")"
        [[ -n "$raw" ]] || raw="$cur_addr"
    else
        raw="$(trim "$(ask "ISP SOCKS5 entry address (IPv4:port or [IPv6]:port): ")")"
    fi
    parse_addr "$raw" || die "Invalid address. Use IPv4:port or [IPv6]:port with a numeric port 1-65535."

    if [[ -n "$cur_user" ]]; then
        ISP_USER="$(ask "SOCKS5 username [keep current]: ")"
        [[ -n "$ISP_USER" ]] || ISP_USER="$cur_user"
    else
        ISP_USER="$(ask "SOCKS5 username: ")"
    fi
    valid_cred "$ISP_USER" || die "Invalid username: it must be 1-255 bytes with no control characters."
    [[ "$ISP_USER" != *:* ]] || die "Invalid username: it must not contain ':'."

    if [[ -n "$cur_pass" ]]; then
        ISP_PASS="$(ask_secret "SOCKS5 password (leave blank to keep the current one): ")"
        if [[ -z "$ISP_PASS" ]]; then
            ISP_PASS="$cur_pass"
        else
            pass2="$(ask_secret "Repeat the password: ")"
            [[ "$ISP_PASS" == "$pass2" ]] || die "The passwords do not match."
        fi
    else
        ISP_PASS="$(ask_secret "SOCKS5 password: ")"
        pass2="$(ask_secret "Repeat the password: ")"
        [[ "$ISP_PASS" == "$pass2" ]] || die "The passwords do not match."
    fi
    valid_cred "$ISP_PASS" || die "Invalid password: it must be 1-255 bytes with no control characters."

    expected_default="the entry IP ${ISP_HOST}"
    if [[ -n "$cur_egress" ]]; then
        raw="$(trim "$(ask "Expected egress IP, if it differs from the entry IP [${cur_egress}; '-' resets to ${ISP_HOST}]: ")")"
        if [[ -z "$raw" ]]; then
            raw="$cur_egress"
        elif [[ "$raw" == "-" ]]; then
            raw=""
        fi
    else
        raw="$(trim "$(ask "Expected egress IP, if it differs from the entry IP (Enter = ${expected_default}): ")")"
    fi
    if [[ -n "$raw" ]]; then
        is_ip "$raw" || die "Invalid expected egress IP."
    fi
    ISP_EGRESS_IP="$raw"
    if [[ -n "$ISP_EGRESS_IP" ]]; then
        EXPECTED_IP="$ISP_EGRESS_IP"
    else
        EXPECTED_IP="$ISP_HOST"
    fi
}

check_socks_egress() {
    local got
    info "Checking the SOCKS5 proxy (TCP) and its egress IP..."
    got="$(socks_egress_ip)" || die "Could not reach an IP echo service through the SOCKS5 proxy. Check the address, username and password, and that this server's IP is allowed by the ISP. Nothing was changed."
    if [[ "$(lower "$got")" != "$(lower "$EXPECTED_IP")" ]]; then
        die "Egress IP through the proxy is ${got}, expected ${EXPECTED_IP}. If the ISP's egress differs from its entry IP, enter the egress IP when asked. Nothing was changed."
    fi
    info "Egress IP through the SOCKS5 proxy: ${got} (matches)."
}

validate_candidate() {
    local cand=$1
    jq -e . "$cand" >/dev/null 2>&1 || die "Internal error: candidate config.json is not valid JSON."
    info "Validating the candidate config with $IMAGE ..."
    if ! docker run --rm -v "$cand:$CONTAINER_CONFIG:ro" "$IMAGE" check -c "$CONTAINER_CONFIG"; then
        die "sing-box rejected the candidate config. Nothing was changed."
    fi
}

do_add() {
    local cfg_cand env_cand clash_cand="" changed=1 clash_state

    ensure_jq
    preflight_docker
    preflight_config
    [[ -f "$ENV_FILE" ]] || die ".env does not exist. Run scripts/gen-keys.sh first."
    preflight_ports

    collect_inputs
    check_socks_egress

    # Build every candidate before touching anything.
    cfg_cand="$(mktmp)"
    render_config_add "$cfg_cand" || die "Failed to build the candidate config.json."
    validate_candidate "$cfg_cand"

    env_cand="$(mktmp)"
    {
        env_without_isp "$ENV_FILE"
        printf '\n%s\n' "$ENV_HEADER"
        printf 'ISP_SOCKS_ADDR=%s\n' "$ISP_ADDR"
        printf 'ISP_SOCKS_USER=%s\n' "$(b64_encode "$ISP_USER")"
        printf 'ISP_SOCKS_PASS=%s\n' "$(b64_encode "$ISP_PASS")"
        printf 'ISP_SOCKS_EGRESS_IP=%s\n' "$ISP_EGRESS_IP"
    } > "$env_cand"

    if [[ -f "$CLASH_FILE" ]]; then
        clash_cand="$(mktmp)"
        clash_render_add "$clash_cand"
        clash_state="clash.yaml updated (nodes ${NODE_SS}-isp, ${NODE_VLESS}-isp; group ${GROUP_ISP})."
    else
        warn "clash.yaml does not exist, so only the server config is changed. After running scripts/conf-clash.sh, re-run this script with --add to add the client nodes."
        clash_state="clash.yaml not found (skipped)."
    fi

    if cmp -s "$cfg_cand" "$CONFIG_FILE"; then
        changed=0
    fi
    if [[ "$changed" -eq 1 ]]; then
        confirm_restart
    fi

    make_backup
    echo "Backup saved in $BACKUP_DIR"

    if [[ "$changed" -eq 1 ]]; then
        install_file "$cfg_cand" "$CONFIG_FILE"
        if ! recreate || ! verify_service 1; then
            show_logs
            rollback
            die "The ISP outbound did not come up. The previous configuration was restored."
        fi
    else
        info "config.json already has this ISP outbound; sing-box is not restarted."
        verify_service 1 || warn "sing-box does not look healthy. Check: docker compose logs sing-box"
    fi

    # The server side works. Commit the other files.
    install_file "$env_cand" "$ENV_FILE"
    if [[ -n "$clash_cand" ]]; then
        install_file "$clash_cand" "$CLASH_FILE"
    fi

    firewall_apply add

    echo
    echo "ISP outbound is active."
    echo "  shadowsocks-isp    port ${SS_ISP_PORT} (tcp+udp), tag ${SS_ISP_TAG}"
    echo "  vless-reality-isp  port ${VLESS_ISP_PORT} (tcp),    tag ${VLESS_ISP_TAG}"
    echo "  $clash_state"
    echo "  Ports ${SS_PORT} and ${VLESS_PORT} are unchanged and still go out directly."
    echo "Notes:"
    echo "  - Only TCP was tested. UDP through the ISP (Shadowsocks UDP) works only if the proxy supports SOCKS5 UDP ASSOCIATE."
    echo "  - If the ISP proxy stops working, the ISP nodes fail. They never fall back to a direct connection."
    echo "  - Re-import clash.yaml in your clients to see the new ${GROUP_ISP} group."
    cloud_reminder add
    report_firewall_failures || exit 1
}

# ---------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------

do_remove() {
    local cfg_cand env_cand clash_cand="" cfg_changed=0 env_changed=0 clash_changed=0

    ensure_jq
    preflight_docker
    preflight_config

    cfg_cand="$(mktmp)"
    render_config_remove "$cfg_cand" || die "Failed to build the candidate config.json."
    if ! cmp -s "$cfg_cand" "$CONFIG_FILE"; then
        cfg_changed=1
        validate_candidate "$cfg_cand"
    fi

    env_cand="$(mktmp)"
    if [[ -f "$ENV_FILE" ]]; then
        env_without_isp "$ENV_FILE" > "$env_cand"
        cmp -s "$env_cand" "$ENV_FILE" || env_changed=1
    fi

    if [[ -f "$CLASH_FILE" ]]; then
        clash_cand="$(mktmp)"
        clash_render_remove "$clash_cand"
        cmp -s "$clash_cand" "$CLASH_FILE" || clash_changed=1
    fi

    if [[ "$cfg_changed" -eq 1 ]]; then
        confirm_restart
    fi

    if ((cfg_changed + env_changed + clash_changed > 0)); then
        make_backup
        echo "Backup saved in $BACKUP_DIR"
    fi

    if [[ "$cfg_changed" -eq 1 ]]; then
        install_file "$cfg_cand" "$CONFIG_FILE"
        if ! recreate || ! verify_service 0; then
            show_logs
            rollback
            die "sing-box did not come up after removing the ISP outbound. The previous configuration was restored."
        fi
    fi
    if [[ "$env_changed" -eq 1 ]]; then
        install_file "$env_cand" "$ENV_FILE"
    fi
    if [[ "$clash_changed" -eq 1 ]]; then
        install_file "$clash_cand" "$CLASH_FILE"
    fi

    firewall_apply remove

    echo
    if ((cfg_changed + env_changed + clash_changed == 0)); then
        echo "No ISP outbound was configured. Nothing to remove."
    else
        echo "ISP outbound removed."
        [[ "$cfg_changed" -eq 1 ]] && echo "  config.json: ISP inbounds, outbound and route rule removed; sing-box restarted."
        [[ "$env_changed" -eq 1 ]] && echo "  .env: ISP_SOCKS_* keys removed."
        [[ "$clash_changed" -eq 1 ]] && echo "  clash.yaml: ISP nodes and ${GROUP_ISP} group removed. Re-import it in your clients."
    fi
    cloud_reminder remove
    report_firewall_failures || exit 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

while (($# > 0)); do
    case "$1" in
        --add) ACTION=add ;;
        --remove) ACTION=remove ;;
        --yes|-y) ASSUME_YES=1 ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; die "Unknown argument: $1" ;;
    esac
    shift
done

require_root

if [[ -z "$ACTION" ]]; then
    echo "1) Add ISP outbound"
    echo "2) Remove ISP outbound"
    echo "q) Quit"
    choice="$(ask "Choose: ")"
    case "$choice" in
        1) ACTION=add ;;
        2) ACTION=remove ;;
        q|Q) exit 0 ;;
        *) die "Invalid choice." ;;
    esac
fi

# One run at a time.
exec 9> "$LOCK_FILE"
flock -n 9 || die "Another isp-outbound.sh run is in progress."

case "$ACTION" in
    add) do_add ;;
    remove) do_remove ;;
esac
