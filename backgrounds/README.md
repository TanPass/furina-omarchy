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
