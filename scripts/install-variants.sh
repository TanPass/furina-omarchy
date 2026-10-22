#!/bin/sh
# Furina Omarchy theme pack - install the three Furina skins as switchable themes.
#
# `omarchy theme install <git-url>` already installs the default theme
# (furina-omarchy = the fontaine-nocturne skin). This script additionally puts
# the alternate skins on disk as separate themes so the theme switcher can
# reach them:
#
#   furina-fontaine-nocturne   the night-rain skin (same as the default install)
#   furina-hydro-iris          the crystal-hydro skin
#   furina-salon-solitude      the rose-gold salon skin
#
# It writes only inside ${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/themes, needs
# no elevated rights, and is idempotent: re-running replaces the installed copy.
#
# Usage: ./scripts/install-variants.sh [skin ...]
# Then switch with: omarchy-theme-set furina-<skin>
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
THEMES_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/themes"
ALL_SKINS="fontaine-nocturne hydro-iris salon-solitude"
ART_FILES="preview.png preview-unlock.png unlock.png"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: install-variants.sh [skin ...]

Install Furina skins as switchable Omarchy themes under
$XDG_CONFIG_HOME/omarchy/themes/furina-<skin>.

  skin    one or more of: fontaine-nocturne hydro-iris salon-solitude
          (default: all three)

Examples:
  ./scripts/install-variants.sh
  ./scripts/install-variants.sh hydro-iris
  omarchy-theme-set furina-hydro-iris
EOF
}

selected=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    fontaine-nocturne|hydro-iris|salon-solitude) selected="$selected $arg" ;;
    *) die "unknown skin '$arg' (expected one of: $ALL_SKINS)" ;;
  esac
done
[ -n "$selected" ] || selected=" $ALL_SKINS"

# The preview art lives next to the variant payload; the default skin reuses the
# pack root art because it is the same skin as the default install.
art_for() {
  if [ -f "$1/$2" ]; then
    printf '%s\n' "$1/$2"
  elif [ -f "$REPO_DIR/$2" ]; then
    printf '%s\n' "$REPO_DIR/$2"
  fi
}

install_skin() {
  skin=$1
  src="$REPO_DIR/variants/$skin"
  dest="$THEMES_DIR/furina-$skin"

  [ -d "$src" ] || die "missing variant payload: $src"
  case "$dest/" in
    "$REPO_DIR"/*) die "refusing to install into the source tree: $dest" ;;
  esac

  note "==> furina-$skin"
  rm -rf "$dest"
  mkdir -p "$dest/backgrounds"

  cp "$src/colors.toml" "$dest/colors.toml"
  cp "$src/shell.toml" "$dest/shell.toml"

  bg_ref=$(tr -d '\r\n' < "$src/background")
  case "$bg_ref" in
    ""|/*|*..*) die "variants/$skin/background has an unusable path: '$bg_ref'" ;;
  esac
  bg_src="$REPO_DIR/$bg_ref"
  [ -f "$bg_src" ] || die "missing wallpaper referenced by variants/$skin/background: $bg_src"
  cp "$bg_src" "$dest/backgrounds/$(basename -- "$bg_src")"

  for art in $ART_FILES; do
    art_src=$(art_for "$src" "$art")
    if [ -n "$art_src" ]; then
      cp "$art_src" "$dest/$art"
    else
      note "    note: $art missing, skipping (the theme still works without it)"
    fi
  done

  note "    installed $dest"
}

command -v omarchy-theme-set >/dev/null 2>&1 || \
  note "note: omarchy-theme-set is not on PATH here; run these commands on your Omarchy desktop."

for skin in $selected; do
  install_skin "$skin"
done

note ""
note "Done. Switch skins with:"
for skin in $selected; do
  note "  omarchy-theme-set furina-$skin"
done
note ""
note "The default install (omarchy theme install <git-url>) is already the"
note "fontaine-nocturne skin; the variants above are extra entries in the"
note "theme switcher. Remove them again with ./scripts/uninstall-variants.sh"
