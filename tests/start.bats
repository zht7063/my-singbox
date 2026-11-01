#!/usr/bin/env bats
# Smoke tests for scripts/start.sh. docker is a PATH stub; nothing is started.

load helpers

setup() {
    setup_project
}

LISTENER_PID=""

teardown() {
    if [[ -n "$LISTENER_PID" ]]; then
        kill "$LISTENER_PID" 2>/dev/null || true
    fi
}

@test "start: dies when config.json is missing" {
    stub_docker_ok
    run bash "$PROJECT/scripts/start.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"config.json does not exist"* ]]
    [ "$(stub_call_count '^docker ')" -eq 0 ]
}

@test "start: dies when config.json has no listen_port" {
    echo '{}' > "$PROJECT/config.json"
    stub_docker_ok
    run bash "$PROJECT/scripts/start.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"config.json has no listen_port"* ]]
}

@test "start: rejects an out-of-range listen_port" {
    echo '{"inbounds":[{"listen_port": 70000}]}' > "$PROJECT/config.json"
    stub_docker_ok
    run bash "$PROJECT/scripts/start.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid listen_port in config.json: 70000"* ]]
}

@test "start: dies when docker is not installed" {
    echo '{"inbounds":[{"listen_port": 8443}]}' > "$PROJECT/config.json"
    # Keep a PATH with the basic tools the script needs but no docker.
    local bin="$BATS_TEST_TMPDIR/nodocker"
    mkdir -p "$bin"
    local tool
    for tool in bash dirname grep cat; do
        ln -s "$(command -v "$tool")" "$bin/$tool"
    done
    PATH="$bin" run "$(command -v bash)" "$PROJECT/scripts/start.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker is not installed."* ]]
}

@test "start: dies when the Docker daemon is down" {
    echo '{"inbounds":[{"listen_port": 8443}]}' > "$PROJECT/config.json"
    stub_docker_down
    run bash "$PROJECT/scripts/start.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Docker daemon is not running."* ]]
    [ "$(stub_call_count '^docker compose up')" -eq 0 ]
}

@test "start: self-check passes against a stubbed docker and a live local port" {
    command -v python3 >/dev/null || skip "python3 is required for the local listener"
    local port
    port="$(free_port)"
    python3 -c "
import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $port))
s.listen(5)
time.sleep(60)
" &
    LISTENER_PID=$!
    printf '{"inbounds":[{"listen_port": %s}]}\n' "$port" > "$PROJECT/config.json"
    stub_docker_ok
    stub_cmd sleep 'exit 0'
    # Give the listener a moment to bind.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        bash -c "echo >/dev/tcp/127.0.0.1/$port" 2>/dev/null && break
        /bin/sleep 0.2
    done

    run bash "$PROJECT/scripts/start.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Self-check passed. Ports: $port"* ]]
    [ "$(stub_call_count '^docker compose --project-directory .* up -d')" -eq 1 ]
}
