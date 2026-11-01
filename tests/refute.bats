#!/usr/bin/env bats
# The refute helper replaces `! CMD`, which bash's errexit ignores. These tests
# prove that refute really fails when the command succeeds.

load helpers

@test "refute: passes when the command fails" {
    refute false
    refute grep -q needle /dev/null
}

@test "refute: fails when the command succeeds" {
    run refute true
    [ "$status" -eq 1 ]
    [[ "$output" == *"expected failure"* ]]
}

@test "refute: a failing refute fails the test (unlike a bare '!')" {
    run bash -c 'set -e; ! true; echo reached'
    [ "$status" -eq 0 ]            # the bare '!' did not stop the script
    run bash -c 'set -e; refute() { if "$@"; then return 1; fi; }; refute true; echo reached'
    [ "$status" -eq 1 ]
}
