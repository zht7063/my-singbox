#!/usr/bin/env bash
set -euo pipefail
umask 077

# Project paths
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# Require an explicitly selected sing-box image version
: "${SING_BOX_VERSION:?Please set SING_BOX_VERSION}"

IMAGE="ghcr.io/sagernet/sing-box:$SING_BOX_VERSION"

# Prevent accidental credential replacement
if [[ -e "$ENV_FILE" ]]; then
    echo "Error: .env already exists. Refusing to overwrite." >&2
    exit 1
fi

# Check dependencies
for cmd in docker openssl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: $cmd is not installed." >&2
        exit 1
    fi
done

# Fail before generating credentials when the daemon is down
if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running." >&2
    exit 1
fi

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

is_public_ipv4() {
    local value=$1 a b c d
    is_ipv4 "$value" || return 1
    IFS=. read -r a b c d <<< "$value"
    if ((a == 0 || a == 10 || a == 127 || a >= 224)); then
        return 1
    fi
    if ((a == 100 && b >= 64 && b <= 127)); then
        return 1
    fi
    if ((a == 169 && b == 254)); then
        return 1
    fi
    if ((a == 172 && b >= 16 && b <= 31)); then
        return 1
    fi
    if ((a == 192 && b == 168)); then
        return 1
    fi
    if ((a == 192 && b == 0 && c == 2)); then
        return 1
    fi
    if ((a == 198 && b == 51 && c == 100)); then
        return 1
    fi
    if ((a == 203 && b == 0 && c == 113)); then
        return 1
    fi
    if ((a == 198 && (b == 18 || b == 19))); then
        return 1
    fi
}

is_ipv6() {
    local value=$1 colons
    [[ "$value" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
    [[ "$value" == *::*::* ]] && return 1
    [[ "$value" == *:::* ]] && return 1
    colons=${value//[^:]}
    [[ ${#colons} -ge 2 && ${#colons} -le 7 ]]
}

is_public_ipv6() {
    local value first num
    value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    is_ipv6 "$value" || return 1
    [[ "$value" == :* ]] && return 1
    first="${value%%:*}"
    [[ "$first" =~ ^[0-9a-f]{1,4}$ ]] || return 1
    num=$((16#$first))
    if ((num < 0x2000 || num > 0x3fff)); then
        return 1
    fi
    if [[ "$value" =~ ^2001:0*db8(:|$) ]]; then
        return 1
    fi
}

is_public_ip() {
    if [[ "$1" == *:* ]]; then
        is_public_ipv6 "$1"
    else
        is_public_ipv4 "$1"
    fi
}

trim() {
    local value=$1
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

# Debian and Ubuntu ship curl and GNU wget. Prefer curl.
http_get() {
    local family=$1
    local url=$2
    if command -v curl >/dev/null 2>&1; then
        curl -"$family" -fsS --max-time 8 -A "my-singbox" "$url" || return 1
        return 0
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -"$family" -qO- --timeout=8 -U "my-singbox" "$url" || return 1
        return 0
    fi
    return 1
}

detect_public_ip() {
    local family url body ip
    local -a urls
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        return 1
    fi
    for family in 4 6; do
        if [[ "$family" == 4 ]]; then
            urls=(
                "https://ipinfo.io/ip"
                "https://api.ipify.org"
                "https://ipv4.icanhazip.com"
                "https://ifconfig.me/ip"
                "https://api.ip.sb/ip"
            )
        else
            urls=(
                "https://api6.ipify.org"
                "https://ipv6.icanhazip.com"
            )
        fi
        for url in "${urls[@]}"; do
            body="$(http_get "$family" "$url" 2>/dev/null || true)"
            ip="$(trim "$body")"
            if is_public_ip "$ip"; then
                printf '%s\n' "$ip"
                return 0
            fi
        done
        body="$(http_get "$family" "https://1.1.1.1/cdn-cgi/trace" 2>/dev/null || true)"
        ip="$(printf '%s\n' "$body" | awk -F= '/^ip=/ {print $2; exit}')"
        ip="$(trim "$ip")"
        if is_public_ip "$ip"; then
            printf '%s\n' "$ip"
            return 0
        fi
    done
    return 1
}

prompt_public_ip() {
    local address
    while true; do
        if ! read -r -p "Public IP address of this machine: " address; then
            echo "Error: Failed to read the public IP address." >&2
            exit 1
        fi
        address="$(trim "$address")"
        if is_public_ip "$address"; then
            printf '%s\n' "$address"
            return 0
        fi
        echo "Error: Enter a public IP address." >&2
    done
}

echo "Detecting public IP address..."
if SERVER_ADDRESS="$(detect_public_ip)"; then
    echo "Detected public IP address: $SERVER_ADDRESS"
else
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        echo "Error: curl or wget is not installed. On Debian/Ubuntu: apt install curl" >&2
    else
        echo "Could not detect a public IP address." >&2
    fi
    SERVER_ADDRESS="$(prompt_public_ip)"
fi

echo "Generating credentials..."

# VLESS UUID
VLESS_UUID="$(docker run --rm "$IMAGE" generate uuid)"

# REALITY keypair
REALITY_OUTPUT="$(docker run --rm "$IMAGE" generate reality-keypair)"

REALITY_PRIVATE_KEY="$(
    printf '%s\n' "$REALITY_OUTPUT" |
    awk -F ': *' '/^[[:space:]]*PrivateKey:/ {print $2}'
)"

REALITY_PUBLIC_KEY="$(
    printf '%s\n' "$REALITY_OUTPUT" |
    awk -F ': *' '/^[[:space:]]*PublicKey:/ {print $2}'
)"

# REALITY Short ID
REALITY_SHORT_ID="$(openssl rand -hex 8)"

# Shadowsocks 2022 key
SS_PASSWORD="$(
    docker run --rm "$IMAGE" generate rand --base64 16
)"

# Validate generated values
if [[ ! "$VLESS_UUID" =~ ^[0-9a-fA-F-]{36}$ ]] ||
   [[ ! "$REALITY_PRIVATE_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
   [[ ! "$REALITY_PUBLIC_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
   [[ ! "$REALITY_SHORT_ID" =~ ^[0-9a-f]{16}$ ]] ||
   [[ ! "$SS_PASSWORD" =~ ^[A-Za-z0-9+/]{22}==$ ]]; then
    echo "Error: Invalid generated credentials." >&2
    exit 1
fi

# Create .env securely
(
    set -o noclobber

    {
        printf 'SING_BOX_VERSION=%s\n' "$SING_BOX_VERSION"
        printf '\n# VLESS\n'
        printf 'VLESS_UUID=%s\n' "$VLESS_UUID"

        printf '\n# REALITY\n'
        printf 'REALITY_PRIVATE_KEY=%s\n' "$REALITY_PRIVATE_KEY"
        printf 'REALITY_PUBLIC_KEY=%s\n' "$REALITY_PUBLIC_KEY"
        printf 'REALITY_SHORT_ID=%s\n' "$REALITY_SHORT_ID"

        printf '\n# Shadowsocks 2022\n'
        printf 'SS_PASSWORD=%s\n' "$SS_PASSWORD"

        printf '\n# Client\n'
        printf 'SERVER_ADDRESS=%s\n' "$SERVER_ADDRESS"
    } > "$ENV_FILE"
)

chmod 600 "$ENV_FILE"

echo "Credentials generated successfully."
echo "Saved to: $ENV_FILE"