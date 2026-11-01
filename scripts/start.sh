#!/usr/bin/env bash
set -euo pipefail
umask 077

# Project paths
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/compose.yaml"
CONFIG_FILE="$PROJECT_DIR/config.json"
CONTAINER_NAME="sing-box"

die() {
    echo "Error: $*" >&2
    exit 1
}

compose() {
    docker compose --project-directory "$PROJECT_DIR" "$@"
}

show_logs() {
    compose logs --tail 50 "$CONTAINER_NAME" >&2 || true
}

if [[ ! -f "$COMPOSE_FILE" ]]; then
    die "compose.yaml does not exist."
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    die "config.json does not exist. Run scripts/gen-config.sh first."
fi

ports=" "
while IFS= read -r port; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
        die "Invalid listen_port in config.json: $port"
    fi
    if [[ "$ports" != *" $port "* ]]; then
        ports+="$port "
    fi
done < <(grep -E -o '"listen_port"[[:space:]]*:[[:space:]]*[0-9]+' "$CONFIG_FILE" | grep -E -o '[0-9]+$')

if [[ "$ports" == " " ]]; then
    die "config.json has no listen_port."
fi

if ! command -v docker >/dev/null 2>&1; then
    die "docker is not installed."
fi

if ! docker compose version >/dev/null 2>&1; then
    die "docker compose is not available."
fi

if ! docker info >/dev/null 2>&1; then
    die "Docker daemon is not running."
fi

echo "Starting sing-box..."
compose up -d

status="missing"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    status="$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo missing)"
    if [[ "$status" == "running" ]]; then
        break
    fi
    sleep 1
done

if [[ "$status" != "running" ]]; then
    show_logs
    die "sing-box did not stay running (status: $status)."
fi

if ! compose exec -T "$CONTAINER_NAME" sing-box check -c /etc/sing-box/config.json; then
    show_logs
    die "sing-box config check failed."
fi

wait_for_port() {
    local port=$1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if bash -c "echo >/dev/tcp/127.0.0.1/${port}" 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    show_logs
    die "Port ${port} is not accepting connections."
}

for port in $ports; do
    wait_for_port "$port"
done

# Shadowsocks 2022 also listens on UDP. Without privileges, ss -ulnp
# hides the process name; reject the port only when another owner is visible.
check_udp_listener() {
    local port=$1
    local line

    if ! command -v ss >/dev/null 2>&1; then
        echo "Warning: ss is not installed. Skipping UDP listener check for port ${port}." >&2
        return 0
    fi

    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if ss -uln | grep -Eq ":${port}[[:space:]]"; then
            line="$(ss -ulnp 2>/dev/null | grep -E ":${port}[[:space:]]" || true)"
            if [[ "$line" == *users:* && "$line" != *sing-box* ]]; then
                show_logs
                die "UDP port ${port} is not owned by sing-box."
            fi
            return 0
        fi
        sleep 1
    done

    show_logs
    die "UDP port ${port} is not listening."
}

if [[ "$ports" == *" 8388 "* ]]; then
    check_udp_listener 8388
fi

status="$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo missing)"
if [[ "$status" != "running" ]]; then
    show_logs
    die "sing-box did not stay running (status: $status)."
fi

echo "Self-check passed. Ports:${ports}"
