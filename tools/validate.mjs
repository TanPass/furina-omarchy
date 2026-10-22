#!/usr/bin/env node
/**
 * validate.mjs — installability proof for the Furina Omarchy theme pack.
 *
 * This is not a style linter. It re-implements the parts of Omarchy v4
 * (quattro) that decide whether a cloned theme directory can be staged and
 * activated, then runs the real pack through them:
 *
 *   1. repo shape        — repo root really is a theme root, expected tree only
 *   2. clone filter      — INSTALLED_THEME_DENIED, *.lua and symlinks read
 *                          straight out of bin/omarchy-theme-set
 *   3. theme naming      — the README install URL resolves to a legal theme
 *                          name with bin/omarchy-theme-install's algorithm
 *   4. palettes          — every colors.toml key valid, required keys present,
 *                          WCAG contrast targets for all shipped skins
 *   5. shell schema      — every shell.toml section/key exists in
 *                          default/themed/shell.toml.tpl, types/ranges hold,
 *                          colors agree with colors.toml
 *   6. art               — preview PNG dimensions/format, 16:9 shape, no
 *                          leftover placeholder marker
 *   7. backgrounds       — 2560x1440 JPEGs, deterministic `theme bg next` order
 *   8. variants/scripts  — variant install payload present, POSIX scripts sane
 *   9. template engine   — every default/themed/*.tpl rendered for every skin
 *                          with Omarchy's own token/mix/gradient rules, zero
 *                          leftover {{ }} placeholders
 *  10. staging          — the staged theme that would reach
 *                          ~/.local/state/omarchy/current/theme is complete
 *  11. docs             — README/LICENCE exist, commands and images resolve
 *
 * Usage:
 *   node tools/validate.mjs [--repo <dir>] [--refs <omarchy-src>]
 *                           [--allow-placeholder] [--verbose]
 *
 * Requires the Omarchy source reference (default: ../../_ref/omarchy-src next
 * to the repo) for bin/omarchy-theme-set, bin/omarchy-theme-install and
 * default/themed/*.tpl. No network access is used.
 */

import { readFileSync, readdirSync, existsSync, lstatSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, basename, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function arg(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

const REPO = resolve(arg("--repo", join(HERE, "..")));
const REFS = resolve(arg("--refs", join(REPO, "..", "_ref", "omarchy-src")));
const ALLOW_PLACEHOLDER = argv.includes("--allow-placeholder");
const VERBOSE = argv.includes("--verbose");

const THEME_SET = join(REFS, "bin", "omarchy-theme-set");
const THEME_INSTALL = join(REFS, "bin", "omarchy-theme-install");
const TEMPLATE_DIR = join(REFS, "default", "themed");
const SHELL_TPL = join(TEMPLATE_DIR, "shell.toml.tpl");

const SKINS = ["fontaine-nocturne", "hydro-iris", "salon-solitude"];
const DEFAULT_SKIN = "fontaine-nocturne";
const VARIANTS = [...SKINS];

const PREVIEW_SPEC = [
  { file: "preview.png", width: 2560, height: 1440, wide: true, minBytes: 120 * 1024 },
  { file: "preview-unlock.png", width: 1920, height: 1080, wide: true, minBytes: 90 * 1024 },
  { file: "unlock.png", width: 1108, height: 523, wide: false, minBytes: 60 * 1024 },
];

// ---------------------------------------------------------------------------
// report plumbing
// ---------------------------------------------------------------------------

const checks = [];
const infos = [];
const started = Date.now();

function check(section, name, ok, detail = "") {
  checks.push({ section, name, ok, detail });
  if (!ok && detail) failures.push(`${section} :: ${name} — ${detail}`);
}

function info(section, message) {
  infos.push({ section, message });
}

const failures = [];

function isOk(section) {
  return !checks.some((c) => c.section === section && !c.ok);
}

function group(section, fn) {
  try {
    fn();
  } catch (err) {
    check(section, "section crashed", false, err && err.stack ? err.stack.split("\n")[0] : String(err));
  }
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const HEX6 = /^#[0-9a-f]{6}$/;
const HEX8 = /^#[0-9a-f]{8}$/;

function hexToRgb(hex) {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(rgb) {
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** Omarchy's mix token rounding: int(a*(1-t) + b*t + 0.5) per channel. */
function mix(a, b, amount) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const round = (x, y) => Math.trunc(x * (1 - amount) + y * amount + 0.5);
  return rgbToHex([round(ar, br), round(ag, bg), round(ab, bb)]);
}

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Remove a trailing `# comment`, respecting quoted strings. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const m = value.match(/^"((?:[^"\\]|\\.)*)"/);
    if (!m) return { error: "unterminated string" };
    return { type: "string", value: m[1] };
  }
  if (value === "true" || value === "false") return { type: "bool", value: value === "true" };
  const num = Number(value);
  if (value !== "" && Number.isFinite(num)) return { type: "number", value: num };
  return { error: `unparsable value ${JSON.stringify(value)}` };
}

/** Parse an Omarchy-style colors.toml (flat key = "value" file). */
function parseColors(file) {
  const map = new Map();
  const problems = [];
  splitLines(readFileSync(file, "utf8")).forEach((line, index) => {
    const text = stripComment(line).trim();
    if (!text) return;
    if (text.startsWith("[")) {
      problems.push(`line ${index + 1}: colors.toml is flat, found table header ${text}`);
      return;
    }
    const m = text.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!m) {
      problems.push(`line ${index + 1}: not key = value: ${text}`);
      return;
    }
    const parsed = parseTomlValue(m[2]);
    if (!parsed || parsed.error) {
      problems.push(`line ${index + 1}: ${parsed ? parsed.error : "unparsable"}`);
      return;
    }
    if (parsed.type !== "string") {
      problems.push(`line ${index + 1}: ${m[1]} must be a quoted string`);
      return;
    }
    if (map.has(m[1])) problems.push(`line ${index + 1}: duplicate key ${m[1]}`);
    map.set(m[1], parsed.value);
  });
  return { map, problems };
}

// ---------------------------------------------------------------------------
// Hyprland-style gradient parsing (colors.toml values / shell border tokens)
// ---------------------------------------------------------------------------

const ANGLE = /^-?[0-9]+(\.[0-9]+)?deg$/;
const COLOR_HEX = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const COLOR_RGBA_HEX = /^[Rr][Gg][Bb][Aa]?\(([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?\)$/;
const COLOR_RGBA_DEC = /^[Rr][Gg][Bb][Aa]?\(([0-9]+),([0-9]+),([0-9]+)(,[0-9.]+)?\)$/;
const COLOR_0X = /^0x[0-9A-Fa-f]{8}$/;

function isGradientColor(token) {
  return COLOR_HEX.test(token) || COLOR_RGBA_HEX.test(token) || COLOR_RGBA_DEC.test(token) || COLOR_0X.test(token);
}

/** Reimplementation of color_to_shell_hex from omarchy-theme-set-templates. */
function colorToShellHex(color, table) {
  let value = color;
  if (table && table.has(value)) value = table.get(value);
  if (/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value)) {
    return "#" + value.slice(1, 7).toLowerCase();
  }
  const rgbaHex = value.match(COLOR_RGBA_HEX);
  if (rgbaHex) {
    return "#" + rgbaHex[1];
  }
  const rgbaDec = value.match(COLOR_RGBA_DEC);
  if (rgbaDec) {
    const clamp = (n) => Math.min(255, Number(n));
    return rgbToHex([clamp(rgbaDec[1]), clamp(rgbaDec[2]), clamp(rgbaDec[3])]);
  }
  if (COLOR_0X.test(value)) return "#" + value.slice(4, 10).toLowerCase();
  return value;
}

function parseGradient(spec, table) {
  const colors = [];
  let angle = null;
  for (const part of spec.split(/\s+/)) {
    if (!part) continue;
    if (ANGLE.test(part)) {
      angle = part.slice(0, -3);
      continue;
    }
    colors.push(table && table.has(part) ? table.get(part) : part);
  }
  return { colors, angle };
}

// ---------------------------------------------------------------------------
// 1. reference sources
// ---------------------------------------------------------------------------

let themeSetSource = "";
let themeInstallSource = "";
let INSTALLED_THEME_DENIED = [];

group("reference", () => {
  check("reference", "omarchy-theme-set (bin/omarchy-theme-set)",
    existsSync(THEME_SET), `not found at ${THEME_SET}`);
  check("reference", "omarchy-theme-install (bin/omarchy-theme-install)",
    existsSync(THEME_INSTALL), `not found at ${THEME_INSTALL}`);
  check("reference", "default/themed/shell.toml.tpl",
    existsSync(SHELL_TPL), `not found at ${SHELL_TPL}`);

  if (existsSync(THEME_SET)) {
    themeSetSource = readFileSync(THEME_SET, "utf8");
    const denied = themeSetSource.match(/^INSTALLED_THEME_DENIED=\(([^)]*)\)/m);
    if (!denied) {
      check("reference", "INSTALLED_THEME_DENIED parsed", false, "array not found in omarchy-theme-set");
    } else {
      INSTALLED_THEME_DENIED = denied[1].trim().split(/\s+/).filter(Boolean);
      const expected = ["alacritty.toml", "foot.ini", "ghostty.conf", "kitty.conf", "vscode.json"];
      for (const name of expected) {
        check("reference", `denied list contains ${name}`,
          INSTALLED_THEME_DENIED.includes(name),
          `parsed denied list: ${INSTALLED_THEME_DENIED.join(" ")}`);
      }
      check("reference", "denied helper also rejects *.lua",
        themeSetSource.includes("*.lua"),
        "no *.lua rule in is_denied_installed_file()");
      check("reference", "cloned-theme detection present",
        themeSetSource.includes("theme_came_from_a_repo") && themeSetSource.includes(".git"),
        "theme_came_from_a_repo()/.git check missing");
    }
    info("reference", `INSTALLED_THEME_DENIED = ${INSTALLED_THEME_DENIED.join(" ")}`);
  }

  if (existsSync(THEME_INSTALL)) {
    themeInstallSource = readFileSync(THEME_INSTALL, "utf8");
    check("reference", "install normalizes name with basename/sed -E",
      themeInstallSource.includes("basename -- \"$REPO_PATH\" .git") &&
      themeInstallSource.includes("s/^omarchy-//") &&
      themeInstallSource.includes("s/-theme$//"),
      "expected THEME_NAME derivation not found in omarchy-theme-install");
    check("reference", "install clones straight into themes dir",
      themeInstallSource.includes("git clone") && themeInstallSource.includes("omarchy-theme-set"),
      "expected clone + omarchy-theme-set call missing");
  }

  if (existsSync(TEMPLATE_DIR)) {
    const tpls = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".tpl")).sort();
    const expected = ["alacritty.toml.tpl", "btop.theme.tpl", "foot.ini.tpl", "helix.toml.tpl",
                      "hyprland.lua.tpl", "keyboard.rgb.tpl", "shell.toml.tpl"];
    const missing = expected.filter((name) => !tpls.includes(name));
    check("reference", "default/themed templates present", tpls.length >= 5 && missing.length === 0,
      `found ${tpls.length} (${tpls.join(", ")}); missing ${missing.join(", ") || "none"}`);
    check("reference", "shell.toml.tpl is one of them", tpls.includes("shell.toml.tpl"),
      "shell.toml.tpl missing (cannot validate shell schema)");
    info("reference", `${tpls.length} built-in templates in ${TEMPLATE_DIR}`);
    info("reference", `templates: ${tpls.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// 2. repo shape
// ---------------------------------------------------------------------------

const REPO_TOP_LEVEL = new Set([
  "README.md", "LICENSE", "colors.toml", "shell.toml",
  "backgrounds", "variants", "scripts", "tools", "docs",
  "preview.png", "preview-unlock.png", "unlock.png",
  ".git", ".gitignore", ".gitattributes", ".github",
]);
// Dev-only scratch directory used while preview art is being produced; the
// final pack must not contain it.
if (ALLOW_PLACEHOLDER) REPO_TOP_LEVEL.add("_tmp");

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = relative(base, abs).split(sep).join("/");
    const stat = lstatSync(abs);
    out.push({ rel, abs, dir: stat.isDirectory(), symlink: stat.isSymbolicLink(), size: stat.size });
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(abs, base, out);
  }
  return out;
}

group("repo shape", () => {
  check("repo shape", "repo directory exists", existsSync(REPO), REPO);
  check("repo shape", "colors.toml at repo root (theme root == clone dir)",
    existsSync(join(REPO, "colors.toml")), "missing colors.toml");
  check("repo shape", "README.md at repo root", existsSync(join(REPO, "README.md")), "missing README.md");
  check("repo shape", "LICENSE at repo root", existsSync(join(REPO, "LICENSE")), "missing LICENSE");

  const top = readdirSync(REPO).sort();
  const unexpected = top.filter((name) => !REPO_TOP_LEVEL.has(name));
  check("repo shape", "no unexpected top-level entries", unexpected.length === 0,
    `unexpected: ${unexpected.join(", ")}`);

  for (const dir of ["backgrounds", "variants", "scripts", "tools", "docs"]) {
    check("repo shape", `directory ${dir}/`, existsSync(join(REPO, dir)), `missing ${dir}/`);
  }
  for (const skin of SKINS) {
    const dir = join(REPO, "variants", skin);
    check("repo shape", `variant dir variants/${skin}/`, existsSync(dir), `missing ${dir}`);
    for (const file of ["colors.toml", "shell.toml", "background"]) {
      check("repo shape", `variants/${skin}/${file}`,
        existsSync(join(dir, file)), `missing ${file}`);
    }
  }

  const all = walk(REPO).filter((e) => !e.symlink);
  check("repo shape", "pack is non-trivial", all.length >= 20,
    `only ${all.length} entries in repo`);
  info("repo shape", `${all.filter((e) => !e.dir).length} files, ${(all.reduce((s, e) => s + (e.dir ? 0 : e.size), 0) / 1048576).toFixed(2)} MiB`);
});

// ---------------------------------------------------------------------------
// 3. clone filter (what omarchy-theme-set stages for a repo theme)
// ---------------------------------------------------------------------------

group("clone filter", () => {
  const entries = walk(REPO).filter((e) => !e.rel.startsWith(".git/") && e.rel !== ".git");
  const deniedNames = new Set(INSTALLED_THEME_DENIED);

  const dropped = [];
  for (const entry of entries) {
    const name = basename(entry.rel);
    if (entry.symlink) dropped.push({ rel: entry.rel, why: "symlink (dropped at any depth)" });
    else if (name.endsWith(".lua")) dropped.push({ rel: entry.rel, why: "*.lua is denied for cloned themes" });
    else if (deniedNames.has(name)) dropped.push({ rel: entry.rel, why: `${name} is in INSTALLED_THEME_DENIED` });
  }
  check("clone filter", "nothing the installer would drop",
    dropped.length === 0,
    dropped.slice(0, 5).map((d) => `${d.rel} (${d.why})`).join("; "));
  check("clone filter", "no symlinks anywhere in the pack",
    entries.every((e) => !e.symlink),
    "git clone + omarchy-theme-set discard symlinked files");

  const survives = (rel) => entries.some((e) => e.rel === rel && !e.symlink && !deniedNames.has(basename(e.rel)) && !e.rel.endsWith(".lua"));
  for (const rel of ["colors.toml", "shell.toml", "preview.png", "preview-unlock.png", "unlock.png",
                     "backgrounds/0-fontaine-nocturne.jpg", "backgrounds/1-hydro-iris.jpg",
                     "backgrounds/2-salon-solitude.jpg"]) {
    check("clone filter", `survivor: ${rel}`, survives(rel), "installer would not stage this file");
  }
  check("clone filter", "shell.toml survives as the hand-written override",
    survives("shell.toml"), "shell.toml would be filtered out");
});

// ---------------------------------------------------------------------------
// 4. theme naming from the README install URL
// ---------------------------------------------------------------------------

let readme = "";

function themeNameFromUrl(url) {
  // omarchy-theme-install: basename minus .git, strip "^omarchy-", strip "-theme$", lowercase.
  let path = url;
  if (!path.includes("://") && path.includes(":") && !path.split(":")[0].includes("/")) {
    path = path.slice(path.indexOf(":") + 1);
  }
  let name = path.replace(/\/+$/, "").split("/").pop() || "";
  name = name.replace(/\.git$/, "");
  name = name.replace(/^omarchy-/, "").replace(/-theme$/, "").toLowerCase();
  return name;
}

group("naming", () => {
  readme = existsSync(join(REPO, "README.md")) ? readFileSync(join(REPO, "README.md"), "utf8") : "";
  const urls = readme.match(/https:\/\/github\.com\/[^\s)"'`]+/g) || [];
  const themeUrls = urls.filter((u) => /furina/i.test(u));
  check("naming", "README contains the install URL", themeUrls.length > 0,
    "no https://github.com/.../furina-omarchy URL in README");

  const THEME_NAME = themeUrls.length ? themeNameFromUrl(themeUrls[0]) : "";
  check("naming", "URL resolves to furina-omarchy", THEME_NAME === "furina-omarchy",
    `url ${themeUrls[0] || "(none)"} -> theme name ${JSON.stringify(THEME_NAME)}`);
  check("naming", "resolved name matches omarchy-theme-install regex",
    /^[a-z0-9_][a-z0-9._+-]*$/.test(THEME_NAME), `illegal theme name ${THEME_NAME}`);

  for (const skin of SKINS) {
    const installed = `furina-${skin}`;
    check("naming", `variant theme name ${installed} is legal`,
      /^[a-z0-9_][a-z0-9._+-]*$/.test(installed), installed);
    check("naming", `README documents ${installed}`, readme.includes(installed),
      `README never mentions ${installed}`);
  }
});

// ---------------------------------------------------------------------------
// 5. palettes: keys, values, contrast
// ---------------------------------------------------------------------------

const REQUIRED_COLOR_KEYS = [
  "mode",
  "accent", "selection", "muted",
  "background", "dark_background", "darker_background", "lighter_background",
  "foreground", "dark_foreground", "light_foreground", "bright_foreground",
  "red", "orange", "yellow", "green", "cyan", "blue", "magenta", "brown", "violet",
  "bright_red", "bright_orange", "bright_yellow", "bright_green",
  "bright_cyan", "bright_blue", "bright_magenta",
];
const GRADIENT_COLOR_KEYS = ["hyprland_active_border", "hyprland_inactive_border"];
const ALLOWED_COLOR_KEYS = new Set([...REQUIRED_COLOR_KEYS, ...GRADIENT_COLOR_KEYS]);
const ALIAS_TARGETS = [
  ["bg", "background"], ["dark_bg", "dark_background"], ["darker_bg", "darker_background"],
  ["lighter_bg", "lighter_background"], ["fg", "foreground"], ["dark_fg", "dark_foreground"],
  ["light_fg", "light_foreground"], ["bright_fg", "bright_foreground"],
];
const ANSI_ORDER = [
  "background", "red", "green", "yellow", "blue", "magenta", "cyan", "foreground",
  "muted", "bright_red", "bright_green", "bright_yellow", "bright_blue",
  "bright_magenta", "bright_cyan", "bright_foreground",
];

/** The color table omarchy-theme-color --all hands to the template engine. */
function resolveColorTable(map) {
  const table = new Map(map);
  for (const [alias, target] of ALIAS_TARGETS) {
    if (map.has(target)) table.set(alias, map.get(target));
  }
  ANSI_ORDER.forEach((key, index) => {
    if (map.has(key)) table.set(`color${index}`, map.get(key));
  });
  table.set("purple", map.get("magenta"));
  table.set("bright_purple", map.get("bright_magenta"));
  table.set("selection_background", map.get("selection"));
  table.set("selection_foreground", map.get("bright_foreground"));
  table.set("theme_type", map.get("mode") || "dark");
  return table;
}

const palettes = []; // { label, file, map, table }

function loadPalette(label, file) {
  const { map, problems } = parseColors(file);
  check("palettes", `${label}: parses as flat key = "value"`, problems.length === 0,
    problems.slice(0, 4).join("; "));

  const missing = REQUIRED_COLOR_KEYS.filter((key) => !map.has(key));
  check("palettes", `${label}: all required keys present`, missing.length === 0,
    `missing ${missing.join(", ")}`);

  const unknown = [...map.keys()].filter((key) => !ALLOWED_COLOR_KEYS.has(key));
  check("palettes", `${label}: no unknown keys`, unknown.length === 0,
    `unknown ${unknown.join(", ")}`);

  check("palettes", `${label}: mode = "dark"`, map.get("mode") === "dark",
    `mode is ${JSON.stringify(map.get("mode"))}`);

  for (const key of REQUIRED_COLOR_KEYS) {
    if (key === "mode" || !map.has(key)) continue;
    check("palettes", `${label}: ${key} is a lowercase #rrggbb`, HEX6.test(map.get(key)),
      `${key} = ${JSON.stringify(map.get(key))}`);
  }

  // gradient keys: Hyprland gradient syntax, >= 2 colors, honest angle
  for (const key of GRADIENT_COLOR_KEYS) {
    if (!map.has(key)) continue;
    const raw = map.get(key);
    if (HEX6.test(raw)) {
      check("palettes", `${label}: ${key} solid color ok`, true, "");
      continue;
    }
    const grad = parseGradient(raw, null);
    check("palettes", `${label}: ${key} is a gradient with >= 2 colors`,
      grad.colors.length >= 2 && grad.colors.every(isGradientColor),
      `${raw}`);
    check("palettes", `${label}: ${key} carries a deg angle`, grad.angle !== null, `${raw}`);
    const fallback = GRADIENT_COLOR_KEYS.indexOf(key) === 1;
    if (fallback) {
      // inactive border may be a plain single color, which is not a gradient
      check("palettes", `${label}: ${key} acceptable`, grad.colors.length >= 1, `${raw}`);
    }
  }

  // WCAG targets from PALETTES.md / the task brief
  const bg = map.get("background");
  const fg = map.get("foreground");
  const muted = map.get("muted");
  const accent = map.get("accent");
  if (bg && fg) {
    const ratio = contrast(fg, bg);
    check("palettes", `${label}: foreground/background >= 7:1`, ratio >= 7,
      `${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
    info("palettes", `${label}: foreground/background ${ratio.toFixed(2)}:1`);
  }
  if (bg && muted) {
    const ratio = contrast(muted, bg);
    check("palettes", `${label}: muted/background >= 4.5:1`, ratio >= 4.5,
      `${muted} on ${bg} = ${ratio.toFixed(2)}:1`);
    info("palettes", `${label}: muted/background ${ratio.toFixed(2)}:1`);
  }
  if (bg && accent) {
    const ratio = contrast(accent, bg);
    check("palettes", `${label}: accent/background as text >= 4.5:1`, ratio >= 4.5,
      `${accent} on ${bg} = ${ratio.toFixed(2)}:1`);
    info("palettes", `${label}: accent/background ${ratio.toFixed(2)}:1`);
  }
  if (bg && map.get("light_foreground")) {
    const ratio = contrast(map.get("light_foreground"), bg);
    check("palettes", `${label}: light_foreground/background >= 7:1`, ratio >= 7,
      `${map.get("light_foreground")} on ${bg} = ${ratio.toFixed(2)}:1`);
  }
  if (map.get("selection") && fg && bg) {
    const ratio = contrast(fg, mix(bg, map.get("selection"), 0.35));
    check("palettes", `${label}: foreground on selection tint >= 4.5:1`, ratio >= 4.5,
      `= ${ratio.toFixed(2)}:1`);
  }

  palettes.push({ label, file, map, table: resolveColorTable(map) });
}

group("palettes", () => {
  // repo root colors.toml is the default skin (what a plain install uses)
  loadPalette(`${DEFAULT_SKIN} (repo root)`, join(REPO, "colors.toml"));
  // each variant is a self-contained skin with its own colors.toml/shell.toml
  for (const skin of SKINS) {
    loadPalette(`variants/${skin}`, join(REPO, "variants", skin, "colors.toml"));
  }
});

// ---------------------------------------------------------------------------
// 6. shell.toml schema + values
// ---------------------------------------------------------------------------

function parseShellSchema(file) {
  const sections = new Map();
  let current = null;
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    const text = stripComment(line).trim();
    if (!text) {
      const commented = line.match(/^\s*#\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/);
      if (commented && current && !sections.get(current).has(commented[1])) {
        sections.get(current).set(commented[1], { type: "optional" });
      }
      continue;
    }
    const header = text.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const kv = text.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!kv || !current) continue;
    const value = kv[2].trim();
    let type = "optional";
    if (value.startsWith('"')) type = "string";
    else if (value === "true" || value === "false") type = "bool";
    else if (Number.isFinite(Number(value))) type = "number";
    sections.get(current).set(kv[1], { type });
  }
  return sections;
}

function parseShellFile(file) {
  const sections = new Map();
  let current = null;
  const problems = [];
  const lines = splitLines(readFileSync(file, "utf8"));
  lines.forEach((line, index) => {
    const text = stripComment(line).trim();
    if (!text) return;
    const header = text.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (header) {
      current = header[1];
      if (sections.has(current)) problems.push(`line ${index + 1}: duplicate section [${current}]`);
      sections.set(current, new Map());
      return;
    }
    if (!current) {
      problems.push(`line ${index + 1}: key outside a section`);
      return;
    }
    const kv = text.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!kv) {
      problems.push(`line ${index + 1}: not key = value: ${text.slice(0, 40)}`);
      return;
    }
    const parsed = parseTomlValue(kv[2]);
    if (parsed.error) {
      problems.push(`line ${index + 1}: ${kv[1]}: ${parsed.error}`);
      return;
    }
    if (sections.get(current).has(kv[1])) problems.push(`line ${index + 1}: duplicate key ${kv[1]}`);
    sections.get(current).set(kv[1], parsed);
  });
  return { sections, problems };
}

const SHELL_PALETTE_MAP = [
  ["bar", "background", "background"], ["bar", "text", "foreground"], ["bar", "active", "red"],
  ["popups", "background", "background"], ["popups", "text", "foreground"],
  ["tooltip", "background", "darker_background"], ["tooltip", "text", "foreground"],
  ["notifications", "background", "background"], ["notifications", "text", "foreground"],
  ["notifications", "countdown", "accent"],
  ["launcher", "background", "darker_background"], ["launcher", "scrim", "background"],
  ["launcher", "selected-background", "selection"], ["launcher", "selected-text", "accent"],
  ["menu", "background", "background"], ["menu", "scrim", "background"],
  ["menu", "selected-background", "selection"], ["menu", "selected-text", "accent"],
  ["polkit", "background", "background"], ["polkit", "text", "foreground"],
  ["polkit", "text-error", "red"], ["polkit", "border-error", "red"],
  ["polkit", "scrim", "background"], ["polkit", "accent", "accent"],
  ["lock", "background", "background"], ["lock", "text", "light_foreground"],
  ["lock", "text-error", "red"], ["lock", "border-error", "red"], ["lock", "selection", "accent"],
  ["image-picker", "text", "foreground"], ["image-picker", "selected-border", "accent"],
  ["image-picker", "unselected-border", "foreground"],
];

let shellSchema = null;
const shellFiles = [];

function validateShellFile(label, file, palette) {
  const { sections, problems } = parseShellFile(file);
  check("shell schema", `${label}: parses as TOML`, problems.length === 0, problems.slice(0, 4).join("; "));

  const map = palette.map;
  const colorTable = palette.table;

  for (const [section, keys] of sections) {
    const schemaSection = shellSchema.get(section);
    check("shell schema", `${label}: [${section}] exists in shell.toml.tpl`, Boolean(schemaSection),
      `unknown section [${section}]`);
    if (!schemaSection) continue;
    for (const [key, parsed] of keys) {
      const schemaKey = schemaSection.get(key);
      check("shell schema", `${label}: [${section}].${key} exists in shell.toml.tpl`,
        Boolean(schemaKey), `unknown key ${key} in [${section}]`);
      if (schemaKey && schemaKey.type !== "optional" && parsed.type !== schemaKey.type) {
        check("shell schema", `${label}: [${section}].${key} type ${schemaKey.type}`, false,
          `got ${parsed.type}`);
      }
      if (parsed.type === "number") {
        if (key.endsWith("-alpha")) {
          check("shell schema", `${label}: [${section}].${key} alpha in 0..1`,
            parsed.value >= 0 && parsed.value <= 1, `= ${parsed.value}`);
        } else if (key === "scale") {
          check("shell schema", `${label}: [${section}].scale sane`,
            parsed.value >= 0.75 && parsed.value <= 2, `= ${parsed.value}`);
        } else if (key === "base-size") {
          check("shell schema", `${label}: [${section}].base-size sane`,
            parsed.value >= 8 && parsed.value <= 24, `= ${parsed.value}`);
        } else if (key === "size-horizontal" || key === "size-vertical") {
          check("shell schema", `${label}: [${section}].${key} sane`,
            parsed.value >= 20 && parsed.value <= 60, `= ${parsed.value}`);
        } else if (key.endsWith("-width")) {
          check("shell schema", `${label}: [${section}].${key} non-negative`,
            parsed.value >= 0, `= ${parsed.value}`);
        }
      }
      if (parsed.type === "string") {
        const value = parsed.value;
        if (value.includes(" ")) {
          const grad = parseGradient(value, colorTable);
          check("shell schema", `${label}: [${section}].${key} gradient syntax`,
            grad.colors.length >= 1 && grad.colors.every(isGradientColor),
            `${value}`);
          if (grad.angle !== null) {
            check("shell schema", `${label}: [${section}].${key} angle parses`,
              Number.isFinite(Number(grad.angle)), `angle ${grad.angle}`);
          }
        } else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
          const [refSection, refKey] = value.split(".");
          const target = sections.get(refSection);
          check("shell schema", `${label}: [${section}].${key} reference ${value} resolves`,
            Boolean(target && target.has(refKey)), `${value} not defined in this shell.toml`);
          if (target && target.has(refKey)) {
            const refValue = target.get(refKey);
            check("shell schema", `${label}: [${section}].${key} reference target is a color`,
              refValue.type === "string", `${value} = ${JSON.stringify(refValue.value)}`);
          }
        } else {
          check("shell schema", `${label}: [${section}].${key} is a color`,
            HEX6.test(value) || HEX8.test(value), `${value}`);
        }
      }
    }
  }

  // Intent checks: the pack promises gradient borders and translucent surfaces.
  const hypr = sections.get("hyprland") || new Map();
  const active = hypr.get("active-border");
  if (active && active.type === "string") {
    const grad = parseGradient(active.value, colorTable);
    check("shell schema", `${label}: [hyprland].active-border is a 2-stop gradient`,
      grad.colors.length >= 2 && grad.angle !== null, `${active.value}`);
    const hexes = grad.colors.map((c) => colorToShellHex(c, colorTable).toLowerCase());
    if (grad.colors.length >= 2) {
      check("shell schema", `${label}: border gradient starts at accent`,
        hexes[0] === map.get("accent"), `${hexes[0]} vs ${map.get("accent")}`);
      check("shell schema", `${label}: border gradient ends at violet`,
        hexes[hexes.length - 1] === map.get("violet"),
        `${hexes[hexes.length - 1]} vs ${map.get("violet")}`);
    }
  }
  check("shell schema", `${label}: [bar] is translucent (bar-alpha < 1)`,
    (sections.get("bar") || new Map()).get("background-alpha")?.value < 1,
    "bar background-alpha must be < 1");
  check("shell schema", `${label}: [popups] is translucent`,
    (sections.get("popups") || new Map()).get("background-alpha")?.value < 1,
    "popups background-alpha must be < 1");

  // Colors must agree with the matching colors.toml.
  for (const [section, key, colorKey] of SHELL_PALETTE_MAP) {
    const value = sections.get(section)?.get(key);
    if (!value || value.type !== "string") continue;
    check("shell schema", `${label}: [${section}].${key} == colors.${colorKey}`,
      value.value.toLowerCase() === String(map.get(colorKey)).toLowerCase(),
      `${value.value} != ${map.get(colorKey)}`);
  }
  const placeholder = sections.get("lock")?.get("placeholder");
  const expectedPlaceholder = mix(map.get("foreground"), map.get("background"), 0.34);
  check("shell schema", `${label}: [lock].placeholder is the 34% mix`,
    placeholder && placeholder.value.toLowerCase() === expectedPlaceholder.toLowerCase(),
    `${placeholder && placeholder.value} != ${expectedPlaceholder}`);

  shellFiles.push({ label, file, palette });
}

group("shell schema", () => {
  if (existsSync(SHELL_TPL)) shellSchema = parseShellSchema(SHELL_TPL);
  const sectionNames = shellSchema ? [...shellSchema.keys()] : [];
  check("shell schema", "shell.toml.tpl exposes the expected sections",
    ["bar", "hyprland", "controls", "spacing", "font", "popups", "tooltip",
     "notifications", "launcher", "menu", "polkit", "lock", "image-picker"]
      .every((s) => shellSchema.has(s)),
    `sections: ${sectionNames.join(", ")}`);
  info("shell schema", `upstream schema: ${sectionNames.length} sections, ` +
    `${[...shellSchema.values()].reduce((n, keys) => n + keys.size, 0)} keys`);

  const byLabel = new Map(palettes.map((p) => [p.label, p]));
  validateShellFile("root shell.toml", join(REPO, "shell.toml"), byLabel.get("fontaine-nocturne (repo root)"));
  for (const skin of SKINS) {
    validateShellFile(`variants/${skin}/shell.toml`, join(REPO, "variants", skin, "shell.toml"),
      byLabel.get(`variants/${skin}`));
  }
});

// ---------------------------------------------------------------------------
// 7. preview art
// ---------------------------------------------------------------------------

function parsePng(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    return { error: "not a PNG (bad signature)" };
  }
  let offset = 8;
  let header = null;
  const texts = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9],
      };
    } else if (type === "tEXt" || type === "iTXt") {
      const zero = data.indexOf(0);
      const keyword = data.toString("latin1", 0, zero === -1 ? data.length : zero);
      const rest = data.toString("latin1", zero + 1);
      texts.push({ keyword, text: rest });
    } else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) return { error: "no IHDR chunk" };
  return { ...header, texts };
}

function checkPreview(label, candidateDirs) {
  for (const spec of PREVIEW_SPEC) {
    // The default skin's variant reuses the repo-root art (same skin as the
    // default install); alt skins must ship their own files.
    const file = candidateDirs.map((dir) => join(dir, spec.file)).find((candidate) => existsSync(candidate));
    check("preview art", `${label}/${spec.file} exists`, Boolean(file),
      `missing ${spec.file} in ${candidateDirs.map((dir) => relative(REPO, dir) || ".").join(" or ")}`);
    if (!file) continue;
    const buffer = readFileSync(file);
    const png = parsePng(buffer);
    check("preview art", `${label}/${spec.file} is PNG`, !png.error, png.error || "");
    if (png.error) continue;
    check("preview art", `${label}/${spec.file} is ${spec.width}x${spec.height}`,
      png.width === spec.width && png.height === spec.height,
      `got ${png.width}x${png.height}`);
    if (spec.wide) {
      check("preview art", `${label}/${spec.file} is 16:9`,
        Math.abs(png.width * 9 - png.height * 16) <= 16, `${png.width}x${png.height}`);
    }
    check("preview art", `${label}/${spec.file} is not empty`,
      buffer.length > spec.minBytes, `${(buffer.length / 1024).toFixed(0)} KiB`);
    const placeholder = png.texts.some((t) => t.keyword === "furina" && /placeholder/i.test(t.text));
    check("preview art", `${label}/${spec.file} is not leftover placeholder art`,
      ALLOW_PLACEHOLDER || !placeholder,
      "generated placeholder still in the repo — copy preview-artist's PNGs from _shared/assets/omarchy");
  }
}

group("preview art", () => {
  checkPreview("default skin", [REPO]);
  for (const skin of SKINS) {
    const dir = join(REPO, "variants", skin);
    checkPreview(`variants/${skin}`, skin === DEFAULT_SKIN ? [dir, REPO] : [dir]);
  }
  check("preview art", "theme-switcher art: preview.png, preview-unlock.png, unlock.png present at root",
    PREVIEW_SPEC.every((s) => existsSync(join(REPO, s.file))), "root art incomplete");
});

// ---------------------------------------------------------------------------
// 8. backgrounds + `omarchy theme bg next` order
// ---------------------------------------------------------------------------

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return { error: "not a JPEG" };
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { error: "no SOF marker" };
}

group("backgrounds", () => {
  const dir = join(REPO, "backgrounds");
  const all = existsSync(dir)
    ? readdirSync(dir).filter((name) => !name.startsWith(".") && lstatSync(join(dir, name)).isFile())
    : [];
  const files = all.filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name));
  const docs = all.filter((name) => !/\.(jpg|jpeg|png|webp)$/i.test(name));
  const expected = [
    `0-${SKINS[0]}.jpg`, `1-${SKINS[1]}.jpg`, `2-${SKINS[2]}.jpg`,
  ];
  check("backgrounds", "all three wallpapers present", expected.every((f) => files.includes(f)),
    `found ${files.join(", ")}`);
  check("backgrounds", "nothing but wallpapers and README.md in backgrounds/",
    files.length === expected.length && docs.every((name) => name === "README.md"),
    `stray entries: ${[...files.filter((f) => !expected.includes(f)), ...docs.filter((d) => d !== "README.md")].join(", ")}`);

  const sorted = [...files].sort();
  check("backgrounds", "bg-next cycle order is deterministic [0,1,2]",
    sorted.join(",") === expected.slice().sort().join(","),
    `sorted: ${sorted.join(", ")}`);
  info("backgrounds", `omarchy theme bg next cycles: ${sorted.join(" -> ")}`);

  for (const name of files) {
    const buffer = readFileSync(join(dir, name));
    const jpeg = jpegSize(buffer);
    check("backgrounds", `${name} is a 2560x1440 JPEG`,
      !jpeg.error && jpeg.width === 2560 && jpeg.height === 1440,
      jpeg.error || `${jpeg.width}x${jpeg.height}`);
    check("backgrounds", `${name} is 16:9`, Math.abs(2560 * 9 - 1440 * 16) === 0, "");
    check("backgrounds", `${name} has plausible file size`,
      buffer.length > 100 * 1024, `${(buffer.length / 1024).toFixed(0)} KiB`);
  }

  for (const skin of SKINS) {
    const refFile = join(REPO, "variants", skin, "background");
    if (!existsSync(refFile)) continue;
    const ref = readFileSync(refFile, "utf8").trim();
    const target = join(REPO, ref);
    check("backgrounds", `variants/${skin}/background points at an existing wallpaper`,
      ref !== "" && !ref.startsWith("/") && !ref.includes("..") && existsSync(target), `${ref}`);
    check("backgrounds", `variants/${skin}/background uses backgrounds/<index>-<skin>.jpg`,
      new RegExp(`^backgrounds/\\d-${skin}\\.(jpg|jpeg|png|webp)$`).test(ref), `${ref}`);
  }
});

// ---------------------------------------------------------------------------
// 9. variant install/uninstall scripts
// ---------------------------------------------------------------------------

function readScript(name) {
  const file = join(REPO, "scripts", name);
  return { file, exists: existsSync(file), text: existsSync(file) ? readFileSync(file, "utf8") : "" };
}

function validateScript(name, { mustMentionSkins = true } = {}) {
  const { file, exists, text } = readScript(name);
  check("scripts", `scripts/${name} exists`, exists, "missing");
  if (!exists) return;
  check("scripts", `scripts/${name} is POSIX sh`, /^#!\/bin\/sh\n/.test(text),
    "first line must be #!/bin/sh");
  check("scripts", `scripts/${name} uses set -eu`, /\nset -eu\n/.test(text), "missing `set -eu`");
  check("scripts", `scripts/${name} has no bashisms`, !/\[\[|\blocal \b|\bfunction \b|\$RANDOM|declare -/.test(text),
    "found [[, local, function, $RANDOM or declare -");
  check("scripts", `scripts/${name} never calls sudo`, !/\bsudo\b/.test(text), "sudo is not allowed");
  check("scripts", `scripts/${name} honours XDG_CONFIG_HOME`,
    text.includes("XDG_CONFIG_HOME"), "must respect ${XDG_CONFIG_HOME:-$HOME/.config}");
  check("scripts", `scripts/${name} uses LF line endings`, !text.includes("\r"), "CRLF found");
  if (mustMentionSkins) {
    for (const skin of SKINS) {
      check("scripts", `scripts/${name} mentions ${skin}`, text.includes(skin), `skin ${skin} missing`);
    }
  }
}

group("scripts", () => {
  validateScript("install-variants.sh");
  validateScript("uninstall-variants.sh");

  const install = readScript("install-variants.sh");
  const uninstall = readScript("uninstall-variants.sh");
  if (install.exists) {
    check("scripts", "install resolves its own repo root", install.text.includes("dirname"), "no dirname self-location");
    check("scripts", "install writes to <config>/omarchy/themes", /omarchy\/themes/.test(install.text),
      "expected $XDG_CONFIG_HOME/omarchy/themes");
    check("scripts", "install is idempotent (rm -rf + mkdir -p)", /rm -rf/.test(install.text) && /mkdir -p/.test(install.text), "");
    check("scripts", "install copies colors.toml/shell.toml", /colors\.toml/.test(install.text) && /shell\.toml/.test(install.text), "");
    check("scripts", "install copies preview.png/preview-unlock.png/unlock.png",
      ["preview.png", "preview-unlock.png", "unlock.png"].every((f) => install.text.includes(f)), "");
    check("scripts", "install copies the wallpaper into backgrounds/",
      /backgrounds/.test(install.text) && /background/.test(install.text), "");
    check("scripts", "install tells the user to run omarchy-theme-set",
      install.text.includes("omarchy-theme-set"), "");
    check("scripts", "install guards against deleting the repo itself",
      /refus|fatal|die|case .*\$REPO_DIR/.test(install.text), "no guard around rm -rf target");
  }
  if (uninstall.exists) {
    check("scripts", "uninstall removes only furina-<variant> dirs",
      /furina-\$/.test(uninstall.text) || /furina-/.test(uninstall.text), "");
    check("scripts", "uninstall never removes the default pack theme",
      !/rm -rf .*[\"]?\$THEMES_DIR[\"]?$/.test(uninstall.text), "");
    check("scripts", "uninstall protects the active theme (force flag)",
      /--force|-f/.test(uninstall.text), "no active-theme guard");
  }

  // POSIX syntax check when a shell binary is available (sh, bash, or the
  // Git for Windows bash that ships with git on this host).
  const shellCandidates = [
    "sh",
    "bash",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : null,
  ].filter(Boolean);
  let shell = null;
  for (const candidate of shellCandidates) {
    const probe = spawnSync(candidate, ["-n", join(REPO, "scripts", "install-variants.sh")], { encoding: "utf8" });
    if (!probe.error) {
      shell = candidate;
      break;
    }
  }
  if (!shell) {
    info("scripts", "no sh/bash binary found on this host, `sh -n` syntax check skipped");
  } else {
    for (const name of ["install-variants.sh", "uninstall-variants.sh"]) {
      const file = join(REPO, "scripts", name);
      if (!existsSync(file)) continue;
      const probe = spawnSync(shell, ["-n", file], { encoding: "utf8" });
      check("scripts", `${name} passes ${basename(shell)} -n`, probe.status === 0,
        (probe.stderr || "").split("\n").slice(0, 2).join(" "));
    }
    info("scripts", `POSIX syntax checked with ${shell}`);
  }

  // Variant payload completeness (what install-variants.sh copies).
  for (const skin of SKINS) {
    const dir = join(REPO, "variants", skin);
    for (const file of ["colors.toml", "shell.toml", "background"]) {
      check("scripts", `variant payload variants/${skin}/${file}`, existsSync(join(dir, file)), "missing");
    }
    const art = ["preview.png", "preview-unlock.png", "unlock.png"].filter((f) => existsSync(join(dir, f)));
    if (skin === DEFAULT_SKIN) {
      check("scripts", "default-skin variant art resolves from repo root",
        ["preview.png", "preview-unlock.png", "unlock.png"].every((f) => existsSync(join(REPO, f))),
        "root preview art missing");
    } else {
      check("scripts", `variants/${skin} ships its own preview art`, art.length === 3,
        `found ${art.join(", ") || "none"}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. template engine (the real thing, reduced to its rules)
// ---------------------------------------------------------------------------

const MIX_RE = /\{\{[ \t]*mix(_strip|_rgb)?[ \t]+[A-Za-z0-9_]+[ \t]+[A-Za-z0-9_]+[ \t]+[0-9]+(\.[0-9]+)?%?[ \t]*\}\}/g;
const GRADIENT_RE = /\{\{[ \t]*(hypr_gradient|gradient_start|shell_gradient)[ \t]+[^}]+[ \t]*\}\}/g;

function reAddFlags(re) {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
}
const MIX_SCAN = reAddFlags(MIX_RE);
const GRADIENT_SCAN = reAddFlags(GRADIENT_RE);

function buildValueTable(table) {
  const values = new Map();
  for (const [key, value] of table) {
    values.set(`{{ ${key} }}`, value);
    values.set(`{{ ${key}_strip }}`, value.startsWith("#") ? value.slice(1) : value);
    if (HEX6.test(value)) {
      values.set(`{{ ${key}_rgb }}`, hexToRgb(value).join(","));
    }
  }
  return values;
}

function mixTokenValue(token, table) {
  const content = token.slice(2, -2).trim();
  const [fn, startKey, endKey, amountRaw] = content.split(/\s+/);
  const start = table.get(startKey);
  const end = table.get(endKey);
  if (!start || !end || !HEX6.test(start) || !HEX6.test(end)) return undefined;
  if (!["mix", "mix_strip", "mix_rgb"].includes(fn)) return undefined;
  let amount = amountRaw.endsWith("%") ? Number(amountRaw.slice(0, -1)) / 100 : Number(amountRaw);
  if (!amountRaw.endsWith("%") && amount > 1) amount /= 100;
  amount = Math.min(1, Math.max(0, amount));
  const value = mix(start, end, amount);
  if (fn === "mix_strip") return value.slice(1);
  if (fn === "mix_rgb") return hexToRgb(value).join(",");
  return value;
}

function gradientTokenValue(token, table) {
  const content = token.slice(2, -2).trim();
  const parts = content.split(/\s+/);
  const fn = parts[0];
  const key = parts[1];
  const fallback = parts[2];
  let spec;
  if (key && table.has(key)) spec = table.get(key);
  else if (fallback && table.has(fallback)) spec = table.get(fallback);
  else if (fallback) spec = fallback;
  else spec = key || "";
  const grad = parseGradient(spec, table);

  if (fn === "hypr_gradient") {
    if (grad.colors.length === 0) return `"${spec}"`;
    if (grad.colors.length === 1) return `"${grad.colors[0]}"`;
    let out = "{ colors = {";
    grad.colors.forEach((color, index) => {
      if (index > 0) out += ",";
      out += ` "${color}"`;
    });
    out += " }";
    if (grad.angle !== null) out += `, angle = ${grad.angle}`;
    return out + " }";
  }
  if (fn === "gradient_start") {
    return colorToShellHex(grad.colors.length ? grad.colors[0] : spec, table);
  }
  if (fn === "shell_gradient") {
    if (grad.colors.length === 0) return spec;
    let out = grad.colors.join(" ");
    if (grad.angle !== null) out += ` ${grad.angle}deg`;
    return out;
  }
  return undefined;
}

/** omarchy-theme-set-templates' awk render(): replace known {{ ... }} spans. */
function renderTemplate(text, values) {
  let out = "";
  let line = text;
  for (;;) {
    const open = line.indexOf("{{");
    if (open === -1) return out + line;
    const close = line.indexOf("}}", open + 2);
    if (close === -1) return out + line;
    const token = line.slice(open, close + 2);
    if (values.has(token)) {
      out += line.slice(0, open) + values.get(token);
      line = line.slice(open + token.length);
    } else {
      out += line.slice(0, open + 1);
      line = line.slice(open + 1);
    }
  }
}

function templateFiles() {
  if (!existsSync(TEMPLATE_DIR)) return [];
  return readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".tpl")).sort()
    .map((f) => join(TEMPLATE_DIR, f));
}

function renderAllTemplates(label, table) {
  const values = buildValueTable(table);
  const files = templateFiles();
  const leftovers = [];
  const rendered = [];

  const tokens = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.match(MIX_SCAN) || []) tokens.add(match);
    for (const match of text.match(GRADIENT_SCAN) || []) tokens.add(match);
  }
  for (const token of tokens) {
    if (MIX_RE.test(token)) {
      MIX_RE.lastIndex = 0;
      const value = mixTokenValue(token, table);
      if (value !== undefined) values.set(token, value);
    } else {
      GRADIENT_RE.lastIndex = 0;
      const value = gradientTokenValue(token, table);
      if (value !== undefined) values.set(token, value);
    }
    MIX_RE.lastIndex = 0;
    GRADIENT_RE.lastIndex = 0;
  }

  for (const file of files) {
    const name = basename(file);
    const text = readFileSync(file, "utf8");
    const output = renderTemplate(text, values);
    rendered.push({ name, output });
    const bad = [];
    for (const [index, line] of splitLines(output).entries()) {
      if (line.includes("{{") || line.includes("}}")) bad.push(`${index + 1}: ${line.trim().slice(0, 90)}`);
    }
    if (bad.length) leftovers.push({ name, bad });
  }

  check("templates", `${label}: every template renders with zero {{ }} placeholders`,
    leftovers.length === 0,
    leftovers.slice(0, 3).map((l) => `${l.name} -> ${l.bad[0]}`).join(" | "));
  check("templates", `${label}: rendered output is non-empty`,
    rendered.every((r) => r.output.length > 0), "empty rendered template");
  check("templates", `${label}: templates resolve >= ${tokens.size} function tokens`,
    tokens.size >= 4, `only ${tokens.size} function tokens found`);

  return { label, rendered, tokens: tokens.size };
}

group("templates", () => {
  const files = templateFiles();
  check("templates", "template set loaded", files.length > 0, `no *.tpl under ${TEMPLATE_DIR}`);
  const shellTpl = files.find((f) => basename(f) === "shell.toml.tpl");
  check("templates", "shell.toml.tpl present in the set", Boolean(shellTpl), "missing");

  if (files.length) {
    let last;
    for (const palette of palettes) {
      last = renderAllTemplates(palette.label, palette.table);
    }
    if (last) {
      info("templates", `${files.length} templates x ${palettes.length} palettes rendered; ` +
        `${last.tokens} function tokens resolved for the last skin`);
      // spot-check known generated files carry real colors
      for (const name of ["alacritty.toml", "btop.theme", "helix.toml", "hyprland.lua", "keyboard.rgb"]) {
        const hit = last.rendered.find((r) => r.name === `${name}.tpl`);
        if (!hit) continue;
        check("templates", `${last.label}: ${name} generated with theme colors`,
          /#[0-9a-f]{6}/i.test(hit.output), `${name} has no hex colors`);
        check("templates", `${last.label}: ${name} has no template syntax left`,
          !/\{\{|\}\}/.test(hit.output), `${name} contains {{ }}`);
      }
      const hypr = last.rendered.find((r) => r.name === "hyprland.lua.tpl");
      if (hypr) {
        const border = hypr.output.match(/active_border_color\s*=\s*(.+)/);
        check("templates", "hyprland.lua gets the gradient active border",
          Boolean(border && /colors\s*=\s*\{/.test(border[1]) && /angle\s*=\s*35/.test(border[1])),
          border ? border[1].trim().slice(0, 120) : "active_border_color line missing");
      }
      // foot.ini uses *_strip values on purpose (no leading '#').
      const foot = last.rendered.find((r) => r.name === "foot.ini.tpl");
      if (foot) {
        check("templates", `${last.label}: foot.ini generated with theme colors`,
          /=\s*[0-9a-f]{6}\b/im.test(foot.output), "foot.ini carries no bare hex values");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 11. staging simulation: what lands in ~/.local/state/omarchy/current/theme
// ---------------------------------------------------------------------------

group("staging", () => {
  const entries = walk(REPO).filter((e) => !e.rel.startsWith(".git/") && e.rel !== ".git");
  const deniedNames = new Set(INSTALLED_THEME_DENIED);
  const staged = entries.filter((e) =>
    !e.symlink && !e.rel.endsWith(".lua") && !deniedNames.has(basename(e.rel)));

  for (const rel of ["colors.toml", "shell.toml", "preview.png", "preview-unlock.png", "unlock.png",
                     "backgrounds/0-fontaine-nocturne.jpg", "backgrounds/1-hydro-iris.jpg",
                     "backgrounds/2-salon-solitude.jpg"]) {
    check("staging", `staged theme contains ${rel}`, staged.some((e) => e.rel === rel),
      "file would not reach the staged theme");
  }

  // If the staged theme ships a file the template engine also generates, the
  // shipped file wins and the generated one is skipped. Only shell.toml may do
  // that on purpose; anything else would silently replace a generated config.
  // (variants/<skin>/shell.toml is not staged at theme root, so it is fine.)
  const generated = new Set(templateFiles().map((f) => basename(f).replace(/\.tpl$/, "")));
  const collisions = staged.filter((e) => !e.dir && generated.has(e.rel) && e.rel !== "shell.toml");
  check("staging", "no unintended override of a generated config", collisions.length === 0,
    collisions.map((c) => c.rel).join(", "));
  check("staging", "shell.toml overrides the generated shell config on purpose",
    existsSync(join(REPO, "shell.toml")), "missing shell.toml");

  // The installer needs colors.toml *before* templates render.
  check("staging", "colors.toml staged so templates can render",
    staged.some((e) => e.rel === "colors.toml"), "no colors.toml in staged theme");

  // Background selection reads backgrounds/ sorted and -type f; images only.
  const bg = staged.filter((e) => e.rel.startsWith("backgrounds/") && !e.dir && /\.(jpg|jpeg|png|webp)$/i.test(e.rel))
    .map((e) => e.rel.slice("backgrounds/".length)).sort();
  check("staging", "staged backgrounds/ holds the three wallpapers",
    bg.length === 3 && bg.every((name) => /^\d-[a-z-]+\.jpg$/.test(name)),
    bg.join(", "));
});

// ---------------------------------------------------------------------------
// 12. docs: README + LICENSE
// ---------------------------------------------------------------------------

group("docs", () => {
  check("docs", "README.md exists", readme.length > 0, "missing README.md");

  const requiredStrings = [
    ["install command", /omarchy theme install\s+https:\/\/github\.com\/TanPass\/furina-omarchy/],
    ["wallpaper cycling", /omarchy theme bg next/],
    ["background picker", /(background|wallpaper)[^\n]{0,40}picker|picker[^\n]{0,40}(background|wallpaper)/i],
    ["per-theme background overlay dir", /\.config\/omarchy\/backgrounds\/<theme-name>|\$HOME\/\.config\/omarchy\/backgrounds/],
    ["variant script", /install-variants\.sh/],
    ["variant uninstall", /uninstall-variants\.sh/],
    ["variant switch command", /omarchy-theme-set furina-/],
    ["validation command", /node tools\/validate\.mjs/],
    ["fan-art / licence note", /fan[- ]?art|licen[cs]e/i],
    ["default skin name", /fontaine-nocturne/],
  ];
  for (const [label, re] of requiredStrings) {
    check("docs", `README documents ${label}`, re.test(readme), `pattern ${re} not found`);
  }
  for (const skin of SKINS) {
    check("docs", `README names skin ${skin}`, readme.includes(skin), `missing ${skin}`);
  }
  const planMarkers = ["TO" + "DO", "FIX" + "ME", "W" + "IP", "PLACE" + "HOLDER"];
  check("docs", "README has no planning markers",
    !new RegExp(planMarkers.join("|"), "i").test(readme),
    "remove planning markers before shipping");

  for (const marker of ["```"]) {
    const count = readme.split(marker).length - 1;
    check("docs", "README code fences are balanced", count % 2 === 0, `${count} fence markers`);
  }

  // every markdown image must resolve inside the repo
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  const missingImages = images.filter((src) => {
    if (/^https?:/.test(src)) return false;
    return !existsSync(join(REPO, src));
  });
  check("docs", "README images resolve to files in the repo", missingImages.length === 0,
    missingImages.join(", "));
  check("docs", "README embeds preview art", images.some((src) => /preview\.png$/.test(src)),
    "no preview.png embed");

  const licenseFile = join(REPO, "LICENSE");
  const license = existsSync(licenseFile) ? readFileSync(licenseFile, "utf8") : "";
  check("docs", "LICENSE is MIT", /MIT License/i.test(license) && /Permission is hereby granted/.test(license),
    "LICENSE is not MIT");
  check("docs", "LICENSE names the holder", /Copyright \(c\)/.test(license), "no copyright line");
  info("docs", `README ${(readme.length / 1024).toFixed(1)} KiB, ${images.length} embedded images`);
});

// ---------------------------------------------------------------------------
// CRLF / encoding sanity for files Linux will execute or parse
// ---------------------------------------------------------------------------

group("encoding", () => {
  const textFiles = walk(REPO).filter((e) =>
    !e.dir && [".toml", ".sh", ".mjs", ".md", ".txt"].includes(extname(e.rel)));
  const crlf = textFiles.filter((e) => readFileSync(e.abs).includes("\r"));
  check("encoding", "all TOML/sh/MD/JS files use LF line endings", crlf.length === 0,
    crlf.slice(0, 5).map((e) => e.rel).join(", "));
  const bom = textFiles.filter((e) => {
    const buf = readFileSync(e.abs);
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  });
  check("encoding", "no UTF-8 BOM anywhere", bom.length === 0, bom.map((e) => e.rel).join(", "));
  const nonAsciiNames = walk(REPO).filter((e) => !/^[\x20-\x7e]+$/.test(e.rel));
  check("encoding", "file names are ASCII", nonAsciiNames.length === 0,
    nonAsciiNames.slice(0, 5).map((e) => e.rel).join(", "));
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const sections = [
  "reference", "repo shape", "clone filter", "naming", "palettes", "shell schema",
  "preview art", "backgrounds", "scripts", "templates", "staging", "docs", "encoding",
];

const pad = (text, width) => String(text).padEnd(width);
const results = [];
for (const section of sections) {
  const own = checks.filter((c) => c.section === section);
  const failed = own.filter((c) => !c.ok);
  results.push({ section, total: own.length, failed: failed.length });
}

const width = Math.max(...sections.map((s) => s.length), "preview art".length) + 2;
console.log("");
console.log("Furina Omarchy theme pack — installability validation");
console.log(`repo : ${REPO}`);
console.log(`refs : ${REFS}`);
console.log("");

for (const section of sections) {
  const own = checks.filter((c) => c.section === section);
  const failed = own.filter((c) => !c.ok);
  const mark = failed.length ? "FAIL" : "PASS";
  console.log(`${mark}  ${pad(section, width)} ${own.length - failed.length}/${own.length} checks`);
  if (VERBOSE) {
    for (const c of own) {
      console.log(`        ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok || !c.detail ? "" : ` — ${c.detail}`}`);
    }
  }
  for (const c of failed) {
    if (!VERBOSE) console.log(`        x ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  for (const i of infos.filter((i) => i.section === section)) {
    console.log(`        · ${i.message}`);
  }
}

const totalChecks = checks.length;
const totalFailed = checks.filter((c) => !c.ok).length;
const elapsed = ((Date.now() - started) / 1000).toFixed(2);

console.log("");
console.log(`checks: ${totalChecks - totalFailed}/${totalChecks} passed in ${elapsed}s`);
if (totalFailed === 0) {
  console.log("RESULT: PASS — the pack is installable with `omarchy theme install`, all palettes render,");
  console.log("        shell.toml matches the v4 schema, and every shipped skin passes its checks.");
  console.log("        (Templates rendered from local copies; no network was used.)");
}
else {
  console.log(`RESULT: FAIL — ${totalFailed} check(s) failed:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log("");
  console.log("Fix the failures above. `--allow-placeholder` only bypasses the preview-art");
  console.log("placeholder gate while art is still being produced.");
}
console.log("");
process.exit(totalFailed === 0 ? 0 : 1);
