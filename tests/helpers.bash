# Shared helpers for the bats tests. Load with: load helpers
#
# Every test runs against a throw-away copy of the project under
# $BATS_TEST_TMPDIR, so the real repository, the host's /opt/sing-box and
# any real service are never touched. External commands (docker, curl, ss,
# ...) are replaced by stubs placed first on PATH.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Valid fixture credentials that pass the scripts' format checks.
FIXTURE_UUID="11111111-2222-3333-4444-555555555555"
FIXTURE_PRIVATE_KEY="PRIVprivPRIVprivPRIVprivPRIVprivPRIVprivP_-"
FIXTURE_PUBLIC_KEY="PUBpubPUBpubPUBpubPUBpubPUBpubPUBpubPUBpx_-"
FIXTURE_SHORT_ID="0123456789abcdef"
FIXTURE_SS_PASSWORD="AAAAAAAAAAAAAAAAAAAAAA=="
FIXTURE_SERVER_ADDRESS="203.0.113.10"

# Create a copy of the project (scripts + templates only) in $PROJECT and
# an empty stub directory in front of PATH.
setup_project() {
    PROJECT="$BATS_TEST_TMPDIR/project"
    STUB_DIR="$BATS_TEST_TMPDIR/stubs"
    STUB_LOG="$BATS_TEST_TMPDIR/stub-calls.log"
    mkdir -p "$PROJECT" "$STUB_DIR"
    cp -R "$REPO_ROOT/scripts" "$REPO_ROOT/templates" "$PROJECT/"
    cp "$REPO_ROOT/compose.yaml" "$PROJECT/"
    : > "$STUB_LOG"
    export PATH="$STUB_DIR:$PATH"
    export STUB_LOG
}

# Write a fixture .env. Pass KEY=VALUE overrides as arguments; a KEY given
# with an empty value (KEY=) drops that key. Extra lines can be appended
# afterwards with: echo 'X=1' >> "$PROJECT/.env"
write_env() {
    local -A env_map=(
        [SING_BOX_VERSION]="1.12.0"
        [VLESS_UUID]="$FIXTURE_UUID"
        [REALITY_PRIVATE_KEY]="$FIXTURE_PRIVATE_KEY"
        [REALITY_PUBLIC_KEY]="$FIXTURE_PUBLIC_KEY"
        [REALITY_SHORT_ID]="$FIXTURE_SHORT_ID"
        [SS_PASSWORD]="$FIXTURE_SS_PASSWORD"
        [SERVER_ADDRESS]="$FIXTURE_SERVER_ADDRESS"
    )
    local arg key
    for arg in "$@"; do
        env_map[${arg%%=*}]="${arg#*=}"
    done
    : > "$PROJECT/.env"
    for key in SING_BOX_VERSION VLESS_UUID REALITY_PRIVATE_KEY REALITY_PUBLIC_KEY \
               REALITY_SHORT_ID SS_PASSWORD SERVER_ADDRESS; do
        if [[ -n "${env_map[$key]}" ]]; then
            printf '%s=%s\n' "$key" "${env_map[$key]}" >> "$PROJECT/.env"
        fi
    done
    chmod 600 "$PROJECT/.env"
}

# stub_cmd NAME [BODY]
# Install an executable stub NAME in $STUB_DIR. BODY is shell code (default:
# exit 0). Every call is appended to $STUB_LOG as "NAME arg1 arg2 ...".
stub_cmd() {
    local name=$1
    local body=${2:-'exit 0'}
    {
        printf '%s\n' '#!/usr/bin/env bash'
        printf '%s\n' "echo \"$name \$*\" >> \"\$STUB_LOG\""
        printf '%s\n' "$body"
    } > "$STUB_DIR/$name"
    chmod +x "$STUB_DIR/$name"
}

# Number of recorded stub calls whose line matches the given grep -E pattern.
stub_call_count() {
    grep -Ecs -- "$1" "$STUB_LOG" || true
}

# Stub a docker that behaves like a healthy daemon with a running sing-box
# container. gen-keys.sh style "docker run ... generate ..." calls return
# well-formed credentials.
stub_docker_ok() {
    stub_cmd docker '
case "$1" in
    info) exit 0 ;;
    compose)
        case "$2" in
            version) echo "Docker Compose version v2.0.0-stub" ;;
        esac
        exit 0 ;;
    inspect) echo running; exit 0 ;;
    run)
        case "$*" in
            *"generate uuid"*) echo "11111111-2222-3333-4444-555555555555" ;;
            *"generate reality-keypair"*)
                echo "PrivateKey: PRIVprivPRIVprivPRIVprivPRIVprivPRIVprivP_-"
                echo "PublicKey: PUBpubPUBpubPUBpubPUBpubPUBpubPUBpubPUBpx_-" ;;
            *"generate rand --base64 16"*) echo "AAAAAAAAAAAAAAAAAAAAAA==" ;;
        esac
        exit 0 ;;
esac
exit 0'
}

# Stub a docker whose daemon is down.
stub_docker_down() {
    stub_cmd docker '
case "$1" in
    info) exit 1 ;;
esac
exit 0'
}

# Print the value of KEY in the "KEY=value" file FILE (first match).
env_value() {
    sed -n "s/^$2=//p" "$1" | head -n 1
}

# Pick a TCP port that is currently free on 127.0.0.1.
free_port() {
    python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()'
}
