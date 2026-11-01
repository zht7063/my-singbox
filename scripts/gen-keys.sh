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

while true; do
    if ! read -r -p "Public IP address of this machine: " SERVER_ADDRESS; then
        echo "Error: Failed to read the public IP address." >&2
        exit 1
    fi
    SERVER_ADDRESS="${SERVER_ADDRESS#"${SERVER_ADDRESS%%[![:space:]]*}"}"
    SERVER_ADDRESS="${SERVER_ADDRESS%"${SERVER_ADDRESS##*[![:space:]]}"}"
    if is_public_ip "$SERVER_ADDRESS"; then
        break
    fi
    echo "Error: Enter a public IP address." >&2
done

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