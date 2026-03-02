#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const readline = require("readline");

const ANSI = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

const state = {
  THEME_COLOR: process.env.THEME_COLOR || process.env.COLOR_VAR || "",
  COLOR_VAR: process.env.COLOR_VAR || "",
  FG_VAR: process.env.FG_VAR || "",
  BG_VAR: process.env.BG_VAR || "",
  FG_THEME_TEXT: process.env.FG_THEME_TEXT || "",
  NAMESPACE:
    process.env.NAMESPACE ||
    process.env.SESSION_NAME ||
    defaultNamespace(process.cwd()),
};

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function themefile(dir = process.cwd()) {
  return path.join(realpathSafe(dir), ".themefile");
}

function randomHex() {
  const n = () => Math.floor(Math.random() * 156) + 50;
  const [r, g, b] = [n(), n(), n()];
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
      .join("")
  );
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
      .map((x) => x + x)
      .join("");
  }
  return "#" + c.toUpperCase();
}

function applyThemeVars(input) {
  const c = normalizeHex(input);
  const hex = c.slice(1);

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  const brightness = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
  const threshold = 0x88;

  state.THEME_COLOR = c;
  state.COLOR_VAR = c;
  state.FG_VAR = `%F{${c}}`;
  state.BG_VAR = `%K{${c}}`;
  state.FG_THEME_TEXT = brightness > threshold ? "%F{#000000}" : "%F{#FFFFFF}";
}

function setNamespace(ns) {
  state.NAMESPACE = String(ns ?? "");
}

function defaultNamespace(cwd) {
  const parent = realpathSafe(path.resolve(cwd, ".."));
  return `${path.basename(parent)}/${path.basename(cwd)}`;
}

function readThemefileLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

function loadThemefile(dir = process.cwd()) {
  const file = themefile(dir);
  if (!fs.existsSync(file)) return;

  for (const rawLine of readThemefileLines(file)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const idx = line.indexOf("=");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case "THEME_COLOR":
        if (isHex(value)) applyThemeVars(value);
        break;
      case "NAMESPACE":
        setNamespace(value);
        break;
    }
  }
}

function saveThemefile(dir = process.cwd()) {
  const file = themefile(dir);
  const extras = [];

  if (fs.existsSync(file)) {
    for (const line of readThemefileLines(file)) {
      if (
        !line.trim() ||
        line.startsWith("THEME_COLOR=") ||
        line.startsWith("NAMESPACE=")
      ) {
        continue;
      }
      extras.push(line);
    }
  }

  const out = [
    `THEME_COLOR="${state.THEME_COLOR}"`,
    `NAMESPACE="${state.NAMESPACE}"`,
    ...extras,
    "",
  ].join("\n");

  fs.writeFileSync(file, out, "utf8");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function printExports() {
  const vars = {
    THEME_COLOR: state.THEME_COLOR,
    COLOR_VAR: state.COLOR_VAR,
    FG_VAR: state.FG_VAR,
    BG_VAR: state.BG_VAR,
    FG_THEME_TEXT: state.FG_THEME_TEXT,
    NAMESPACE: state.NAMESPACE,
  };

  for (const [key, value] of Object.entries(vars)) {
    process.stdout.write(`export ${key}=${shellQuote(value)}\n`);
  }
}

function shellSplit(str) {
  if (!str) return [];
  const out = [];
  let cur = "";
  let quote = null;
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
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
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

function listNearbyItems(maxItems = Number(process.env.THEME_AI_MAX_ITEMS || 8)) {
  try {
    return fs.readdirSync(process.cwd()).slice(0, maxItems).join(" ");
  } catch {
    return "";
  }
}

async function requestThemeHttp({ prompt, basename, namespace, dirPath, items, timeout }) {
  const url = process.env.THEME_AI_HTTP_URL;
  if (!url) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeout) * 1000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        basename,
        namespace,
        path: dirPath,
        items,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    const match = text.match(/#[0-9A-Fa-f]{6}/);
    return match ? match[0] : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function themeAiColor() {
  const dirBase = path.basename(process.cwd());
  const dirAbs = realpathSafe(process.cwd());
  const ns = state.NAMESPACE || dirBase;
  const items = listNearbyItems();
  const timeout = Number(process.env.THEME_AI_TIMEOUT || 4);

  const prompt =
    `Return one hex color (#RRGGBB) that fits the vibe of directory '${dirBase}' ` +
    `(namespace '${ns}') at path '${dirAbs}'. Nearby items: ${items}. ` +
    `Respond with only the color.`;

  if (process.env.THEME_AI_CMD) {
    const aiCmd = shellSplit(process.env.THEME_AI_CMD);
    if (aiCmd.length > 0) {
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

  return await requestThemeHttp({
    prompt,
    basename: dirBase,
    namespace: ns,
    dirPath: dirAbs,
    items,
    timeout,
  });
}

function printColor(text, color) {
  console.log(`${ANSI[color]}${text}${ANSI.reset}`);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptColor(input = "") {
  let value = input;

  for (;;) {
    if (!value) {
      value = await ask("Insert Hex (#RRGGBB): ");
    }

    if (!isHex(value)) {
      printColor("Invalid hex color.", "yellow");
      value = "";
      continue;
    }

    applyThemeVars(value);
    return 0;
  }
}

async function confirm(question) {
  const answer = (await ask(question)).trim();
  return /^(y|yes)$/i.test(answer);
}

async function setTheme(arg1 = "", arg2 = "") {
  if (arg1 && fs.existsSync(arg1) && fs.statSync(arg1).isFile()) {
    const file = arg1;
    const dir = path.dirname(file);

    setNamespace(path.basename(dir));

    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const idx = rawLine.indexOf("=");
      if (idx === -1) continue;

      const key = rawLine.slice(0, idx).trim();
      let value = rawLine.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      switch (key) {
        case "THEME_COLOR":
          if (isHex(value)) applyThemeVars(value);
          break;
        case "NAMESPACE":
          setNamespace(value);
          break;
      }
    }

    saveThemefile();
    printColor(`Loaded theme from ${file}`, "green");
    return 0;
  }

  const color = arg1 || state.THEME_COLOR || state.COLOR_VAR;
  const ns = arg2 || state.NAMESPACE || path.basename(process.cwd());

  if (!arg1 && !arg2) {
    const ok = await confirm(`Use color ${color} and namespace "${ns}"? (y/N) `);
    if (!ok) {
      console.log("Aborted.");
      return 1;
    }
  }

  if (!isHex(color)) {
    printColor("Invalid color. Use #RRGGBB.", "red");
    return 1;
  }

  applyThemeVars(color);
  setNamespace(ns);
  saveThemefile();
  printColor("Saved theme to .themefile.", "green");
  return 0;
}

async function themeInit(colorArg = "", nsArg = "", rawArgs = []) {
  let color = colorArg || state.THEME_COLOR || state.COLOR_VAR;
  let ns = nsArg || state.NAMESPACE;

  console.log(`\nReceived:\n\nargv : Array(${rawArgs.length})\n`);
  rawArgs.forEach((arg, i) => console.log(`argv[${i}]: ${arg}`));

  if (!colorArg) {
    const replyColor = await ask(`Theme color [${color}]: `);
    if (replyColor) color = replyColor;
  }

  if (!nsArg) {
    const replyNs = await ask(`Namespace [${ns}]: `);
    if (replyNs) ns = replyNs;
  }

  if (!isHex(color)) {
    console.log(`is_hex returned.. "${isHex(color)}"`);
    printColor("Invalid color. Use #RRGGBB.", "red");
    return 1;
  }

  applyThemeVars(color);
  setNamespace(ns);
  saveThemefile();
  printColor("Wrote theme to .themefile in this directory.", "green");
  return 0;
}

async function themeRoll() {
  let current = "";
  if (state.THEME_COLOR || state.COLOR_VAR) {
    current = normalizeHex(state.THEME_COLOR || state.COLOR_VAR);
  }

  let next = "";
  let usedAi = false;

  const ai = await themeAiColor();
  if (ai) {
    console.log(ai);
    if (isHex(ai)) {
      next = normalizeHex(ai);
      usedAi = true;
    }
  }

  if (!next) {
    let attempts = 0;
    const maxAttempts = 12;

    while (attempts < maxAttempts) {
      next = randomHex();
      if (!current || normalizeHex(next) !== current) break;
      attempts++;
    }
  }

  if (current && normalizeHex(next) === current) {
    const flipped = (parseInt(current.slice(1), 16) ^ 0x202020) & 0xffffff;
    next = "#" + flipped.toString(16).padStart(6, "0").toUpperCase();
    usedAi = false;
  }

  applyThemeVars(next);
  saveThemefile();

  if (usedAi) {
    printColor("Applied AI-suggested theme and saved to .themefile.", "green");
  } else {
    printColor("Applied random theme and saved to .themefile.", "green");
  }

  return 0;
}

function themeEdit() {
  const file = themefile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");

  const editor = process.env.EDITOR || "vi";
  const result = spawnSync(editor, [file], { stdio: "inherit" });

  loadThemefile();
  return result.status ?? 0;
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

function buildEzaColors() {
  const pairs = parseSpecialKv(process.env.EZA_SPECIAL_KV || "");
  const themeColor = state.THEME_COLOR || state.COLOR_VAR || "";

  const cwdBase = path.basename(process.cwd());
  const cwdAbs = realpathSafe(process.cwd());

  if (themeColor) {
    if (!pairs.some((p) => p.startsWith(`${cwdBase}=`))) {
      pairs.push(`${cwdBase}=${themeColor}`);
    }
    if (!pairs.some((p) => p.startsWith(`${cwdAbs}=`))) {
      pairs.push(`${cwdAbs}=${themeColor}`);
    }
  }

  const existing = process.env.EZA_COLORS || "";
  const joined = pairs.join(":");

  if (!joined) return existing;
  return existing ? `${existing}:${joined}` : joined;
}

function buildSpecialIconsKv() {
  const icon =
    process.env.SEZA_ICON ||
    process.env.SEZA_NAMESPACE_ICON ||
    state.NAMESPACE ||
    "";

  if (!icon) return process.env.EZA_SPECIAL_ICONS_KV || "";

  const cwdBase = path.basename(process.cwd());
  const cwdAbs = realpathSafe(process.cwd());
  const lines = parseSpecialKv(process.env.EZA_SPECIAL_ICONS_KV || "");

  if (!lines.some((p) => p.startsWith(`${cwdBase}=`))) {
    lines.push(`${cwdBase}=${icon}`);
  }
  if (!lines.some((p) => p.startsWith(`${cwdAbs}=`))) {
    lines.push(`${cwdAbs}=${icon}`);
  }

  return lines.join("\n");
}

function matchesPattern(name, pattern) {
  if (pattern === name) return true;

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(name);
}

function seza(args) {
  loadThemefile();

  try {
    spawnSync("eza", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("seza: eza is not installed");
    return 127;
  }

  const wantSpecialIcons = args.includes("--special-icons");
  const cleanArgs = args.filter((a) => a !== "--special-icons");

  const env = {
    ...process.env,
    EZA_COLORS: buildEzaColors(),
  };

  if (!wantSpecialIcons) {
    const result = spawnSync("eza", ["--icons", ...cleanArgs], {
      stdio: "inherit",
      env,
    });
    return result.status ?? 0;
  }

  env.EZA_SPECIAL_ICONS_KV = buildSpecialIconsKv();

  const result = spawnSync(
    "eza",
    ["--oneline", "--icons", "--color=always", ...cleanArgs],
    {
      encoding: "utf8",
      env,
      stdio: ["inherit", "pipe", "inherit"],
    },
  );

  const ansiRE = /\x1b\[[0-9;]*m/g;
  const iconMap = {};

  for (const line of (env.EZA_SPECIAL_ICONS_KV || "").split(/\r?\n/)) {
    if (!line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    iconMap[key] = value;
  }

  for (const rawLine of (result.stdout || "").split(/\r?\n/)) {
    if (!rawLine) continue;

    const plain = rawLine.replace(ansiRE, "").trim();
    if (!plain) {
      process.stdout.write(rawLine + "\n");
      continue;
    }

    const parts = plain.split(/\s+/, 2);
    const name = parts[1] || parts[0];

    let prefix = "";
    for (const [pattern, icon] of Object.entries(iconMap)) {
      if (matchesPattern(name, pattern)) {
        prefix = `${icon} `;
        break;
      }
    }

    process.stdout.write(prefix + rawLine + "\n");
  }

  return result.status ?? 0;
}

async function themeCommand(args) {
  const [sub, ...rest] = args;

  switch (sub) {
    case "set":
      return setTheme(rest[0], rest[1]);
    case "roll":
    case "random":
      return themeRoll();
    case "init":
      return themeInit(rest[0], rest[1], rest);
    case "edit":
      return themeEdit();
    default: {
      const color = args[0] || "";
      const ns = args.slice(1).join(" ");
      const rc = await promptColor(color);
      if (rc !== 0) return rc;
      setNamespace(ns);
      saveThemefile();
      printColor("Use at your own risk.", "yellow");
      return 0;
    }
  }
}

function usage() {
  console.log(`Usage:
  theme.js theme [color] [namespace...]
  theme.js theme set [file|color] [namespace]
  theme.js theme roll
  theme.js theme init [color] [namespace]
  theme.js theme edit
  theme.js export
  theme.js themefile [dir]
  theme.js normalize-hex <hex>
  theme.js rhex
  theme.js seza [args...]

Examples:
  theme.js theme '#55AAFF' my namespace
  theme.js theme roll
  eval "$(node theme.js export)"
`);
}

async function main() {
  if (!state.THEME_COLOR) {
    applyThemeVars(randomHex());
  }

  loadThemefile();

  const [, , command, ...args] = process.argv;

  switch (command) {
    case "themefile":
    case "theme-file":
      console.log(themefile(args[0]));
      return 0;

    case "rhex":
      console.log(randomHex());
      return 0;

    case "normalize-hex":
      console.log(normalizeHex(args[0]));
      return 0;

    case "is-hex":
      return isHex(args[0]) ? 0 : 1;

    case "export":
      printExports();
      return 0;

    case "namespace":
    case "ns":
      setNamespace(args.join(" "));
      return 0;

    case "theme":
      return await themeCommand(args);

    case "set-theme":
      return await setTheme(args[0], args[1]);

    case "theme-init":
      return await themeInit(args[0], args[1], args);

    case "theme-edit":
      return themeEdit();

    case "theme-roll":
    case "roll":
      return await themeRoll();

    case "seza":
      return seza(args);

    case "print-state":
      console.log(JSON.stringify(state, null, 2));
      return 0;

    default:
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
