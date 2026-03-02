#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execFileSync } = require("child_process");
const readline = require("readline");

const STATE = {
  THEME_COLOR: process.env.THEME_COLOR || process.env.COLOR_VAR || null,
  COLOR_VAR: process.env.COLOR_VAR || null,
  FG_VAR: process.env.FG_VAR || null,
  BG_VAR: process.env.BG_VAR || null,
  FG_THEME_TEXT: process.env.FG_THEME_TEXT || null,
  NAMESPACE:
    process.env.NAMESPACE ||
    process.env.SESSION_NAME ||
    defaultNamespace(),
};

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function THEMEFILE(dir = process.cwd()) {
  return path.join(realpathSafe(dir), ".themefile");
}

function rHex() {
  const rand = () => Math.floor(Math.random() * 156) + 50;
  const r = rand();
  const g = rand();
  const b = rand();
  return `#${[r, g, b]
    .map((n) => n.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;
}

function isHex(input) {
  if (!input) return false;
  const c = String(input).replace(/^#/, "");
  return /^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c);
}

function normalizeHex(input) {
  let c = String(input).replace(/^#/, "");
  if (c.length === 3) {
    c = c
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  return `#${c.toUpperCase()}`;
}

function applyThemeVars(c) {
  const color = normalizeHex(c);
  STATE.THEME_COLOR = color;
  STATE.COLOR_VAR = color;
  STATE.FG_VAR = `%F{${color}}`;
  STATE.BG_VAR = `%K{${color}}`;

  const hex = color.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const brightness = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
  const threshold = 0x88;

  STATE.FG_THEME_TEXT =
    brightness > threshold ? "%F{#000000}" : "%F{#FFFFFF}";

  return STATE;
}

function setNamespace(ns) {
  STATE.NAMESPACE = ns;
}

function defaultNamespace() {
  const parent = realpathSafe(path.resolve(process.cwd(), ".."));
  return `${path.basename(parent)}/${path.basename(process.cwd())}`;
}

function readThemefileLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

function saveThemefile() {
  const file = THEMEFILE();
  const extras = [];

  if (fs.existsSync(file)) {
    for (const line of readThemefileLines(file)) {
      if (
        !line ||
        line.startsWith("THEME_COLOR=") ||
        line.startsWith("NAMESPACE=")
      ) {
        continue;
      }
      extras.push(line);
    }
  }

  const out = [
    `THEME_COLOR="${STATE.THEME_COLOR || ""}"`,
    `NAMESPACE="${STATE.NAMESPACE || ""}"`,
    ...extras,
    "",
  ].join("\n");

  fs.writeFileSync(file, out, "utf8");
}

function loadThemefile() {
  const file = THEMEFILE();
  if (!fs.existsSync(file)) return;

  for (const line of readThemefileLines(file)) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;

    const k = line.slice(0, idx);
    let v = line.slice(idx + 1).trim();
    v = v.replace(/^"/, "").replace(/"$/, "");

    if (k === "THEME_COLOR" && v) applyThemeVars(v);
    if (k === "NAMESPACE") setNamespace(v);
  }
}

function listItems(maxItems = Number(process.env.THEME_AI_MAX_ITEMS || 8)) {
  try {
    return fs.readdirSync(process.cwd(), { withFileTypes: true })
      .map((d) => d.name)
      .slice(0, maxItems)
      .join(" ");
  } catch {
    return "";
  }
}

function shellSplit(str) {
  if (!str) return [];
  const out = [];
  let cur = "";
  let q = null;
  let esc = false;

  for (const ch of str) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

async function fetchThemeHexOverHttp({
  prompt,
  dirBase,
  ns,
  dirAbs,
  items,
  timeout,
  themeAiHttpUrl,
}) {
  if (!themeAiHttpUrl) return null;

  const body = {
    prompt,
    basename: dirBase,
    namespace: ns,
    path: dirAbs,
    items,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeout) * 1000);

  try {
    const response = await fetch(themeAiHttpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const resp = await response.text();
    const match = resp.match(/#[0-9A-Fa-f]{6}/);
    return match ? match[0] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function themeAiColor() {
  const dirBase = path.basename(process.cwd());
  const dirAbs = realpathSafe(process.cwd());
  const ns = STATE.NAMESPACE || dirBase;
  const items = listItems();
  const prompt = `Return one hex color (#RRGGBB) that fits the vibe of directory '${dirBase}' (namespace '${ns}') at path '${dirAbs}'. Nearby items: ${items}. Respond with only the color.`;
  const timeout = Number(process.env.THEME_AI_TIMEOUT || 4);

  if (process.env.THEME_AI_CMD) {
    const aiCmd = shellSplit(process.env.THEME_AI_CMD);
    if (aiCmd.length) {
      try {
        const result = spawnSync(aiCmd[0], aiCmd.slice(1), {
          encoding: "utf8",
          timeout: timeout * 1000,
          env: {
            ...process.env,
            THEME_AI_PROMPT: prompt,
            THEME_AI_BASENAME: dirBase,
            THEME_AI_NAMESPACE: ns,
            THEME_AI_PATH: dirAbs,
            THEME_AI_ITEMS: items,
          },
          stdio: ["ignore", "pipe", "ignore"],
        });

        const out = (result.stdout || "").split(/\r?\n/)[0].trim();
        if (out) return out;
      } catch {}
    }
  }

  const hex = await fetchThemeHexOverHttp({
    prompt,
    dirBase,
    ns,
    dirAbs,
    items,
    timeout,
    themeAiHttpUrl: process.env.THEME_AI_HTTP_URL,
  });

  if (hex) return hex;

  return null;
}

function promptLine(text) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptColor(input) {
  let value = input;
  for (;;) {
    if (!value) {
      value = await promptLine("Insert Hex (#RRGGBB): ");
    }
    if (!isHex(value)) {
      console.log("\x1b[33mInvalid hex color.\x1b[0m");
      value = "";
      continue;
    }
    applyThemeVars(normalizeHex(value));
    return 0;
  }
}

async function confirmYN(prompt) {
  const answer = await promptLine(prompt);
  return /^(y|yes)$/i.test(answer.trim());
}

async function THEME_ROLL() {
  let current = "";
  if (STATE.THEME_COLOR || STATE.COLOR_VAR) {
    current = normalizeHex(STATE.THEME_COLOR || STATE.COLOR_VAR);
  }

  let fresh = "";
  let usedAi = false;

  const ai = await themeAiColor();
  if (ai) {
    console.log(ai);
    if (isHex(ai)) {
      fresh = normalizeHex(ai);
      usedAi = true;
    }
  } else {
    console.log("`new` is not a hex.");
    console.log(`new: ${fresh}`);
  }

  if (!fresh) {
    let attempts = 0;
    const maxAttempts = 12;
    while (attempts < maxAttempts) {
      fresh = rHex();
      if (!current) break;
      if (normalizeHex(fresh) !== current) break;
      attempts++;
    }
  }

  if (current && normalizeHex(fresh) === current) {
    const flipped =
      (parseInt(current.slice(1), 16) ^ 0x202020) & 0xffffff;
    fresh = `#${flipped.toString(16).padStart(6, "0").toUpperCase()}`;
    usedAi = false;
  }

  applyThemeVars(fresh);
  saveThemefile();

  if (usedAi) {
    console.log("\x1b[32mApplied AI-suggested theme and saved to .themefile.\x1b[0m");
  } else {
    console.log("\x1b[32mApplied random theme and saved to .themefile.\x1b[0m");
  }
}

async function SET_THEME(arg1 = "", arg2 = "") {
  if (arg1 && fs.existsSync(arg1) && fs.statSync(arg1).isFile()) {
    const file = arg1;
    const dir = path.dirname(file);
    setNamespace(path.basename(dir));

    for (const line of readThemefileLines(file)) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const k = line.slice(0, idx);
      let v = line.slice(idx + 1).trim();
      v = v.replace(/^"/, "").replace(/"$/, "");

      if (k === "THEME_COLOR") applyThemeVars(v);
      if (k === "NAMESPACE") setNamespace(v);
    }

    saveThemefile();
    console.log("\x1b[32mLoaded theme from\x1b[0m", file);
    return 0;
  }

  const color = arg1 || STATE.THEME_COLOR || STATE.COLOR_VAR;
  const ns = arg2 || STATE.NAMESPACE || path.basename(process.cwd());

  if (!arg1 && !arg2) {
    const ok = await confirmYN(`Use color ${color} and namespace "${ns}"? (y/N) `);
    if (!ok) {
      console.log("Aborted.");
      return 1;
    }
  }

  if (!isHex(color)) {
    console.log("\x1b[31mInvalid color. Use #RRGGBB.\x1b[0m");
    return 1;
  }

  applyThemeVars(normalizeHex(color));
  setNamespace(ns);
  saveThemefile();
  console.log("\x1b[32mSaved theme to .themefile.\x1b[0m");
  return 0;
}

async function THEME_INIT(colorArg, nsArg, rawArgs = []) {
  let color = colorArg || STATE.THEME_COLOR || STATE.COLOR_VAR;
  let ns = nsArg || STATE.NAMESPACE;

  console.log(`
Received:

argv : Array(${rawArgs.length})
`);

  rawArgs.forEach((arg, i) => {
    console.log(`argv[${i}]: ${arg}`);
  });

  if (!colorArg) {
    const replyColor = await promptLine(`Theme color [${color || ""}]: `);
    if (replyColor) color = replyColor;
  }

  if (!nsArg) {
    const replyNs = await promptLine(`Namespace [${ns || ""}]: `);
    if (replyNs) ns = replyNs;
  }

  if (!isHex(color)) {
    console.log(`is_hex returned.. "${String(isHex(color))}"`);
    console.log("\x1b[31mInvalid color. Use #RRGGBB.\x1b[0m");
    return 1;
  }

  applyThemeVars(normalizeHex(color));
  setNamespace(ns);
  saveThemefile();
  console.log("\x1b[32mWrote theme to .themefile in this directory.\x1b[0m");
  return 0;
}

function THEMEEDIT() {
  const f = THEMEFILE();
  if (!fs.existsSync(f)) fs.writeFileSync(f, "", "utf8");

  const editor = process.env.EDITOR || "vi";
  const result = spawnSync(editor, [f], { stdio: "inherit" });
  loadThemefile();
  return result.status || 0;
}

async function THEME(args) {
  const [cmd, ...rest] = args;

  switch (cmd) {
    case "set":
      return SET_THEME(rest[0], rest[1]);
    case "roll":
    case "random":
      return THEME_ROLL();
    case "init":
      return THEME_INIT(rest[0], rest[1], rest);
    case "edit":
      return THEMEEDIT();
  }

  const first = args[0];
  const ns = args.slice(1).join(" ");

  const rc = await promptColor(first);
  if (rc !== 0) return rc;

  setNamespace(ns);
  saveThemefile();
  console.log("\x1b[33mUse at your own risk.\x1b[0m");
  return 0;
}

function parseSpecialKv(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(line.trim());
  }
  return out;
}

function seza(args) {
  loadThemefile();

  const themeColor = STATE.THEME_COLOR || STATE.COLOR_VAR || "";
  let themeColorIcon = "";

  if (process.env.SEZA_ICON) {
    themeColorIcon = process.env.SEZA_ICON;
  } else if (process.env.SEZA_NAMESPACE_ICON) {
    themeColorIcon = process.env.SEZA_NAMESPACE_ICON;
  } else if (STATE.NAMESPACE) {
    themeColorIcon = STATE.NAMESPACE;
  }

  try {
    execFileSync("eza", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("seza: eza is not installed");
    return 127;
  }

  let pairs = parseSpecialKv(process.env.EZA_SPECIAL_KV || "");

  if (themeColor) {
    const cwdBase = path.basename(process.cwd());
    const cwdAbs = realpathSafe(process.cwd());

    if (!pairs.some((p) => p.startsWith(`${cwdBase}=`))) {
      pairs.push(`${cwdBase}=${themeColor}`);
    }
    if (!pairs.some((p) => p.startsWith(`${cwdAbs}=`))) {
      pairs.push(`${cwdAbs}=${themeColor}`);
    }
  }

  let ezaColors = process.env.EZA_COLORS || "";
  if (pairs.length) {
    const joined = pairs.join(":");
    ezaColors = ezaColors ? `${ezaColors}:${joined}` : joined;
  }

  let wantIcons = false;
  const filteredArgs = [];
  for (const arg of args) {
    if (arg === "--special-icons") wantIcons = true;
    else filteredArgs.push(arg);
  }

  let iconsKv = process.env.EZA_SPECIAL_ICONS_KV || "";
  if (wantIcons && themeColorIcon) {
    const lines = parseSpecialKv(iconsKv);
    const cwdBase = path.basename(process.cwd());
    const cwdAbs = realpathSafe(process.cwd());

    if (!lines.some((p) => p.startsWith(`${cwdBase}=`))) {
      lines.push(`${cwdBase}=${themeColorIcon}`);
    }
    if (!lines.some((p) => p.startsWith(`${cwdAbs}=`))) {
      lines.push(`${cwdAbs}=${themeColorIcon}`);
    }
    iconsKv = lines.join("\n");
  }

  const env = { ...process.env };
  if (ezaColors) env.EZA_COLORS = ezaColors;
  if (iconsKv) env.EZA_SPECIAL_ICONS_KV = iconsKv;

  const result = spawnSync(
    "eza",
    wantIcons
      ? ["--oneline", "--icons", "--color=always", ...filteredArgs]
      : ["--icons", ...filteredArgs],
    {
      env,
      encoding: "utf8",
      stdio: wantIcons ? ["inherit", "pipe", "inherit"] : "inherit",
    }
  );

  if (!wantIcons) {
    return result.status || 0;
  }

  const ansi = /\x1b\[[0-9;]*m/g;
  const icons = {};
  for (const line of iconsKv.split(/\r?\n/)) {
    if (!line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    icons[k] = rest.join("=");
  }

  const lines = (result.stdout || "").split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine) continue;
    const plain = rawLine.replace(ansi, "").trim();
    if (!plain) {
      process.stdout.write(rawLine + "\n");
      continue;
    }

    const parts = plain.split(/\s+/, 2);
    const name = parts.length > 1 ? parts[1] : parts[0];

    let prefix = "";
    for (const [pattern, icon] of Object.entries(icons)) {
      if (name === pattern) {
        prefix = icon + " ";
        break;
      }
    }

    process.stdout.write(prefix + rawLine + "\n");
  }

  return result.status || 0;
}

async function main() {
  if (!STATE.THEME_COLOR) {
    applyThemeVars(STATE.THEME_COLOR || STATE.COLOR_VAR || rHex());
  }

  loadThemefile();

  const [, , command, ...args] = process.argv;

  switch (command) {
    case "themefile":
    case "theme-file":
      console.log(THEMEFILE(args[0]));
      return;
    case "rhex":
      console.log(rHex());
      return;
    case "is-hex":
      process.exit(isHex(args[0]) ? 0 : 1);
      return;
    case "normalize-hex":
      console.log(normalizeHex(args[0]));
      return;
    case "pc":
    case "prompt-color":
      process.exit(await promptColor(args[0]));
      return;
    case "ns":
    case "namespace":
      setNamespace(args.join(" "));
      return;
    case "theme":
      process.exit(await THEME(args));
      return;
    case "theme-roll":
    case "roll":
      process.exit(await THEME_ROLL());
      return;
    case "set-theme":
      process.exit(await SET_THEME(args[0], args[1]));
      return;
    case "theme-init":
      process.exit(await THEME_INIT(args[0], args[1], args));
      return;
    case "theme-edit":
      process.exit(THEMEEDIT());
      return;
    case "seza":
      process.exit(seza(args));
      return;
    case "print-state":
      console.log(JSON.stringify(STATE, null, 2));
      return;
    default:
      console.log(`Usage:
  themefile.js theme [color] [namespace...]
  themefile.js theme set [file|color] [namespace]
  themefile.js theme roll
  themefile.js theme init [color] [namespace]
  themefile.js theme edit
  themefile.js themefile [dir]
  themefile.js rhex
  themefile.js normalize-hex <hex>
  themefile.js seza [args...]

Examples:
  themefile.js theme #55AAFF my namespace
  themefile.js theme roll
  themefile.js set-theme #33CC99 project-x
`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
