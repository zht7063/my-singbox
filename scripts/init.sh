#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "Error: run as root. Re-run with: sudo bash scripts/init.sh" >&2
    exit 1
fi

if [[ ! -f /etc/os-release ]]; then
    echo "Error: /etc/os-release not found. This script supports Debian and Ubuntu only." >&2
    exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release

case "${ID:-}" in
    debian|ubuntu)
        ;;
    *)
        echo "Error: unsupported operating system (ID=${ID:-unknown}). This script supports Debian and Ubuntu only." >&2
        exit 1
        ;;
esac

if ! command -v apt-get >/dev/null 2>&1; then
    echo "Error: apt-get not found. This script supports Debian and Ubuntu apt systems only." >&2
    exit 1
fi

is_installed() {
    local status
    status="$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)"
    [[ "$status" == "install ok installed" ]]
}

packages=(ca-certificates curl openssl iproute2 git)
if ! command -v awk >/dev/null 2>&1; then
    packages+=(gawk)
fi
if ! command -v grep >/dev/null 2>&1; then
    packages+=(grep)
fi
if ! command -v dirname >/dev/null 2>&1 || ! command -v chmod >/dev/null 2>&1; then
    packages+=(coreutils)
fi

missing=()
for pkg in "${packages[@]}"; do
    if ! is_installed "$pkg"; then
        missing+=("$pkg")
    fi
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
if ((${#missing[@]} > 0)); then
    echo "Installing: ${missing[*]}"
    apt-get install -y --no-install-recommends "${missing[@]}"
else
    echo "Non-Docker prerequisite packages are already installed."
fi

report_cmd() {
    local name=$1
    if command -v "$name" >/dev/null 2>&1; then
        echo "${name}: present"
    else
        echo "${name}: absent"
    fi
}

echo "Prerequisite summary:"
report_cmd bash
report_cmd git
report_cmd curl
report_cmd wget
report_cmd openssl
report_cmd awk
report_cmd grep
report_cmd dirname
report_cmd chmod
report_cmd ss
if [[ -f /etc/ssl/certs/ca-certificates.crt ]]; then
    echo "ca-certificates: present"
else
    echo "ca-certificates: absent"
fi

if command -v docker >/dev/null 2>&1; then
    echo "docker: present"
else
    echo "docker: absent"
    echo "Warning: docker is not available. See README.md (Appendix: Quick Docker installation) or README_CN.md (附录：快速安装 Docker)." >&2
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "docker compose: present"
else
    echo "docker compose: absent"
    echo "Warning: docker compose is not available. See README.md (Appendix: Quick Docker installation) or README_CN.md (附录：快速安装 Docker)." >&2
fi
