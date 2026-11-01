#!/usr/bin/env bats
# Guards templates/clash.yaml.template. The node and group rename was the only
# change allowed to touch it: nothing but the names may differ from the
# original template.

load helpers

T="$REPO_ROOT/templates/clash.yaml.template"

# SHA-256 of templates/clash.yaml.template before the rename
# (My-sing-box / My-VLESS-Reality / PROXY).
ORIGINAL_SHA256="169cc1356c9e0c79d7b692c511a69ca12619a781adb433de83903dc8e1fbb36d"

@test "clash template: reversing the three renames gives back the original template byte for byte" {
    local restored="$BATS_TEST_TMPDIR/restored.template"
    sed -e 's/shadowsocks/My-sing-box/g' \
        -e 's/vless-reality/My-VLESS-Reality/g' \
        -e 's/\bProxy\b/PROXY/g' "$T" > "$restored"
    [ "$(sha256sum < "$restored" | cut -d' ' -f1)" = "$ORIGINAL_SHA256" ]
}

@test "clash template: no old names are left" {
    refute grep -Eq 'My-sing-box|My-VLESS-Reality|PROXY' "$T"
}

@test "clash template: the new names appear exactly where the old ones did" {
    # node definitions + group members
    [ "$(grep -c 'shadowsocks' "$T")" -eq 2 ]
    [ "$(grep -c 'vless-reality' "$T")" -eq 2 ]
    # group definition + 10 rule targets + 2 dns nameservers
    [ "$(grep -Ec '^  - name: Proxy$' "$T")" -eq 1 ]
    [ "$(grep -Ec '^  - [A-Z-]+,(.*,)?Proxy$' "$T")" -eq 10 ]
    [ "$(grep -Ec 'dns-query#Proxy"$' "$T")" -eq 2 ]
}

@test "clash template: rules, rule-providers and dns settings are unchanged" {
    # meta-proxy is a rule-provider name, not the group, and must stay lowercase.
    grep -Fq '  - RULE-SET,meta-proxy,Proxy' "$T"
    grep -Fq '  meta-proxy:' "$T"
    grep -Fq 'path: ./ruleset/meta-proxy.mrs' "$T"
}
