#!/usr/bin/env bash
set -euo pipefail
umask 077

# Project paths
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_TEMPLATE="$PROJECT_DIR/templates/.env.template"
ENV_FILE="$PROJECT_DIR/.env"
TEMPLATE_FILE="$PROJECT_DIR/templates/clash.yaml.template"
CLASH_FILE="$PROJECT_DIR/clash.yaml"

die() {
    echo "Error: $*" >&2
    exit 1
}

# Client profile fields. REALITY_PRIVATE_KEY stays on the server.
REQUIRED_KEYS=(
    SERVER_ADDRESS
    VLESS_UUID
    REALITY_PUBLIC_KEY
    REALITY_SHORT_ID
    SS_PASSWORD
)

if [[ ! -f "$ENV_TEMPLATE" ]]; then
    die "Template does not exist: $ENV_TEMPLATE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
    die ".env does not exist. Run scripts/gen-keys.sh first."
fi

if [[ ! -f "$TEMPLATE_FILE" ]]; then
    die "Template does not exist: $TEMPLATE_FILE"
fi

if [[ -e "$CLASH_FILE" ]]; then
    die "clash.yaml already exists. Refusing to overwrite."
fi

loaded_keys=" "

# templates/.env.template supplies operator settings such as SERVER_ADDRESS.
# .env is loaded second and overrides generated credentials.
load_env() {
    local file=$1
    local label=$2
    local line key value seen=" "

    while IFS= read -r line || [[ -n "$line" ]]; do
        line=${line%$'\r'}

        if [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]]; then
            continue
        fi

        if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            die "Invalid line in $label: $line"
        fi

        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"

        if [[ "$seen" == *" $key "* ]]; then
            die "Duplicate key in $label: $key"
        fi
        seen+=" $key "

        case "$key" in
            SING_BOX_VERSION|VLESS_UUID|REALITY_PRIVATE_KEY|REALITY_PUBLIC_KEY|REALITY_SHORT_ID|SS_PASSWORD|SERVER_ADDRESS)
                printf -v "$key" '%s' "$value"
                ;;
            ISP_SOCKS_ADDR|ISP_SOCKS_USER|ISP_SOCKS_PASS)
                # Optional ISP outbound settings written by scripts/isp-outbound.sh.
                # Accepted so they do not trip the whitelist, but never rendered.
                ;;
            *)
                die "Unknown key in $label: $key"
                ;;
        esac

        if [[ "$loaded_keys" != *" $key "* ]]; then
            loaded_keys+=" $key "
        fi
    done < "$file"
}

load_env "$ENV_TEMPLATE" "templates/.env.template"
load_env "$ENV_FILE" ".env"

for key in "${REQUIRED_KEYS[@]}"; do
    if [[ "$loaded_keys" != *" $key "* ]]; then
        die "Missing key: $key"
    fi
done

if [[ "$SERVER_ADDRESS" == "<server-address>" ]]; then
    die "Set SERVER_ADDRESS in templates/.env.template or .env."
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

is_ipv6() {
    local value=$1 colons
    [[ "$value" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
    [[ "$value" == *::*::* ]] && return 1
    [[ "$value" == *:::* ]] && return 1
    colons=${value//[^:]}
    [[ ${#colons} -ge 2 && ${#colons} -le 7 ]]
}

is_hostname() {
    local value=$1
    [[ ${#value} -le 253 ]] || return 1
    [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]]
}

if [[ "$SERVER_ADDRESS" =~ ^[0-9.]+$ ]]; then
    is_ipv4 "$SERVER_ADDRESS" || die "Invalid SERVER_ADDRESS. Set it in templates/.env.template or .env."
elif [[ "$SERVER_ADDRESS" == *:* ]]; then
    is_ipv6 "$SERVER_ADDRESS" || die "Invalid SERVER_ADDRESS. Set it in templates/.env.template or .env."
else
    is_hostname "$SERVER_ADDRESS" || die "Invalid SERVER_ADDRESS. Set it in templates/.env.template or .env."
fi

if [[ ! "$VLESS_UUID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    die "Invalid VLESS_UUID."
fi
if [[ ! "$REALITY_PUBLIC_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    die "Invalid REALITY_PUBLIC_KEY."
fi
if [[ ! "$REALITY_SHORT_ID" =~ ^[0-9a-f]{16}$ ]]; then
    die "Invalid REALITY_SHORT_ID."
fi
if [[ ! "$SS_PASSWORD" =~ ^[A-Za-z0-9+/]{22}==$ ]]; then
    die "Invalid SS_PASSWORD."
fi

template="$(<"$TEMPLATE_FILE")"

expect_count() {
    local needle=$1
    local want=$2
    local stripped=${template//"$needle"/}
    local count=$(( (${#template} - ${#stripped}) / ${#needle} ))

    if [[ "$count" -ne "$want" ]]; then
        die "Template must contain $(printf '%s' "$needle") exactly $want times."
    fi
}

expect_count 'server: "${SERVER_ADDRESS}"' 2
expect_count 'uuid: "${VLESS_UUID}"' 1
expect_count 'public-key: "${REALITY_PUBLIC_KEY}"' 1
expect_count 'short-id: "${REALITY_SHORT_ID}"' 1
expect_count 'password: "${SS_PASSWORD}"' 1

if [[ "$template" == *'REALITY_PRIVATE_KEY'* ]]; then
    die "Template must not contain REALITY_PRIVATE_KEY."
fi

rendered=$template
server_address_placeholder='${SERVER_ADDRESS}'
vless_uuid_placeholder='${VLESS_UUID}'
reality_public_key_placeholder='${REALITY_PUBLIC_KEY}'
reality_short_id_placeholder='${REALITY_SHORT_ID}'
ss_password_placeholder='${SS_PASSWORD}'
rendered=${rendered//"$server_address_placeholder"/"$SERVER_ADDRESS"}
rendered=${rendered//"$vless_uuid_placeholder"/"$VLESS_UUID"}
rendered=${rendered//"$reality_public_key_placeholder"/"$REALITY_PUBLIC_KEY"}
rendered=${rendered//"$reality_short_id_placeholder"/"$REALITY_SHORT_ID"}
rendered=${rendered//"$ss_password_placeholder"/"$SS_PASSWORD"}

if [[ "$rendered" == *'${'* ]]; then
    die "Unresolved placeholder left in clash.yaml."
fi

if [[ -n "${REALITY_PRIVATE_KEY:-}" && "$rendered" == *"$REALITY_PRIVATE_KEY"* ]]; then
    die "Refusing to write REALITY_PRIVATE_KEY into clash.yaml."
fi

for key in SERVER_ADDRESS VLESS_UUID REALITY_PUBLIC_KEY REALITY_SHORT_ID SS_PASSWORD; do
    value="${!key}"
    if [[ "$rendered" != *"\"$value\""* ]]; then
        die "Failed to place $key into clash.yaml."
    fi
done

(
    set -o noclobber
    printf '%s\n' "$rendered" > "$CLASH_FILE"
)

chmod 600 "$CLASH_FILE"

echo "Clash config generated successfully."
echo "Saved to: $CLASH_FILE"
