#!/bin/sh
# Furina Omarchy theme pack - remove the optional Furina variant themes.
#
# Removes ${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/themes/furina-<skin> for the
# skins installed by install-variants.sh. The default theme installed with
# `omarchy theme install` (furina-omarchy) is left untouched.
#
# The active theme is skipped unless --force is given, so you cannot pull the
# theme out from under a running session by accident.
#
# Usage: ./scripts/uninstall-variants.sh [-f|--force] [skin ...]
set -eu

THEMES_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/themes"
CURRENT_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/current/theme.name"
ALL_SKINS="fontaine-nocturne hydro-iris salon-solitude"
FORCE=0

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: uninstall-variants.sh [-f|--force] [skin ...]

Remove Furina variant themes installed by install-variants.sh.

  -f, --force   also remove the theme that is currently active
  skin          one or more of: fontaine-nocturne hydro-iris salon-solitude
                (default: all three)
EOF
}

selected=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    -f|--force) FORCE=1 ;;
    fontaine-nocturne|hydro-iris|salon-solitude) selected="$selected $arg" ;;
    *) die "unknown argument '$arg' (expected -f, --force or one of: $ALL_SKINS)" ;;
  esac
done
[ -n "$selected" ] || selected=" $ALL_SKINS"

[ -n "$THEMES_DIR" ] || die "could not resolve the themes directory"

current=""
if [ -f "$CURRENT_FILE" ]; then
  current=$(tr -d '\r\n' < "$CURRENT_FILE")
fi

removed=0
for skin in $selected; do
  dest="$THEMES_DIR/furina-$skin"
  case "$dest/" in
    "$THEMES_DIR"/*) ;;
    *) die "refusing to touch an unexpected path: $dest" ;;
  esac
  if [ ! -d "$dest" ]; then
    note "not installed: furina-$skin"
    continue
  fi
  if [ "$current" = "furina-$skin" ] && [ "$FORCE" -eq 0 ]; then
    note "skipping furina-$skin: it is the active theme (switch theme first, or pass --force)"
    continue
  fi
  rm -rf "$dest"
  removed=$((removed + 1))
  note "removed $dest"
done

note ""
if [ "$removed" -eq 0 ]; then
  note "Nothing removed."
else
  note "Removed $removed variant theme(s). The default theme (furina-omarchy) was not touched."
fi
