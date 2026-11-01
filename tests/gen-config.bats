#!/usr/bin/env bats
# Smoke tests for scripts/gen-config.sh (hermetic: runs in a temp copy).

load helpers

setup() {
    setup_project
    write_env
}

run_gen_config() {
    run bash "$PROJECT/scripts/gen-config.sh"
}

@test "gen-config: renders config.json from .env" {
    run_gen_config
    [ "$status" -eq 0 ]
    [[ "$output" == *"Config generated successfully."* ]]
    [ -f "$PROJECT/config.json" ]
    jq -e . "$PROJECT/config.json" >/dev/null
}

@test "gen-config: output is mode 600 and has no leftover placeholders" {
    run_gen_config
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "$PROJECT/config.json")" = "600" ]
    ! grep -F '${' "$PROJECT/config.json"
}

@test "gen-config: credentials land beside the right fields" {
    run_gen_config
    [ "$status" -eq 0 ]
    local cfg="$PROJECT/config.json"
    [ "$(jq -r '.inbounds[] | select(.type=="shadowsocks") | .password' "$cfg")" = "$FIXTURE_SS_PASSWORD" ]
    [ "$(jq -r '.inbounds[] | select(.type=="vless") | .users[0].uuid' "$cfg")" = "$FIXTURE_UUID" ]
    [ "$(jq -r '.inbounds[] | select(.type=="vless") | .tls.reality.private_key' "$cfg")" = "$FIXTURE_PRIVATE_KEY" ]
    [ "$(jq -r '.inbounds[] | select(.type=="vless") | .tls.reality.short_id[0]' "$cfg")" = "$FIXTURE_SHORT_ID" ]
}

@test "gen-config: client-only public key and server address are not written" {
    run_gen_config
    [ "$status" -eq 0 ]
    ! grep -F "$FIXTURE_PUBLIC_KEY" "$PROJECT/config.json"
    ! grep -F "$FIXTURE_SERVER_ADDRESS" "$PROJECT/config.json"
}

@test "gen-config: keeps the original two inbounds and the direct outbound" {
    run_gen_config
    [ "$status" -eq 0 ]
    [ "$(jq -r '[.inbounds[].listen_port] | sort | join(",")' "$PROJECT/config.json")" = "8388,8443" ]
    [ "$(jq -r '.outbounds | map(.tag) | join(",")' "$PROJECT/config.json")" = "direct" ]
}

@test "gen-config: refuses to overwrite an existing config.json" {
    echo 'sentinel' > "$PROJECT/config.json"
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"Refusing to overwrite"* ]]
    [ "$(cat "$PROJECT/config.json")" = "sentinel" ]
}

@test "gen-config: dies on an unknown .env key" {
    echo 'FOO_BAR=1' >> "$PROJECT/.env"
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown .env key: FOO_BAR"* ]]
    [ ! -e "$PROJECT/config.json" ]
}

@test "gen-config: dies on a duplicate .env key" {
    echo "SS_PASSWORD=$FIXTURE_SS_PASSWORD" >> "$PROJECT/.env"
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate .env key: SS_PASSWORD"* ]]
}

@test "gen-config: dies on a missing required key" {
    write_env SS_PASSWORD=
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"Missing .env key: SS_PASSWORD"* ]]
    [ ! -e "$PROJECT/config.json" ]
}

@test "gen-config: dies on a malformed .env line" {
    echo 'not a key value line' >> "$PROJECT/.env"
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid .env line"* ]]
}

@test "gen-config: dies on invalid credential formats" {
    write_env VLESS_UUID=not-a-uuid
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid credentials in .env."* ]]
    [ ! -e "$PROJECT/config.json" ]
}

@test "gen-config: dies when .env is missing" {
    rm "$PROJECT/.env"
    run_gen_config
    [ "$status" -eq 1 ]
    [[ "$output" == *".env does not exist"* ]]
}

@test "gen-config: tolerates CRLF line endings and comments in .env" {
    sed -i 's/$/\r/' "$PROJECT/.env"
    printf '# a comment\r\n\r\n' >> "$PROJECT/.env"
    run_gen_config
    [ "$status" -eq 0 ]
    jq -e . "$PROJECT/config.json" >/dev/null
}

@test "gen-config: does not depend on the current directory" {
    cd /
    run_gen_config
    [ "$status" -eq 0 ]
    [ -f "$PROJECT/config.json" ]
}
