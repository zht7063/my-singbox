#!/usr/bin/env bash
# Bootstrap Node without sudo. Overrides: MY_SINGBOX_NODE_DIR (default
# $HOME/.local/node), MY_SINGBOX_NODE_VERSION (v22.23.4),
# MY_SINGBOX_NODE_MIRROR (download base), MY_SINGBOX_FORCE_NODE_INSTALL=1.
set -euo pipefail

legacy='https://github.com/zht7063/my-singbox/releases/tag/v1.1.0'
unsupported() {
  echo "ERROR: $*; use shell v1.1.0: $legacy" >&2
  exit 1
}

[[ $(uname -s) == Linux ]] || unsupported 'only Linux servers are supported'
case $(uname -m) in
  x86_64|amd64)
    arch=x64
    ;;
  aarch64|arm64)
    arch=arm64
    ;;
  *)
    unsupported 'unsupported architecture'
    ;;
esac

# Check libc before looking for Node: official binaries do not support musl or old glibc.
libc=$(ldd --version 2>&1 || true)
[[ $libc != *musl* ]] || unsupported 'musl/Alpine is unsupported by official Node/this tool'
first_line=${libc%%$'\n'*}
libc_version=${first_line##* }
[[ $first_line == *GLIBC* || $first_line == *'GNU libc'* ||
  $first_line == *'GNU C Library'* ]] || unsupported 'cannot determine libc'
[[ $libc_version =~ ^([0-9]+)\.([0-9]+)(\.[0-9]+)?$ ]] ||
  unsupported 'cannot determine glibc version'
major=${BASH_REMATCH[1]}
minor=${BASH_REMATCH[2]}
((10#$major > 2 || (10#$major == 2 && 10#$minor >= 28))) ||
  unsupported "glibc $libc_version is unsupported by official Node/this tool (requires >=2.28)"

if ((EUID == 0)); then
  echo 'Note: root is not needed; this installer never uses sudo.'
fi
node_dir=${MY_SINGBOX_NODE_DIR:-$HOME/.local/node}

hints() {
  printf 'PATH hint: export PATH="%s/bin:$PATH"\n' "$node_dir"
  echo 'Next: npx my-singbox doctor (package is not published yet in P1).'
  echo 'From a checkout: node dist/cli.js doctor'
}

usable_node() {
  local detected
  detected=$("$1" -v 2>/dev/null) || return 1
  [[ $detected =~ ^v([0-9]+)\. ]] && ((10#${BASH_REMATCH[1]} >= 22))
}

if [[ ${MY_SINGBOX_FORCE_NODE_INSTALL:-0} != 1 ]]; then
  if command -v node >/dev/null 2>&1 && usable_node node; then
    echo "Using Node already on PATH: $(command -v node)"
    echo 'Next: npx my-singbox doctor (package is not published yet in P1). From a checkout: node dist/cli.js doctor'
    exit 0
  fi
  if [[ -x $node_dir/bin/node ]] && usable_node "$node_dir/bin/node"; then
    echo "Using Node at $node_dir/bin/node."
    hints
    exit 0
  fi
fi

command -v curl >/dev/null 2>&1 || {
  echo 'ERROR: curl is required' >&2
  exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
  hash_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hash_tool=shasum
else
  echo 'ERROR: sha256sum or shasum is required' >&2
  exit 1
fi

version=${MY_SINGBOX_NODE_VERSION:-v22.23.4}
version=v${version#v}
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo 'ERROR: invalid Node version' >&2
  exit 1
}
requested_major=${version#v}
requested_major=${requested_major%%.*}
((10#$requested_major >= 22)) || {
  echo 'ERROR: Node >=22 is required' >&2
  exit 1
}
ext=gz
if command -v xz >/dev/null 2>&1; then
  ext=xz
fi
file="node-$version-linux-$arch.tar.$ext"

if [[ -n ${MY_SINGBOX_NODE_MIRROR:-} ]]; then
  base=${MY_SINGBOX_NODE_MIRROR%/}
elif curl --max-time 5 -fsI https://nodejs.org/dist >/dev/null 2>&1; then
  base=https://nodejs.org/dist
else
  base=https://npmmirror.com/mirrors/node
fi
echo "Using Node source: $base"

work=$(mktemp -d)
stage=''
cleanup() {
  rm -rf -- "$work"
  if [[ -n $stage ]]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup EXIT

curl -fsSL --retry 3 "$base/$version/$file" -o "$work/$file"
curl -fsSL --retry 3 "$base/$version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
expected=$(awk -v file="$file" '$2 == file {print $1}' "$work/SHASUMS256.txt")
[[ $expected =~ ^[[:xdigit:]]{64}$ ]] || {
  echo "ERROR: missing or invalid checksum entry for $file" >&2
  exit 1
}
if [[ $hash_tool == sha256sum ]]; then
  actual=$(sha256sum "$work/$file")
else
  actual=$(shasum -a 256 "$work/$file")
fi
actual=${actual%% *}
if [[ ${actual,,} != "${expected,,}" ]]; then
  echo "ERROR: checksum mismatch for $file (expected $expected, actual $actual)" >&2
  exit 1
fi

# Only verified archives reach extraction; the existing target stays intact until then.
parent=$(dirname -- "$node_dir")
mkdir -p -- "$parent"
stage=$(mktemp -d "$parent/.my-singbox-node.XXXXXX")
tar -xf "$work/$file" -C "$stage" --strip-components=1
[[ $("$stage/bin/node" --version) == "$version" ]] || {
  echo 'ERROR: extracted Node version mismatch' >&2
  exit 1
}
if [[ -e $node_dir || -L $node_dir ]]; then
  backup="$node_dir.old-$(date +%Y%m%d%H%M%S)-$$"
  [[ ! -e $backup ]] || {
    echo 'ERROR: backup path exists' >&2
    exit 1
  }
  mv -- "$node_dir" "$backup"
  echo "Previous installation preserved at $backup"
fi
mv -- "$stage" "$node_dir"
stage=''
echo "Installed Node $version at $node_dir"
hints
