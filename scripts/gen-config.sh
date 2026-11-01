#!/usr/bin/env bash
set -euo pipefail
umask 077

# Project paths
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
TEMPLATE_FILE="$PROJECT_DIR/templates/config.json.template"
CONFIG_FILE="$PROJECT_DIR/config.json"

die() {
    echo "Error: $*" >&2
    exit 1
}

# Server config fields. REALITY_PUBLIC_KEY and SERVER_ADDRESS are client-only,
# and SING_BOX_VERSION selects the image, so none of them belong in config.json.
REQUIRED_KEYS=(
    VLESS_UUID
    REALITY_PRIVATE_KEY
    REALITY_SHORT_ID
    SS_PASSWORD
)

if [[ ! -f "$ENV_FILE" ]]; then
    die ".env does not exist. Run scripts/gen-keys.sh first."
fi

if [[ ! -f "$TEMPLATE_FILE" ]]; then
    die "Template does not exist: $TEMPLATE_FILE"
fi

if [[ -e "$CONFIG_FILE" ]]; then
    die "config.json already exists. Refusing to overwrite."
fi

# Read KEY=VALUE assignments without sourcing .env
seen_keys=" "
while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}

    if [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]]; then
        continue
    fi

    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
        die "Invalid .env line: $line"
    fi

    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"

    if [[ "$seen_keys" == *" $key "* ]]; then
        die "Duplicate .env key: $key"
    fi
    seen_keys+=" $key "

    case "$key" in
        SING_BOX_VERSION|VLESS_UUID|REALITY_PRIVATE_KEY|REALITY_PUBLIC_KEY|REALITY_SHORT_ID|SS_PASSWORD|SERVER_ADDRESS)
            printf -v "$key" '%s' "$value"
            ;;
        ISP_SOCKS_ADDR|ISP_SOCKS_USER|ISP_SOCKS_PASS)
            # Optional ISP outbound settings written by scripts/isp-outbound.sh.
            # Accepted so they do not trip the whitelist, but never rendered.
            ;;
        *)
            die "Unknown .env key: $key"
            ;;
    esac
done < "$ENV_FILE"

for key in "${REQUIRED_KEYS[@]}"; do
    if [[ "$seen_keys" != *" $key "* ]]; then
        die "Missing .env key: $key"
    fi
done

if [[ ! "$VLESS_UUID" =~ ^[0-9a-fA-F-]{36}$ ]] ||
   [[ ! "$REALITY_PRIVATE_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
   [[ ! "$REALITY_SHORT_ID" =~ ^[0-9a-f]{16}$ ]] ||
   [[ ! "$SS_PASSWORD" =~ ^[A-Za-z0-9+/]{22}==$ ]]; then
    die "Invalid credentials in .env."
fi

template="$(<"$TEMPLATE_FILE")"

# Each credential must appear once, beside the field it belongs to.
expect_once() {
    local needle=$1
    local stripped=${template//"$needle"/}
    local count=$(( (${#template} - ${#stripped}) / ${#needle} ))

    if [[ "$count" -ne 1 ]]; then
        die "Template must contain exactly one $(printf '%s' "$needle")"
    fi
}

expect_once '"password": "${SS_PASSWORD}"'
expect_once '"uuid": "${VLESS_UUID}"'
expect_once '"private_key": "${REALITY_PRIVATE_KEY}"'
expect_once '"${REALITY_SHORT_ID}"'

rendered=$template
ss_password_placeholder='${SS_PASSWORD}'
vless_uuid_placeholder='${VLESS_UUID}'
reality_private_key_placeholder='${REALITY_PRIVATE_KEY}'
reality_short_id_placeholder='${REALITY_SHORT_ID}'
rendered=${rendered//"$ss_password_placeholder"/"$SS_PASSWORD"}
rendered=${rendered//"$vless_uuid_placeholder"/"$VLESS_UUID"}
rendered=${rendered//"$reality_private_key_placeholder"/"$REALITY_PRIVATE_KEY"}
rendered=${rendered//"$reality_short_id_placeholder"/"$REALITY_SHORT_ID"}

if [[ "$rendered" == *'${'* ]]; then
    die "Unresolved placeholder left in config.json."
fi

for key in VLESS_UUID REALITY_PRIVATE_KEY REALITY_SHORT_ID SS_PASSWORD; do
    value="${!key}"
    if [[ "$rendered" != *"\"$value\""* ]]; then
        die "Failed to place $key into config.json."
    fi
done

(
    set -o noclobber
    printf '%s\n' "$rendered" > "$CONFIG_FILE"
)

chmod 600 "$CONFIG_FILE"

echo "Config generated successfully."
echo "Saved to: $CONFIG_FILE"
