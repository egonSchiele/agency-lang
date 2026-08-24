# Style Tag Parser

## Overview

`lib/styleParser.ts` parses inline style tags in text content. The syntax is `{bold}text{/bold}`, `{red-fg}text{/red-fg}`, `{blue-bg}text{/blue-bg}`. Tags can be nested.

The parser produces an array of `StyledSpan` objects: `{ text, fg?, bg?, bold? }`.

## How It Works

The parser uses a regex to find tag boundaries, maintaining a style stack:

1. Walk the input string, matching `{tag}` and `{/tag}` patterns
2. Text between tags becomes a `StyledSpan` with the current accumulated style
3. Opening tags (`{bold}`, `{red-fg}`, `{blue-bg}`) push onto the style stack
4. Closing tags (`{/bold}`, `{/red-fg}`, `{/blue-bg}`) pop the matching entry from the stack
5. Unrecognized tags (not `bold`, `*-fg`, or `*-bg`) are preserved as literal text

## Closing Tag Matching

Closing tags match by both type AND value. `{/red-fg}` only pops a `{ type: "fg", color: "red" }` entry, not a `{ type: "fg", color: "green" }`. This is important for nested colors like `{red-fg}{green-fg}x{/green-fg}y{/red-fg}`.

## Escaping

`escapeStyleTags(text)` escapes `{` and `}` with backslashes: `{bold}` becomes `\{bold\}`.

The regex uses a negative lookbehind `(?<!\\)` to skip escaped braces. The `makeSpan` function unescapes `\{` and `\}` in the output text.

## Regex Safety

The regex `TAG_PATTERN` is defined at module level but a new `RegExp` instance is created per `parseStyledText()` call. This prevents `lastIndex` corruption if the function is called reentrantly (e.g., from parallel renders). The pattern `[^}]+` is a negated character class that cannot catastrophically backtrack.

## Color System (`lib/colors.ts`)

Three lookup tables map named colors to output formats:
- `ansiColors` — foreground ANSI escape codes
- `ansiBgColors` — background ANSI escape codes
- `cssColors` — CSS hex color values

Supported colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, plus bright variants (`bright-red`, `bright-green`, etc.).

The HTML adapter only emits colors found via `hasOwnProperty` in `cssColors` to prevent CSS injection from user-controlled color names.
