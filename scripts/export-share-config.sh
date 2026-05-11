#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
OAH_HOME_DIR="${OAH_HOME:-$HOME/.openagentharness}"
OUTPUT_DIR="$REPO_ROOT/release"
ARCHIVE_NAME=""
INCLUDE_RUNTIMES=1
REDACT=1

usage() {
  cat <<'EOF'
Usage: scripts/export-share-config.sh [options]

Create a shareable OpenAgentHarness configuration archive.

Options:
  --home <path>        OAH_HOME to export. Defaults to $OAH_HOME or ~/.openagentharness.
  --output-dir <path>  Directory for the generated archive. Defaults to ./release.
  --name <name>        Archive file name. Defaults to oah-config-share-<timestamp>.tar.gz.
  --no-runtimes        Do not include OAH_HOME/runtimes.
  --no-redact          Do not redact secret-like values from copied text files.
  -h, --help           Show this help.

The archive intentionally excludes workspaces, state, logs, run tokens, installed versions,
command shims, and other local runtime data.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

timestamp() {
  date -u +"%Y%m%dT%H%M%SZ"
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

copy_entry() {
  source="$1"
  target="$2"
  if [ ! -e "$source" ]; then
    return
  fi

  mkdir -p "$(dirname -- "$target")"
  cp -R "$source" "$target"
}

write_import_readme() {
  target="$1"
  cat > "$target/README.import.md" <<EOF
# OpenAgentHarness Shared Config

This archive contains shareable OAH configuration exported from:

- Exported at: \`$(date -u +"%Y-%m-%dT%H:%M:%SZ")\`

## What Is Included

- \`config/\`
- \`models/\`
- \`tools/\`
- \`skills/\`
- \`scripts/\`
$([ "$INCLUDE_RUNTIMES" = "1" ] && printf '%s\n' "- \`runtimes/\`")
- top-level README/version metadata when present

## What Is Excluded

- \`workspaces/\`
- \`state/\`
- \`logs/\`
- \`run/\` and local API tokens
- \`versions/\`
- \`bin/\`
- \`.oah-local*\`
- local install/build/check folders

## Import

Install OpenAgentHarness first, then initialize the target home and overlay the shared configuration:

\`\`\`sh
export OAH_HOME="\$HOME/.openagentharness"
oah daemon init
tar -xzf "$(basename "$ARCHIVE_PATH")" -C /tmp
cp -R /tmp/oah-config-share/config /tmp/oah-config-share/models /tmp/oah-config-share/tools /tmp/oah-config-share/skills "\$OAH_HOME"/
$([ "$INCLUDE_RUNTIMES" = "1" ] && printf '%s\n' 'cp -R /tmp/oah-config-share/runtimes "$OAH_HOME"/')
oah daemon restart
\`\`\`

If this archive was exported with redaction enabled, secret-like values were replaced
with \`<REDACTED>\`; each recipient must set their own provider keys before model calls work.
EOF
}

is_text_file() {
  case "$1" in
    *.bash|*.conf|*.env|*.ini|*.json|*.jsonc|*.md|*.mjs|*.sh|*.toml|*.txt|*.yaml|*.yml) return 0 ;;
    */README|*/README.*|*/SKILL.md) return 0 ;;
    *) return 1 ;;
  esac
}

redact_file() {
  file="$1"
  if ! is_text_file "$file"; then
    return
  fi

  # Keep the structure useful while removing common secret-bearing values.
  perl -0pi -e '
    s/((?:api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|password|client[_-]?secret|authorization|bearer)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]*"|'\''[^'\'']*'\''|[^\r\n#]+)/$1"<REDACTED>"/gim;
    s/(^|\n)([ \t]*key[ \t]*:[ \t]*)("[^"]*"|'\''[^'\'']*'\''|[^\r\n#]+)/$1$2"<REDACTED>"/gim;
    s/((?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|DASHSCOPE|MOONSHOT|DEEPSEEK|OPENROUTER|AWS|S3|MINIO)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)[^\r\n#]+/$1<REDACTED>/gim;
  ' "$file"

  if [ -n "${HOME:-}" ]; then
    perl -0pi -e 's#\Q$ENV{HOME}\E#\$HOME#g' "$file"
  fi
}

redact_stage() {
  stage="$1"
  if [ "$REDACT" != "1" ]; then
    return
  fi
  need_cmd perl

  find "$stage" -type f | while IFS= read -r file; do
    redact_file "$file"
  done
}

write_manifest() {
  stage="$1"
  manifest="$stage/manifest.txt"
  {
    echo "OpenAgentHarness shared configuration export"
    echo "Exported at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "Redacted: $REDACT"
    echo "Included runtimes: $INCLUDE_RUNTIMES"
    echo
    echo "Files:"
  } > "$manifest"

  (
    cd "$stage"
    find . -type f | sed 's#^\./##' | sort
  ) >> "$manifest"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home)
      [ "$#" -ge 2 ] || die "--home requires a path"
      OAH_HOME_DIR="$2"
      shift 2
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || die "--output-dir requires a path"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --name)
      [ "$#" -ge 2 ] || die "--name requires a file name"
      ARCHIVE_NAME="$2"
      shift 2
      ;;
    --no-runtimes)
      INCLUDE_RUNTIMES=0
      shift
      ;;
    --no-redact)
      REDACT=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

need_cmd tar
need_cmd find
need_cmd cp
need_cmd date
need_cmd mktemp
need_cmd sort
need_cmd sed
need_cmd awk

[ -d "$OAH_HOME_DIR" ] || die "OAH_HOME does not exist: $OAH_HOME_DIR"

if [ -z "$ARCHIVE_NAME" ]; then
  ARCHIVE_NAME="oah-config-share-$(timestamp).tar.gz"
fi

case "$ARCHIVE_NAME" in
  *.tar.gz|*.tgz) ;;
  *) ARCHIVE_NAME="$ARCHIVE_NAME.tar.gz" ;;
esac

mkdir -p "$OUTPUT_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT HUP TERM

STAGE="$TMP_DIR/oah-config-share"
mkdir -p "$STAGE"

copy_entry "$OAH_HOME_DIR/config" "$STAGE/config"
copy_entry "$OAH_HOME_DIR/models" "$STAGE/models"
copy_entry "$OAH_HOME_DIR/tools" "$STAGE/tools"
copy_entry "$OAH_HOME_DIR/skills" "$STAGE/skills"
copy_entry "$OAH_HOME_DIR/scripts" "$STAGE/scripts"
copy_entry "$OAH_HOME_DIR/README.md" "$STAGE/README.md"
copy_entry "$OAH_HOME_DIR/.oah-home-version" "$STAGE/.oah-home-version"

if [ "$INCLUDE_RUNTIMES" = "1" ]; then
  copy_entry "$OAH_HOME_DIR/runtimes" "$STAGE/runtimes"
fi

# Remove common local metadata if it exists inside copied folders.
find "$STAGE" -name ".DS_Store" -type f -delete
find "$STAGE" -name "*.log" -type f -delete
find "$STAGE" -name "*.db" -type f -delete
find "$STAGE" -name "*.db-shm" -type f -delete
find "$STAGE" -name "*.db-wal" -type f -delete

ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
write_import_readme "$STAGE"
redact_stage "$STAGE"
write_manifest "$STAGE"

(
  cd "$TMP_DIR"
  tar -czf "$ARCHIVE_PATH" "oah-config-share"
)

CHECKSUM=""
if CHECKSUM="$(sha256_of "$ARCHIVE_PATH" 2>/dev/null)"; then
  printf '%s  %s\n' "$CHECKSUM" "$(basename "$ARCHIVE_PATH")" > "$ARCHIVE_PATH.sha256"
fi

echo "Created shareable OAH config archive:"
echo "  $ARCHIVE_PATH"
if [ -n "$CHECKSUM" ]; then
  echo "Checksum:"
  echo "  $ARCHIVE_PATH.sha256"
fi
echo
echo "Excluded local workspaces/state/logs/run tokens/installed versions."
if [ "$REDACT" = "1" ]; then
  echo "Redacted secret-like values in copied text files."
fi
