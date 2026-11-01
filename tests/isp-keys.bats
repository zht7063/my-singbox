#!/usr/bin/env bats
# Regression tests for the optional ISP_SOCKS_* .env keys (ADDR, USER, PASS, EGRESS_IP). gen-config.sh and
# conf-clash.sh must accept them without ever rendering them, and must behave
# exactly as before when they are absent.

load helpers

setup() {
    setup_project
    write_env
}

# Value sets appended to .env. Each is a newline-separated list of lines.
ISP_EMPTY=$'ISP_SOCKS_ADDR=\nISP_SOCKS_USER=\nISP_SOCKS_PASS=\nISP_SOCKS_EGRESS_IP='
ISP_B64=$'ISP_SOCKS_ADDR=198.51.100.7:1080\nISP_SOCKS_USER=b64:dXNlci5uYW1l\nISP_SOCKS_PASS=b64:cEBzczp3L3JkIzEkSE9NRSBgaWRgOyJhJ2JcZA+/==\nISP_SOCKS_EGRESS_IP=198.51.100.99'
ISP_B64_IPV6=$'ISP_SOCKS_ADDR=[2001:db8::1]:1080\nISP_SOCKS_USER=b64:+/+/\nISP_SOCKS_PASS=b64:A==\nISP_SOCKS_EGRESS_IP=2001:db8::99'
ISP_RAW=$'ISP_SOCKS_ADDR=198.51.100.7:1080\nISP_SOCKS_USER=us er\nISP_SOCKS_PASS=p@ss:w/rd#1 $HOME `id` "a\'b\\c"'
ISP_ONE_KEY=$'ISP_SOCKS_PASS=b64:c2VjcmV0'
ISP_EGRESS_ONLY=$'ISP_SOCKS_EGRESS_IP=198.51.100.99'

# render SCRIPT OUTPUT_NAME -> run the script, then move its output to
# $BATS_TEST_TMPDIR/<label>.<OUTPUT_NAME> so it can be re-rendered.
render_to() {
    local script=$1 out=$2 label=$3
    run bash "$PROJECT/scripts/$script"
    [ "$status" -eq 0 ]
    mv "$PROJECT/$out" "$BATS_TEST_TMPDIR/$label.$out"
}

# assert_unchanged SCRIPT OUTPUT VALUE_SET
# Render once without ISP keys, once with them; the two outputs must be
# byte-identical and must not contain any of the ISP values.
assert_unchanged() {
    local script=$1 out=$2 extra=$3 line value
    render_to "$script" "$out" baseline
    printf '%s\n' "$extra" >> "$PROJECT/.env"
    render_to "$script" "$out" withisp
    cmp "$BATS_TEST_TMPDIR/baseline.$out" "$BATS_TEST_TMPDIR/withisp.$out"
    while IFS= read -r line; do
        value="${line#*=}"
        if [[ -n "$value" ]]; then
            ! grep -qF -- "$value" "$BATS_TEST_TMPDIR/withisp.$out"
        fi
    done <<< "$extra"
}

# ---- templates/.env.template ------------------------------------------------

@test "env.template: ISP keys are present, commented out and empty" {
    local t="$REPO_ROOT/templates/.env.template"
    grep -Fxq '# ISP_SOCKS_ADDR=' "$t"
    grep -Fxq '# ISP_SOCKS_USER=' "$t"
    grep -Fxq '# ISP_SOCKS_PASS=' "$t"
    ! grep -Eq '^[[:space:]]*ISP_SOCKS_' "$t"
}

@test "env.template: ISP_SOCKS_EGRESS_IP is the fourth key, commented out and empty" {
    grep -Fxq '# ISP_SOCKS_EGRESS_IP=' "$REPO_ROOT/templates/.env.template"
    ! grep -Eq '^[[:space:]]*ISP_SOCKS_EGRESS_IP' "$REPO_ROOT/templates/.env.template"
}

@test "env.template: carries the 'filled automatically' comment" {
    grep -Fq '# Optional; filled automatically by scripts/isp-outbound.sh, no need to edit manually.' \
        "$REPO_ROOT/templates/.env.template"
}

@test "env.template: conf-clash reads the template with the commented ISP lines" {
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 0 ]
}

@test "env.template: output is identical to a template that has no ISP block at all" {
    render_to conf-clash.sh clash.yaml withblock
    grep -viE 'isp' "$PROJECT/templates/.env.template" > "$BATS_TEST_TMPDIR/stripped"
    ! grep -qi 'isp' "$BATS_TEST_TMPDIR/stripped"
    cp "$BATS_TEST_TMPDIR/stripped" "$PROJECT/templates/.env.template"
    render_to conf-clash.sh clash.yaml noblock
    cmp "$BATS_TEST_TMPDIR/withblock.clash.yaml" "$BATS_TEST_TMPDIR/noblock.clash.yaml"
}

# ---- gen-config.sh -----------------------------------------------------------

@test "gen-config: no ISP keys at all still renders (regression)" {
    ! grep -q 'ISP_' "$PROJECT/.env"
    run bash "$PROJECT/scripts/gen-config.sh"
    [ "$status" -eq 0 ]
    jq -e . "$PROJECT/config.json" >/dev/null
}

@test "gen-config: output is byte-identical with empty ISP keys" {
    assert_unchanged gen-config.sh config.json "$ISP_EMPTY"
}

@test "gen-config: output is byte-identical with b64:-prefixed ISP values" {
    assert_unchanged gen-config.sh config.json "$ISP_B64"
}

@test "gen-config: output is byte-identical with b64: IPv6 address form" {
    assert_unchanged gen-config.sh config.json "$ISP_B64_IPV6"
}

@test "gen-config: output is byte-identical with raw special characters in ISP values" {
    assert_unchanged gen-config.sh config.json "$ISP_RAW"
}

@test "gen-config: output is byte-identical with only one ISP key" {
    assert_unchanged gen-config.sh config.json "$ISP_ONE_KEY"
}

@test "gen-config: output is byte-identical with only ISP_SOCKS_EGRESS_IP set" {
    assert_unchanged gen-config.sh config.json "$ISP_EGRESS_ONLY"
}

@test "gen-config: ISP keys placed before the other keys are accepted" {
    render_to gen-config.sh config.json baseline
    { printf '%s\n' "$ISP_B64"; cat "$PROJECT/.env"; } > "$PROJECT/.env.new"
    mv "$PROJECT/.env.new" "$PROJECT/.env"
    render_to gen-config.sh config.json withisp
    cmp "$BATS_TEST_TMPDIR/baseline.config.json" "$BATS_TEST_TMPDIR/withisp.config.json"
}

@test "gen-config: ISP keys never satisfy a required key" {
    write_env SS_PASSWORD=
    printf '%s\n' "$ISP_B64" >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/gen-config.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Missing .env key: SS_PASSWORD"* ]]
}

@test "gen-config: a duplicated ISP key still dies" {
    printf '%s\n%s\n' 'ISP_SOCKS_USER=b64:YQ==' 'ISP_SOCKS_USER=b64:Yg==' >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/gen-config.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate .env key: ISP_SOCKS_USER"* ]]
    [ ! -e "$PROJECT/config.json" ]
}

@test "gen-config: a duplicated empty ISP key still dies" {
    printf '%s\n%s\n' 'ISP_SOCKS_ADDR=' 'ISP_SOCKS_ADDR=' >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/gen-config.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate .env key: ISP_SOCKS_ADDR"* ]]
}

@test "gen-config: a duplicated ISP_SOCKS_EGRESS_IP still dies" {
    printf '%s\n%s\n' 'ISP_SOCKS_EGRESS_IP=198.51.100.1' 'ISP_SOCKS_EGRESS_IP=' >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/gen-config.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate .env key: ISP_SOCKS_EGRESS_IP"* ]]
    [ ! -e "$PROJECT/config.json" ]
}

@test "gen-config: only the four ISP keys are whitelisted" {
    local key
    for key in ISP_SOCKS ISP_SOCKS_PASSWORD ISP_SOCKS_ADDRESS ISP_SOCKS_EGRESS ISP_SOCKS_EGRESS_IPV4 ISP_EXPECTED_EGRESS_IP isp_socks_egress_ip FOO_BAR; do
        write_env
        echo "$key=x" >> "$PROJECT/.env"
        run bash "$PROJECT/scripts/gen-config.sh"
        [ "$status" -eq 1 ]
        [[ "$output" == *"Unknown .env key: $key"* ]]
        [ ! -e "$PROJECT/config.json" ]
    done
}

# ---- conf-clash.sh -----------------------------------------------------------

@test "conf-clash: no ISP keys at all still renders (regression)" {
    ! grep -q 'ISP_' "$PROJECT/.env"
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 0 ]
    grep -Fq "password: \"$FIXTURE_SS_PASSWORD\"" "$PROJECT/clash.yaml"
}

@test "conf-clash: output is byte-identical with empty ISP keys" {
    assert_unchanged conf-clash.sh clash.yaml "$ISP_EMPTY"
}

@test "conf-clash: output is byte-identical with b64:-prefixed ISP values" {
    assert_unchanged conf-clash.sh clash.yaml "$ISP_B64"
}

@test "conf-clash: output is byte-identical with b64: IPv6 address form" {
    assert_unchanged conf-clash.sh clash.yaml "$ISP_B64_IPV6"
}

@test "conf-clash: output is byte-identical with raw special characters in ISP values" {
    assert_unchanged conf-clash.sh clash.yaml "$ISP_RAW"
}

@test "conf-clash: output is byte-identical with only one ISP key" {
    assert_unchanged conf-clash.sh clash.yaml "$ISP_ONE_KEY"
}

@test "conf-clash: output is byte-identical with only ISP_SOCKS_EGRESS_IP set" {
    assert_unchanged conf-clash.sh clash.yaml "$ISP_EGRESS_ONLY"
}

@test "conf-clash: ISP keys never satisfy a required key" {
    write_env SERVER_ADDRESS=
    printf '%s\n' "$ISP_B64" >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Set SERVER_ADDRESS"* ]]
}

@test "conf-clash: a duplicated ISP key still dies" {
    printf '%s\n%s\n' 'ISP_SOCKS_PASS=b64:YQ==' 'ISP_SOCKS_PASS=b64:Yg==' >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate key in .env: ISP_SOCKS_PASS"* ]]
    [ ! -e "$PROJECT/clash.yaml" ]
}

@test "conf-clash: a duplicated empty ISP key still dies" {
    printf '%s\n%s\n' 'ISP_SOCKS_ADDR=' 'ISP_SOCKS_ADDR=' >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate key in .env: ISP_SOCKS_ADDR"* ]]
}

@test "conf-clash: ISP keys are accepted when uncommented in templates/.env.template too" {
    printf '%s\n' "$ISP_EMPTY" >> "$PROJECT/templates/.env.template"
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 0 ]
}

@test "conf-clash: a duplicated ISP_SOCKS_EGRESS_IP still dies" {
    printf '%s\n%s\n' 'ISP_SOCKS_EGRESS_IP=198.51.100.1' 'ISP_SOCKS_EGRESS_IP=' >> "$PROJECT/.env"
    run bash "$PROJECT/scripts/conf-clash.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Duplicate key in .env: ISP_SOCKS_EGRESS_IP"* ]]
    [ ! -e "$PROJECT/clash.yaml" ]
}

@test "conf-clash: only the four ISP keys are whitelisted" {
    local key
    for key in ISP_SOCKS ISP_SOCKS_PASSWORD ISP_SOCKS_ADDRESS ISP_SOCKS_EGRESS ISP_SOCKS_EGRESS_IPV4 ISP_EXPECTED_EGRESS_IP isp_socks_egress_ip FOO_BAR; do
        write_env
        echo "$key=x" >> "$PROJECT/.env"
        run bash "$PROJECT/scripts/conf-clash.sh"
        [ "$status" -eq 1 ]
        [[ "$output" == *"Unknown key in .env: $key"* ]]
        [ ! -e "$PROJECT/clash.yaml" ]
    done
}
