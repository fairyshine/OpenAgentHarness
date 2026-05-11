#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="${OAH_LOCAL_RELEASE_DIR:-$REPO_ROOT/release}"
INSTALL_ROOT="${OAH_HOME:-${OAH_INSTALL_ROOT:-$HOME/.openagentharness}}"
VERSION="${OAH_LOCAL_RELEASE_VERSION:-}"
ASSET="${OAH_LOCAL_RELEASE_ASSET:-}"
FORCE="${OAH_LOCAL_RELEASE_FORCE:-0}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

detect_asset() {
  os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch_name="$(uname -m | tr '[:upper:]' '[:lower:]')"
  bin_name="oah"

  case "$os_name" in
    darwin)
      case "$arch_name" in
        x86_64 | amd64) asset="macos-x86_64" ;;
        arm64 | aarch64) asset="macos-aarch64" ;;
        *) return 1 ;;
      esac
      ;;
    linux)
      case "$arch_name" in
        x86_64 | amd64) asset="linux-x86_64" ;;
        arm64 | aarch64) asset="linux-aarch64" ;;
        *) return 1 ;;
      esac
      ;;
    mingw* | msys* | cygwin*)
      bin_name="oah.cmd"
      case "$arch_name" in
        x86_64 | amd64) asset="windows-x86_64" ;;
        arm64 | aarch64) asset="windows-aarch64" ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac

  printf '%s %s\n' "$asset" "$bin_name"
}

package_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -n 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    return 1
  fi
}

verify_checksum() {
  archive_path="$1"
  checksum_path="$2"
  expected="$(awk '{print $1; exit}' "$checksum_path")"
  actual="$(sha256_of "$archive_path")"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for $(basename "$archive_path")." >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    return 1
  fi
}

write_root_shim() {
  mkdir -p "$INSTALL_ROOT/bin"
  if [ "$BIN_NAME" = "oah.cmd" ]; then
    cat > "$INSTALL_ROOT/bin/oah.cmd" <<'EOF'
@echo off
setlocal
set OAH_ROOT=%~dp0..
if not defined OAH_HOME set OAH_HOME=%OAH_ROOT%
"%OAH_ROOT%\current\bin\oah.cmd" %*
EOF
    return
  fi

  cat > "$INSTALL_ROOT/bin/oah" <<'EOF'
#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export OAH_HOME="${OAH_HOME:-$ROOT}"
exec "$ROOT/current/bin/oah" "$@"
EOF
  chmod +x "$INSTALL_ROOT/bin/oah"
}

need_cmd tar
need_cmd uname
need_cmd mktemp
need_cmd sed
need_cmd awk
need_cmd tr
need_cmd head

if [ -z "$ASSET" ]; then
  detected="$(detect_asset)" || {
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    exit 1
  }
  set -- $detected
  ASSET="$1"
  BIN_NAME="$2"
else
  case "$ASSET" in
    windows-*) BIN_NAME="oah.cmd" ;;
    *) BIN_NAME="oah" ;;
  esac
fi

if [ -z "$VERSION" ]; then
  VERSION="$(package_version)"
fi

if [ -z "$VERSION" ]; then
  echo "Could not resolve package version. Set OAH_LOCAL_RELEASE_VERSION." >&2
  exit 1
fi

ARCHIVE="oah-v${VERSION}-${ASSET}.tar.gz"
ARCHIVE_PATH="$RELEASE_DIR/$ARCHIVE"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Local release archive not found: $ARCHIVE_PATH" >&2
  echo "Build it first with: pnpm build:release-bundle" >&2
  exit 1
fi

if [ ! -f "$CHECKSUM_PATH" ]; then
  echo "Checksum file not found: $CHECKSUM_PATH" >&2
  exit 1
fi

verify_checksum "$ARCHIVE_PATH" "$CHECKSUM_PATH"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT HUP TERM

mkdir -p "$TMP_DIR/package"
tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR/package"

PACKAGE_ROOT="$TMP_DIR/package"
if [ ! -f "$PACKAGE_ROOT/bin/$BIN_NAME" ]; then
  found_root=""
  for candidate in "$TMP_DIR/package"/*; do
    if [ -d "$candidate" ] && [ -f "$candidate/bin/$BIN_NAME" ]; then
      found_root="$candidate"
      break
    fi
  done
  if [ -n "$found_root" ]; then
    PACKAGE_ROOT="$found_root"
  fi
fi

if [ ! -f "$PACKAGE_ROOT/bin/$BIN_NAME" ]; then
  echo "Release archive does not contain bin/$BIN_NAME." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT/versions"
TARGET="$INSTALL_ROOT/versions/$VERSION"
TMP_TARGET="$INSTALL_ROOT/versions/.$VERSION.$$"

if [ -e "$TARGET" ] && [ "$FORCE" != "1" ] && [ "$FORCE" != "true" ]; then
  echo "OpenAgentHarness $VERSION is already installed at $TARGET."
  echo "Set OAH_LOCAL_RELEASE_FORCE=1 to replace it."
else
  rm -rf "$TMP_TARGET"
  cp -R "$PACKAGE_ROOT" "$TMP_TARGET"
  rm -rf "$TARGET"
  mv "$TMP_TARGET" "$TARGET"
  echo "Installed OpenAgentHarness $VERSION from $ARCHIVE."
fi

TMP_CURRENT="$INSTALL_ROOT/current.$$"
rm -f "$TMP_CURRENT"
ln -s "versions/$VERSION" "$TMP_CURRENT"
mv -f "$TMP_CURRENT" "$INSTALL_ROOT/current"
write_root_shim

echo
echo "OpenAgentHarness local release installed:"
"$INSTALL_ROOT/bin/$BIN_NAME" version

echo
echo "OAH_HOME: $INSTALL_ROOT"
echo "Current release: $TARGET"
echo "Command shim: $INSTALL_ROOT/bin/$BIN_NAME"
echo
echo "Next steps:"
echo "  export OAH_HOME=\"$INSTALL_ROOT\""
echo "  export PATH=\"\$OAH_HOME/bin:\$PATH\""
echo "  oah daemon init"
echo "  oah daemon start"
echo "  cd /path/to/repo && oah tui"
echo
echo "Optional zsh setup. Add this to ~/.zshrc so new terminals use the same OAH home and command:"
echo "  export OAH_HOME=\"$INSTALL_ROOT\""
echo "  export PATH=\"\$OAH_HOME/bin:\$PATH\""
echo
echo "Or create an alias instead:"
echo "  export OAH_HOME=\"$INSTALL_ROOT\""
echo "  alias oah=\"\$OAH_HOME/bin/oah\""
echo
echo "Then reload zsh:"
echo "  source ~/.zshrc"
