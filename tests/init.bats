#!/usr/bin/env bats
# Smoke test for scripts/init.sh. It only exercises the non-root refusal; the
# apt-get path is never run.

load helpers

setup() {
    setup_project
}

@test "init: refuses to run as a non-root user" {
    if [[ "$EUID" -eq 0 ]]; then
        skip "running as root; init.sh would proceed to apt-get"
    fi
    stub_cmd apt-get 'exit 0'
    run bash "$PROJECT/scripts/init.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"run as root"* ]]
    [ "$(stub_call_count '^apt-get ')" -eq 0 ]
}
