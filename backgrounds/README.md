# Wallpapers

The three wallpapers in this directory are the Furina / Fontaine scenery for the
three skins. They are numbered so `omarchy theme bg next` cycles them in a stable
order:

| File | Skin | Scene |
| --- | --- | --- |
| `0-fontaine-nocturne.jpg` | fontaine-nocturne | Fontaine at night in the rain: neon billboards, wet asphalt, indigo sky |
| `1-hydro-iris.jpg` | hydro-iris | Crystal hydro iris: electric blue glass and near-black water |
| `2-salon-solitude.jpg` | salon-solitude | Salon light: rose-gold, lavender, quiet warmth |

Each file is 2560x1440, sRGB JPEG, quality 92, with no text baked in, so it pairs
cleanly with a dark shell and the lock screen.

## Sources and credits

The images are fan-made *Genshin Impact* illustrations of Furina. This repository
ships 2560x1440 sRGB JPEG re-encodes (quality 92) of the 3840x2160 originals:

| File | Creator / credit | Source |
| --- | --- | --- |
| `0-fontaine-nocturne.jpg` | **rotvirtue** | [Wallpaper Abyss #1409444](https://wall.alphacoders.com/big.php?i=1409444) |
| `1-hydro-iris.jpg` | **58\_(opal_00_58)** | [Danbooru post 5837276](https://danbooru.donmai.us/posts/5837276) |
| `2-salon-solitude.jpg` | artist not named on the page | [Wallpaper Abyss #1353872](https://wall.alphacoders.com/big.php?i=1353872) |

Furina, Fontaine and *Genshin Impact* are © HoYoverse / COGNOSPHERE. The art is
included for personal, non-commercial theming only and is **not** covered by this
repository's MIT licence; see the last section of the top-level `README.md`.

## Switching

- `omarchy theme bg next` — next wallpaper in this sorted list (wraps around).
- The Omarchy background picker (Appearance → Background) — lists these plus any
  images you add to the per-theme overlay.
- Per-theme overlay: drop your own images into
  `~/.config/omarchy/backgrounds/furina-omarchy/` (or
  `~/.config/omarchy/backgrounds/furina-<skin>/` for an installed variant). They
  join this theme's rotation without touching the shipped files.
- Intro videos: optional silent 5–7 s clips in `backgrounds/intros/<same-name>.mp4`
  next to a wallpaper of the same base name. This pack ships none.

The live choice is symlinked at `~/.local/state/omarchy/current/background`, so
anything that reads that symlink follows whatever `theme bg next` picked.
