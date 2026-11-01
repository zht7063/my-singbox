#!/usr/bin/env bats
# Smoke tests for scripts/gen-keys.sh. docker and curl are PATH stubs, so no
# container is started and no network request is made.

load helpers

setup() {
    setup_project
    export SING_BOX_VERSION=1.12.0
}

@test "gen-keys: requires SING_BOX_VERSION" {
    unset SING_BOX_VERSION
    run bash "$PROJECT/scripts/gen-keys.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Please set SING_BOX_VERSION"* ]]
    [ ! -e "$PROJECT/.env" ]
}

@test "gen-keys: refuses to overwrite an existing .env" {
    echo 'sentinel' > "$PROJECT/.env"
    stub_docker_ok
    run bash "$PROJECT/scripts/gen-keys.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *".env already exists. Refusing to overwrite."* ]]
    [ "$(cat "$PROJECT/.env")" = "sentinel" ]
    [ "$(stub_call_count '^docker ')" -eq 0 ]
}

@test "gen-keys: fails before generating anything when the Docker daemon is down" {
    stub_docker_down
    run bash "$PROJECT/scripts/gen-keys.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Docker daemon is not running."* ]]
    [ ! -e "$PROJECT/.env" ]
}

@test "gen-keys: writes a complete mode-600 .env that gen-config and conf-clash accept" {
    stub_docker_ok
    stub_cmd curl 'echo 8.8.8.8'
    run bash "$PROJECT/scripts/gen-keys.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Credentials generated successfully."* ]]

    [ "$(stat -c %a "$PROJECT/.env")" = "600" ]
    [ "$(env_value "$PROJECT/.env" SING_BOX_VERSION)" = "1.12.0" ]
    [ "$(env_value "$PROJECT/.env" SERVER_ADDRESS)" = "8.8.8.8" ]
    [ "$(env_value "$PROJECT/.env" VLESS_UUID)" = "$FIXTURE_UUID" ]
    [ "$(env_value "$PROJECT/.env" REALITY_PRIVATE_KEY)" = "$FIXTURE_PRIVATE_KEY" ]
    [ "$(env_value "$PROJECT/.env" REALITY_PUBLIC_KEY)" = "$FIXTURE_PUBLIC_KEY" ]
    [ "$(env_value "$PROJECT/.env" SS_PASSWORD)" = "$FIXTURE_SS_PASSWORD" ]
    [[ "$(env_value "$PROJECT/.env" REALITY_SHORT_ID)" =~ ^[0-9a-f]{16}$ ]]

    # The generated .env round-trips through the two renderers.
    run bash "$PROJECT/scripts/gen-config.sh"
    [ "$status" -eq 0 ]
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 0 ]
}

@test "gen-keys: prompts for the address when detection fails" {
    stub_docker_ok
    stub_cmd curl 'exit 22'
    run bash "$PROJECT/scripts/gen-keys.sh" <<< "8.8.4.4"
    [ "$status" -eq 0 ]
    [ "$(env_value "$PROJECT/.env" SERVER_ADDRESS)" = "8.8.4.4" ]
}
