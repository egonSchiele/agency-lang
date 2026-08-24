# Style Tag Parser

## Overview

`lib/tui/styleParser.ts` parses inline style tags in text content. The syntax is `{bold}text{/bold}`, `{red-fg}text{/red-fg}`, `{blue-bg}text{/blue-bg}`. Tags can be nested.

The parser produces an array of `StyledSpan` objects: `{ text, fg?, bg?, bold? }`. A color is either a palette name such as `red` or `bright-cyan`, or a hex string such as `#0af` or `#00aaff`.

## How It Works

The parser uses a regex to find tag boundaries, maintaining a style stack:

1. Walk the input string, matching `{tag}` and `{/tag}` patterns
2. Text between tags becomes a `StyledSpan` with the current accumulated style
3. Opening tags (`{bold}`, `{red-fg}`, `{blue-bg}`) push onto the style stack
4. Closing tags (`{/bold}`, `{/red-fg}`, `{/blue-bg}`) pop the matching entry from the stack
5. Unrecognized tags (not `bold`, `*-fg`, or `*-bg`) are preserved as literal text

## ANSI and OSC escapes

The same regex also matches ANSI SGR sequences (`ESC[<params>m`) and OSC sequences (`ESC] … BEL` or `ESC] … ST`), because styled text often arrives already carrying terminal escapes.

`applyAnsiCodes` folds SGR codes into the same style stack. Every stack entry records an `origin` of `"tag"` or `"ansi"`. ANSI codes only touch ANSI-origin entries, so a reset (`0`), a bold-off (`22`), or a default-color code (`39`, `49`) never clobbers a style that came from `{tag}` syntax. `ESC[m` with no parameters counts as a reset. The parser understands the standard 30-37/40-47 colors, their bright variants at 90-97/100-107, and the extended `38;5;N`, `38;2;R;G;B`, `48;5;N`, and `48;2;R;G;B` forms, which `xterm256ToHex` and `rgbToHex` turn into hex colors. Malformed or unknown codes are ignored.

OSC sequences are consumed and dropped. They carry no styling and occupy no columns. OSC 8 is the terminal hyperlink wrapper, and without this handling its URL was emitted as literal cells, so a link in rendered Markdown printed its own href across the screen.

## Closing Tag Matching

Closing tags match by both type AND value, and only against tag-origin entries. `{/red-fg}` only pops a `{ type: "fg", color: "red" }` entry, not a `{ type: "fg", color: "green" }`. This is important for nested colors like `{red-fg}{green-fg}x{/green-fg}y{/red-fg}`.

## Escaping

`escapeStyleTags(text)` escapes `{` and `}` with backslashes: `{bold}` becomes `\{bold\}`.

The regex uses a negative lookbehind `(?<!\\)` to skip escaped braces. The `makeSpan` function unescapes `\{` and `\}` in the output text. A tag body may not contain `}` at all, so an escaped `}` inside a tag body is unsupported by design.

## Regex Safety

`TAG_PATTERN_SOURCE` is defined at module level, but `parseStyledText()` builds a new `RegExp` on every call. This prevents `lastIndex` corruption if the function is called reentrantly, for example from parallel renders. The pattern `[^}]+` is a negated character class that cannot catastrophically backtrack.

## Color System (`lib/tui/colors.ts`)

`COLOR_NAMES` is the full palette. Three lookup tables map those names to output formats, and a unit test keeps all four in lock-step:
- `ansiColors` — foreground ANSI escape codes
- `ansiBgColors` — background ANSI escape codes
- `cssColors` — CSS hex color values

Supported colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, plus bright variants (`bright-red`, `bright-green`, etc.).

The HTML adapter (`lib/tui/render/html.ts`) emits a CSS color only when it is a `hasOwnProperty` hit in `cssColors` or a literal hex string matching `HEX_COLOR_RE`. Anything else is dropped silently, which is what prevents CSS injection from user-controlled color names.
