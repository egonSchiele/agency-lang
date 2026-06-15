# Design: color schemes for `std::syntax` highlighting

Date: 2026-06-14
Status: Approved (pending spec review)

## Summary

Let callers pick a syntax-highlighting **color scheme** — by name (a curated set
of built-in themes ported from highlight.js) or as a custom token→color map.
Applies to `std::syntax::highlight` and to the syntax-highlighted mode of
`std::syntax::diff`. Today the theme is hardcoded to one VS Code Dark+ palette;
this exposes it as a parameter, defaulting to the current look.

## Motivation

`highlight`/`diff(language: …)` always render with one fixed palette. Different
terminals, user preferences, and accessibility needs (colorblind legibility,
light backgrounds) call for selectable schemes. The cli-highlight `Theme` is
just a map from highlight.js token classes to style functions, so this is a
matter of choosing which map to use — and offering well-known ones plus a
custom override.

## API

A `theme` parameter, added to both functions, typed `string | ColorScheme`,
defaulting to `"vscode-dark"`:

```ts
highlight(code, "ts", theme: "dracula")
highlight(code, "ts", theme: {
  keyword: { color: "#C586C0", styles: ["bold"] },
  comment: { color: "#6A9955", styles: ["italic"] },
  string:  { color: "green" }
})
diff(a, b, color: true, language: "ts", theme: "a11y-dark")
```

- **String** → a named built-in (see below). An unknown name **fails** (see
  [Failure behavior](#failure-behavior)).
- **`ColorScheme`** → a custom theme (a typed object, below), merged over
  `vscode-dark` so partial overrides work.
- On `diff`, the theme changes the **foreground** palette only; the red/green
  **background** tints that signal add/delete are unchanged.

`highlight`'s existing unused `mode` parameter is left untouched; `theme` is
added after it.

## Built-in themes (8)

Ported from highlight.js's CSS theme files into termcolors-based `Theme`
objects (the `.hljs-<class>` rules map 1:1 to the `Theme` token keys; `color:`
→ `color.hex(...)`, `font-weight: bold`/`font-style: italic` → `.bold`/`.italic`):

| name | kind |
|---|---|
| `vscode-dark` (default) | dark |
| `github-dark` | dark |
| `monokai` | dark |
| `dracula` | dark |
| `nord` | dark |
| `github` | light |
| `a11y-dark` | dark, accessible (WCAG contrast / colorblind-legible) |
| `a11y-light` | light, accessible |

Built-ins are full TS `Theme` objects, so they cover **all** highlight.js token
classes (including the hyphenated ones below).

## The `ColorScheme` type (custom themes)

A typed object with one **optional** field per highlight.js token class, so the
valid keys are discoverable and partial themes are natural. Each value is a
`TokenStyle` — a structured `{ color, styles? }`, with the styles as a typed
list rather than a magic string (mirroring how CSS/highlight.js themes keep
`color` separate from `font-weight`/`font-style`):

```ts
type Style = "bold" | "italic" | "underline" | "dim"

type TokenStyle = {
  color: string      # a hex ("#rgb" / "#rrggbb") or a termcolors named color ("red", "brightGreen")
  styles?: Style[]   # optional modifiers
}
```

Most highlight.js classes are identifier-safe and keep their name verbatim
(including `built_in`, whose underscore is a legal identifier). The 10 classes
with **hyphens** are exposed under **camelCase** field names and mapped back to
the real class at runtime — Agency object-type definitions reject
quoted/hyphenated keys (verified), so this is how those classes are made
customizable:

| `ColorScheme` field | highlight.js class |
|---|---|
| `metaKeyword` | `meta-keyword` |
| `metaString` | `meta-string` |
| `builtinName` | `builtin-name` |
| `selectorTag` | `selector-tag` |
| `selectorId` | `selector-id` |
| `selectorClass` | `selector-class` |
| `selectorAttr` | `selector-attr` |
| `selectorPseudo` | `selector-pseudo` |
| `templateTag` | `template-tag` |
| `templateVariable` | `template-variable` |

All other fields use the class name verbatim: `keyword`, `built_in`, `type`,
`literal`, `number`, `regexp`, `string`, `subst`, `symbol`, `class`, `function`, `title`,
`params`, `comment`, `doctag`, `meta`, `section`, `tag`, `name`, `attr`,
`attribute`, `variable`, `bullet`, `code`, `emphasis`, `strong`, `formula`,
`link`, `quote`, `addition`, `deletion`, `default`.

> Implementation note: confirm `class` and `default` parse as Agency
> object-type field names. If either is reserved, give it a camelCase alias
> in the same field→class table (e.g. `classDecl` → `class`) rather than
> dropping it.

### Building a `TokenStyle` into a style function

For each provided token, the runtime builds a termcolors function from the
`TokenStyle`: start from `color`, chain each `Style` in `styles`
(`bold`→`.bold`, `italic`→`.italic`, `underline`→`.underline`, `dim`→`.dim`),
then apply the `color` (`.hex(value)` when it starts with `#`, otherwise a
named color validated against termcolors' palette, e.g. `red`/`brightGreen`).
`Style` is a closed union, so invalid styles are a compile-time error.

## Failure behavior

Bad theme input is a hard error, not a silent fallback:

- An **unknown scheme name** (`theme: "blah"`) throws.
- An **invalid color** in a custom scheme — a malformed hex or an unknown color
  name — throws (naming the bad value and its token).

`highlight` and `diff` keep their `string` return type. They do **not** change
to `Result`: in Agency every function body is wrapped in an automatic
try-catch, so a throw becomes a propagating `failure` with the error message —
the caller sees a failure without every call site having to unwrap a `Result`.
A bad theme argument is a programmer error, so failing loudly (rather than
rendering with a wrong/blank palette) is the desired behavior. Callers that
pass a valid scheme (or the default) are unaffected and get a `string`.

## Architecture

- **New** `lib/stdlib/syntax-themes.ts`: holds the 8 built-in `Theme` objects
  (the current `vscodeDarkTheme` moves here), a `BUILTINS: Record<string,
  Theme>` registry, the camelCase-field→hljs-class table, the
  `TokenStyle`→style-fn builder (which **throws** on an invalid color), and
  `resolveTheme(theme: string | Record<string, TokenStyle>): Theme`:
  - empty/undefined → `vscode-dark`.
  - string → `BUILTINS[name]`, else **throw** `Unknown color scheme "<name>"`.
  - object → clone `vscode-dark`, then for each field map name→class and
    override with a style fn built from its `TokenStyle`; an invalid color
    **throws** `Invalid color "<value>" for token "<field>"`.
  Keeping the (now multi-theme) palette data and resolution here keeps
  `syntax.ts` focused on highlighting.
- **`lib/stdlib/syntax.ts`**: `syntaxHighlight(code, language, theme?)` gains the
  param. It resolves the theme **outside** the highlight try-catch, so a bad
  theme propagates as a failure while a genuine highlight error still falls back
  to plain code. To avoid re-resolving per line, `_diff` resolves the theme once
  (only when `language` is set) and threads the resolved `Theme` into `diffBody`
  via a small internal `highlightWithTheme(code, language, resolvedTheme)`;
  `syntaxHighlight` is `highlightWithTheme(code, language, resolveTheme(theme))`.
- **`stdlib/syntax.agency`**: define `ColorScheme`; add `theme: string |
  ColorScheme = "vscode-dark"` to `highlight` and `diff`; pass through to the TS
  shims. Update the `highlight` docstring with a named example and a custom
  example (it becomes the generated stdlib doc and the LLM tool description).

## Testing

TS unit tests (`lib/stdlib/syntax-themes.test.ts` + `syntax.test.ts`):

- `resolveTheme("monokai")` ≠ `resolveTheme("vscode-dark")` for the same code
  (different fg codes); empty/undefined → vscode-dark.
- An **unknown scheme name throws**; an **invalid custom color throws** (and the
  message names the value/token).
- A custom `ColorScheme` overrides the targeted token's color and inherits the
  rest from `vscode-dark`; a camelCase field (e.g. `selectorTag`) maps to the
  hyphenated class.
- `TokenStyle` builder: hex color, named color, and one/multiple `styles`.
- Each of the 8 built-ins resolves to a `Theme` and produces ANSI.

End-to-end Agency-js test: `diff(..., language: "ts", theme: "monokai")` changes
foreground codes vs the default while keeping the red/green backgrounds; a
custom `ColorScheme` is accepted; **an unknown scheme name makes the
`highlight`/`diff` call return a `failure`** (verifying the throw→failure path
end-to-end).

## Out of scope

- ANSI-16 / terminal-palette-adaptive themes (built-ins are truecolor hex; the
  light themes cover light terminals).
- Runtime conversion of arbitrary highlight.js CSS files/URLs (the custom
  `ColorScheme` covers bespoke needs).
- Basing a custom theme on a non-default named theme (custom always merges over
  `vscode-dark`).
