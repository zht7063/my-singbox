#!/usr/bin/env bats
# Smoke tests for scripts/conf-clash.sh (hermetic: runs in a temp copy).

load helpers

setup() {
    setup_project
    write_env
}

run_conf_clash() {
    run bash "$PROJECT/scripts/conf-clash.sh"
}

@test "conf-clash: renders clash.yaml from .env" {
    run_conf_clash
    [ "$status" -eq 0 ]
    [[ "$output" == *"Clash config generated successfully."* ]]
    [ -f "$PROJECT/clash.yaml" ]
}

@test "conf-clash: output is mode 600 and has no leftover placeholders" {
    run_conf_clash
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "$PROJECT/clash.yaml")" = "600" ]
    ! grep -F '${' "$PROJECT/clash.yaml"
}

@test "conf-clash: client credentials are filled in" {
    run_conf_clash
    [ "$status" -eq 0 ]
    local f="$PROJECT/clash.yaml"
    [ "$(grep -c "server: \"$FIXTURE_SERVER_ADDRESS\"" "$f")" -eq 2 ]
    grep -Fq "password: \"$FIXTURE_SS_PASSWORD\"" "$f"
    grep -Fq "uuid: \"$FIXTURE_UUID\"" "$f"
    grep -Fq "public-key: \"$FIXTURE_PUBLIC_KEY\"" "$f"
    grep -Fq "short-id: \"$FIXTURE_SHORT_ID\"" "$f"
}

@test "conf-clash: never writes the Reality private key" {
    run_conf_clash
    [ "$status" -eq 0 ]
    ! grep -F "$FIXTURE_PRIVATE_KEY" "$PROJECT/clash.yaml"
}

@test "conf-clash: has the two proxies and the Proxy group" {
    run_conf_clash
    [ "$status" -eq 0 ]
    local f="$PROJECT/clash.yaml"
    grep -Eq '^  - name: "shadowsocks"$' "$f"
    grep -Eq '^  - name: vless-reality$' "$f"
    grep -Eq '^  - name: Proxy$' "$f"
    # The group lists both nodes and falls back to DIRECT.
    grep -Eq '^      - shadowsocks$' "$f"
    grep -Eq '^      - vless-reality$' "$f"
    # No trace of the old names.
    ! grep -Eq 'My-sing-box|My-VLESS-Reality|PROXY' "$f"
}

@test "conf-clash: refuses to overwrite an existing clash.yaml" {
    echo 'sentinel' > "$PROJECT/clash.yaml"
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Refusing to overwrite"* ]]
    [ "$(cat "$PROJECT/clash.yaml")" = "sentinel" ]
}

@test "conf-clash: dies on an unknown .env key" {
    echo 'ISP_SOCKS_ADDR=1.2.3.4:1080' >> "$PROJECT/.env"
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown key in .env: ISP_SOCKS_ADDR"* ]]
    [ ! -e "$PROJECT/clash.yaml" ]
}

@test "conf-clash: dies on a duplicate .env key" {
    echo "VLESS_UUID=$FIXTURE_UUID" >> "$PROJECT/.env"
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate key in .env: VLESS_UUID"* ]]
}

@test "conf-clash: a key missing from .env falls back to the template placeholder and is rejected" {
    # templates/.env.template defines every key with a "<...>" placeholder,
    # so a key absent from .env is reported as invalid rather than missing.
    write_env REALITY_PUBLIC_KEY=
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid REALITY_PUBLIC_KEY."* ]]
    [ ! -e "$PROJECT/clash.yaml" ]
}

@test "conf-clash: dies while SERVER_ADDRESS is still the template placeholder" {
    write_env SERVER_ADDRESS='<server-address>'
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Set SERVER_ADDRESS"* ]]
}

@test "conf-clash: rejects an invalid SERVER_ADDRESS" {
    write_env SERVER_ADDRESS=999.1.1.1
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid SERVER_ADDRESS"* ]]
}

@test "conf-clash: accepts a hostname and an IPv6 SERVER_ADDRESS" {
    write_env SERVER_ADDRESS=vpn.example.com
    run_conf_clash
    [ "$status" -eq 0 ]
    grep -Fq 'server: "vpn.example.com"' "$PROJECT/clash.yaml"

    rm "$PROJECT/clash.yaml"
    write_env SERVER_ADDRESS=2001:db8::1
    run_conf_clash
    [ "$status" -eq 0 ]
    grep -Fq 'server: "2001:db8::1"' "$PROJECT/clash.yaml"
}

@test "conf-clash: rejects invalid credential formats" {
    write_env SS_PASSWORD=short
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid SS_PASSWORD."* ]]
    [ ! -e "$PROJECT/clash.yaml" ]
}

@test "conf-clash: dies when .env is missing" {
    rm "$PROJECT/.env"
    run_conf_clash
    [ "$status" -eq 1 ]
    [[ "$output" == *".env does not exist"* ]]
}
