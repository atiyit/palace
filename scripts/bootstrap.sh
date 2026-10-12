#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_dir="$project_dir/.palace-runtime"
node_root="$runtime_dir/node"
mkdir -p "$node_root"
private_runtime=0
stop_only=0
for argument in "$@"; do
  [ "$argument" != '--private-runtime' ] || private_runtime=1
  [ "$argument" != '--stop' ] || stop_only=1
done
node_file=''
usable() { "$1" "$project_dir/scripts/runtime-info.mjs" >/dev/null 2>&1; }
if [ "$private_runtime" -eq 0 ] && command -v node >/dev/null 2>&1; then
  candidate=$(command -v node)
  if usable "$candidate"; then node_file=$candidate; fi
fi
if [ -z "$node_file" ]; then
  for candidate in "$node_root"/node-v24-*/bin/node "$node_root"/node-v24.*/bin/node; do
    if [ -x "$candidate" ] && usable "$candidate"; then node_file=$candidate; break; fi
  done
fi
if [ -z "$node_file" ]; then
  if [ "$stop_only" -eq 1 ]; then echo 'No usable Node runtime is available. Install first, or stop the original terminal session.' >&2; exit 1; fi
  case $(uname -s) in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'Automatic installation supports macOS and Linux.' >&2; exit 1 ;; esac
  case $(uname -m) in x86_64|amd64) architecture=x64 ;; arm64|aarch64) architecture=arm64 ;; *) echo 'Automatic installation supports x64 and ARM64 only.' >&2; exit 1 ;; esac
  if [ "$platform" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    echo 'Automatic Linux installation requires glibc. Install a compatible Node.js 24+ with npm yourself on other systems.' >&2; exit 1
  fi
  command -v curl >/dev/null 2>&1 || { echo 'curl is required to download Node.js. Install curl or install Node.js 24+ with npm yourself.' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo 'tar is required to unpack Node.js.' >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum
  else echo 'sha256sum or shasum is required to verify Node.js.' >&2; exit 1; fi
  download_dir=$(mktemp -d "$runtime_dir/download-XXXXXX")
  echo 'Preparing the current Node.js 24 LTS runtime from nodejs.org...'
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 120 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -o "$download_dir/SHASUMS256.txt"
  entry=$(awk -v suffix="-$platform-$architecture.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix { print $1 " " $2; exit }' "$download_dir/SHASUMS256.txt")
  [ -n "$entry" ] || { echo 'The official checksum list has no matching runtime.' >&2; exit 1; }
  expected_hash=${entry%% *}
  archive_name=${entry#* }
  version=${archive_name#node-}; version=${version%%-*}
  archive="$download_dir/$archive_name"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 600 "https://nodejs.org/dist/$version/$archive_name" -o "$archive"
  if [ "$hash_tool" = sha256sum ]; then actual_hash=$(sha256sum "$archive" | awk '{print $1}'); else actual_hash=$(shasum -a 256 "$archive" | awk '{print $1}'); fi
  [ "$actual_hash" = "$expected_hash" ] || { echo 'Node.js archive checksum mismatch. No downloaded program was executed. Please retry.' >&2; exit 1; }
  tar -xzf "$archive" -C "$download_dir"
  folder_name=${archive_name%.tar.gz}
  usable "$download_dir/$folder_name/bin/node" || { echo 'The verified Node.js runtime cannot run on this OS. See docs/INSTALL.md.' >&2; exit 1; }
  [ ! -e "$node_root/$folder_name" ] || { echo "The runtime folder exists but is unusable. Rename it, then retry: $node_root/$folder_name" >&2; exit 1; }
  mv "$download_dir/$folder_name" "$node_root/$folder_name"
  rm -f "$archive" "$download_dir/SHASUMS256.txt"
  rmdir "$download_dir"
  node_file="$node_root/$folder_name/bin/node"
fi
npm_file=$("$node_file" "$project_dir/scripts/runtime-info.mjs" | "$node_file" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).npm))')
exec "$node_file" "$project_dir/scripts/setup-local.mjs" --npm "$npm_file" "$@"
