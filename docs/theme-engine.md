# Theme Engine (from .zshrc)

The theme system lives in `.zshrc` and uses a per-directory `.themefile`.

## Core commands
- `THEME <#RRGGBB> [namespace…]`: set color + namespace and save to `.themefile` in the current directory.
- `THEMEEDIT`: open/create `.themefile` in `$EDITOR`, then reload it.
- `THEMEFILE`: prints the path of the `.themefile` for the current directory.

## New helpers
- `THEME_ROLL`: apply a random color for this session only (does **not** save).
- `THEME_INIT [#RRGGBB] [namespace]`: create/write `.themefile` in the current directory. If args are omitted, it prompts with defaults pulled from the current theme.
- `SET_THEME /path/to/.themefile`: load a specific `.themefile`, set namespace to that directory (unless the file defines its own), and save it as the current theme. Tab-completion offers `*.themefile`.

## Behavior
- A `.themefile` in the current directory is auto-loaded on `chpwd` (see `autoThemeFile` in `bin.zsh`).
- Defaults use a random color and `NAMESPACE=${SESSION_NAME:-<cwd>}` if no `.themefile` exists.

## Tips
- To reset, delete the `.themefile` in your directory; a new color will be generated on next load.
- To keep a session-only color tweak, use `THEME_ROLL` so nothing is persisted.
