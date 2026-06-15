# Syntax color schemes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `std::syntax::highlight` and `std::syntax::diff` choose a color scheme — one of 8 named built-in themes or a custom `ColorScheme` map — defaulting to today's `vscode-dark`.

**Architecture:** A new `lib/stdlib/syntax-themes.ts` owns all palette data: it holds the 8 built-in cli-highlight `Theme` objects (the existing `vscodeDarkTheme` plus 7 ported from highlight.js v10 CSS via compact `ThemeData` records + a `buildBuiltin` filler), the camelCase-field→hljs-class table, a `buildStyleFn` builder (which throws on an invalid color), and `resolveTheme(theme)` (which throws on an unknown scheme). `syntax.ts` calls `resolveTheme` instead of using a hardcoded theme and threads the theme through `diffBody`/`_diff`. `stdlib/syntax.agency` adds `Style`/`TokenStyle`/`ColorScheme` types and a `theme` parameter on both tools.

**Tech Stack:** TypeScript, cli-highlight (highlight.js v10.7.3), `termcolors` (`color.hex`, named colors, `.bold/.italic/.underline/.dim`), vitest, Agency-js tests.

**Spec:** `docs/superpowers/specs/2026-06-14-syntax-color-schemes-design.md`

---

## Background the engineer needs

- **Build:** after changing TS or any `stdlib/*.agency`, run `make` from `packages/agency-lang/`. TS-only unit tests run with `pnpm test:run <path>` after `pnpm run build`. `stdlib/*.js` and `dist/**` are gitignored — never stage them.
- **cli-highlight `Theme`:** an object mapping highlight.js token classes (`keyword`, `string`, `comment`, the hyphenated `meta-keyword`/`selector-tag`/…, and `default`) to style functions `(text) => string`. Our highlighter is highlight.js **v10.7.3**, so themes are keyed by v10 class names. A class not present in the theme falls back to cli-highlight's own DEFAULT_THEME — so built-in themes are filled completely (every class gets at least the theme's base color).
- **termcolors:** `color.hex("#rrggbb")` (3- or 6-digit), named colors as chainable properties (`color.red`, `color.brightGreen`), and modifiers `color.bold` / `.italic` / `.underline` / `.dim`. Chaining composes: `color.bold.hex("#f92672")("x")` → `\x1b[1m\x1b[38;2;249;38;114mx\x1b[0m`. `color.hex` throws on a malformed hex; an unknown named-color property is `undefined`.
- **Agency object types** accept identifier keys (incl. `class`, `default`, `built_in` — verified) but **reject** quoted/hyphenated keys, which is why the 10 hyphenated hljs classes get camelCase field names in `ColorScheme`.
- **Agency-js tests:** `tests/agency-js/stdlib/<name>/` with `agent.agency`, `test.js`, `fixture.json`; run `pnpm run a test js tests/agency-js/stdlib/<name>`.
- **Git:** commit messages via file (`git commit -F`), end with the `Co-Authored-By` trailer, no amend/force-push. Work starts on a fresh branch off `main`.

---

## File Structure

- **Create** `lib/stdlib/syntax-themes.ts` — all theme data + `resolveTheme`.
- **Create** `lib/stdlib/syntax-themes.test.ts` — unit tests for resolution.
- **Modify** `lib/stdlib/syntax.ts` — move `vscodeDarkTheme` out; `syntaxHighlight`/`diffBody`/`_diff` take a `theme`.
- **Modify** `lib/stdlib/syntax.test.ts` — a themed-highlight assertion.
- **Modify** `stdlib/syntax.agency` — `Style`/`TokenStyle`/`ColorScheme` types; `theme` param on `highlight` and `diff`; docstring example.
- **Create** `tests/agency-js/stdlib/std-syntax-theme/{agent.agency,test.js,fixture.json}` — end-to-end.
- **Regenerated (don't hand-edit)** `docs/site/stdlib/syntax.md` — via `make`.

---

## Task 1: theme registry + `resolveTheme`

**Files:**
- Create: `lib/stdlib/syntax-themes.ts`
- Modify: `lib/stdlib/syntax.ts` (cut `vscodeDarkTheme` + palette consts)
- Create: `lib/stdlib/syntax-themes.test.ts`

- [ ] **Step 1: Move the palette + `vscodeDarkTheme` out of `syntax.ts`**

In `lib/stdlib/syntax.ts`, delete the palette consts (the `const blue = color.hex(...)` … `const magenta = …` block) and the entire `const vscodeDarkTheme = { … } as unknown as Theme;` block. Leave everything else. (They move into `syntax-themes.ts` in the next step; `syntax.ts` will import the registry in Task 2.)

- [ ] **Step 2: Create `lib/stdlib/syntax-themes.ts`**

```ts
import { color, colors } from "@/utils/termcolors.js";
import type { Theme } from "cli-highlight";

// Valid termcolors named colors (for validating custom-theme color names).
const NAMED_COLORS = new Set(Object.keys(colors));

type StyleFlags = { bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean };
type ColorSpec = StyleFlags & { color?: string };

// Internal compact representation of a built-in theme.
type ThemeData = { base: string; tokens: Record<string, ColorSpec> };

// VS Code Dark+ palette (moved from syntax.ts).
const blue = color.hex("#569CD6");
const yellow = color.hex("#DCDCAA");
const teal = color.hex("#4EC9B0");
const lightGreen = color.hex("#B5CEA8");
const red = color.hex("#D16969");
const orange = color.hex("#CE9178");
const lightBlue = color.hex("#9CDCFE");
const green = color.hex("#6A9955");
const darkGreen = color.hex("#608B4E");
const gold = color.hex("#D7BA7D");
const lightGray = color.hex("#D4D4D4");
const magenta = color.hex("#C586C0");

export const vscodeDarkTheme = {
  keyword: blue,
  built_in: yellow,
  type: teal,
  literal: blue,
  number: lightGreen,
  regexp: red,
  string: orange,
  subst: lightBlue,
  symbol: blue,
  class: teal,
  function: yellow,
  title: yellow,
  params: lightBlue,
  comment: green.italic,
  doctag: darkGreen,
  meta: blue,
  "meta-keyword": blue,
  "meta-string": orange,
  section: blue.bold,
  tag: blue,
  name: blue,
  "builtin-name": yellow,
  attr: lightBlue,
  attribute: lightBlue,
  variable: lightBlue,
  bullet: gold,
  code: lightGray,
  emphasis: color.italic,
  strong: color.bold,
  formula: magenta,
  link: blue.underline,
  quote: darkGreen,
  "selector-tag": gold,
  "selector-id": gold,
  "selector-class": gold,
  "selector-attr": gold,
  "selector-pseudo": gold,
  "template-tag": magenta,
  "template-variable": lightBlue,
  addition: lightGreen,
  deletion: orange,
  default: lightGray,
} as unknown as Theme;

// Every cli-highlight token class, so built-in themes can be filled completely
// (unthemed classes get the theme's base color instead of cli-highlight's
// fallback theme).
const TOKEN_CLASSES = [
  "keyword", "built_in", "type", "literal", "number", "regexp", "string", "subst",
  "symbol", "class", "function", "title", "params", "comment", "doctag", "meta",
  "meta-keyword", "meta-string", "section", "tag", "name", "builtin-name", "attr",
  "attribute", "variable", "bullet", "code", "emphasis", "strong", "formula", "link",
  "quote", "selector-tag", "selector-id", "selector-class", "selector-attr",
  "selector-pseudo", "template-tag", "template-variable", "addition", "deletion", "default",
] as const;

// camelCase ColorScheme field -> real hljs class (hyphenated classes only).
const FIELD_TO_CLASS: Record<string, string> = {
  metaKeyword: "meta-keyword",
  metaString: "meta-string",
  builtinName: "builtin-name",
  selectorTag: "selector-tag",
  selectorId: "selector-id",
  selectorClass: "selector-class",
  selectorAttr: "selector-attr",
  selectorPseudo: "selector-pseudo",
  templateTag: "template-tag",
  templateVariable: "template-variable",
};

function applyStyles(fn: any, s: StyleFlags): any {
  if (s.bold) fn = fn.bold;
  if (s.dim) fn = fn.dim;
  if (s.italic) fn = fn.italic;
  if (s.underline) fn = fn.underline;
  return fn;
}

// Build a termcolors style function from a ColorSpec. `color` is a hex
// ("#rgb"/"#rrggbb") or a termcolors named color. THROWS on a missing or
// invalid color (malformed hex / unknown name) — bad theme input is a hard
// error, surfaced as an Agency failure rather than a silent fallback.
function buildStyleFn(spec: ColorSpec): (s: string) => string {
  const value = spec.color;
  if (value === undefined) throw new Error("missing color");
  const styled = applyStyles(color, spec);
  if (value.startsWith("#")) {
    return styled.hex(value); // color.hex throws on a malformed hex
  }
  if (!NAMED_COLORS.has(value)) throw new Error(`unknown color name "${value}"`);
  return (styled as any)[value];
}

// Turn compact ThemeData into a complete cli-highlight Theme. Every class is
// filled (unthemed ones use the theme's base color), so there's no fallback to
// cli-highlight's own default theme. Built-in colors are all valid, so
// buildStyleFn never throws here.
function buildBuiltin(data: ThemeData): Theme {
  const out: Record<string, (s: string) => string> = {};
  for (const cls of TOKEN_CLASSES) {
    const spec = cls === "default" ? {} : data.tokens[cls] ?? {};
    out[cls] = buildStyleFn({ ...spec, color: spec.color ?? data.base });
  }
  return out as unknown as Theme;
}

// --- ported highlight.js v10 themes (from styles/*.css) ---

const monokai: ThemeData = {
  base: "#ddd",
  tokens: {
    tag: { color: "#f92672" },
    keyword: { color: "#f92672", bold: true },
    "selector-tag": { color: "#f92672", bold: true },
    literal: { color: "#f92672", bold: true },
    strong: { color: "#f92672" },
    name: { color: "#f92672" },
    code: { color: "#66d9ef" },
    attribute: { color: "#bf79db" },
    symbol: { color: "#bf79db" },
    regexp: { color: "#bf79db" },
    link: { color: "#bf79db" },
    string: { color: "#a6e22e" },
    bullet: { color: "#a6e22e" },
    subst: { color: "#a6e22e" },
    title: { color: "#a6e22e", bold: true },
    section: { color: "#a6e22e", bold: true },
    emphasis: { color: "#a6e22e" },
    type: { color: "#a6e22e", bold: true },
    built_in: { color: "#a6e22e" },
    "builtin-name": { color: "#a6e22e" },
    "selector-attr": { color: "#a6e22e" },
    "selector-pseudo": { color: "#a6e22e" },
    addition: { color: "#a6e22e" },
    variable: { color: "#a6e22e" },
    "template-tag": { color: "#a6e22e" },
    "template-variable": { color: "#a6e22e" },
    comment: { color: "#75715e" },
    quote: { color: "#75715e" },
    deletion: { color: "#75715e" },
    meta: { color: "#75715e" },
    doctag: { bold: true },
    "selector-id": { bold: true },
  },
};

const dracula: ThemeData = {
  base: "#f8f8f2",
  tokens: {
    keyword: { color: "#8be9fd", bold: true },
    "selector-tag": { color: "#8be9fd", bold: true },
    literal: { color: "#8be9fd", bold: true },
    section: { color: "#8be9fd", bold: true },
    link: { color: "#8be9fd" },
    subst: { color: "#f8f8f2" },
    string: { color: "#f1fa8c" },
    title: { color: "#f1fa8c", bold: true },
    name: { color: "#f1fa8c", bold: true },
    type: { color: "#f1fa8c", bold: true },
    attribute: { color: "#f1fa8c" },
    symbol: { color: "#f1fa8c" },
    bullet: { color: "#f1fa8c" },
    addition: { color: "#f1fa8c" },
    variable: { color: "#f1fa8c" },
    "template-tag": { color: "#f1fa8c" },
    "template-variable": { color: "#f1fa8c" },
    comment: { color: "#6272a4" },
    quote: { color: "#6272a4" },
    deletion: { color: "#6272a4" },
    meta: { color: "#6272a4" },
    doctag: { bold: true },
    strong: { bold: true },
    emphasis: { italic: true },
  },
};

const nord: ThemeData = {
  base: "#D8DEE9",
  tokens: {
    subst: { color: "#D8DEE9" },
    "selector-tag": { color: "#81A1C1" },
    "selector-id": { color: "#8FBCBB", bold: true },
    "selector-class": { color: "#8FBCBB" },
    "selector-attr": { color: "#8FBCBB" },
    "selector-pseudo": { color: "#88C0D0" },
    built_in: { color: "#8FBCBB" },
    type: { color: "#8FBCBB" },
    class: { color: "#8FBCBB" },
    function: { color: "#88C0D0" },
    keyword: { color: "#81A1C1" },
    literal: { color: "#81A1C1" },
    symbol: { color: "#81A1C1" },
    number: { color: "#B48EAD" },
    regexp: { color: "#EBCB8B" },
    string: { color: "#A3BE8C" },
    title: { color: "#8FBCBB" },
    params: { color: "#D8DEE9" },
    bullet: { color: "#81A1C1" },
    code: { color: "#8FBCBB" },
    emphasis: { italic: true },
    formula: { color: "#8FBCBB" },
    strong: { bold: true },
    quote: { color: "#4C566A" },
    comment: { color: "#4C566A" },
    doctag: { color: "#8FBCBB" },
    meta: { color: "#5E81AC" },
    "meta-keyword": { color: "#5E81AC" },
    "meta-string": { color: "#A3BE8C" },
    attr: { color: "#8FBCBB" },
    attribute: { color: "#D8DEE9" },
    "builtin-name": { color: "#81A1C1" },
    name: { color: "#81A1C1" },
    section: { color: "#88C0D0" },
    tag: { color: "#81A1C1" },
    variable: { color: "#D8DEE9" },
    "template-variable": { color: "#D8DEE9" },
    "template-tag": { color: "#5E81AC" },
  },
};

const github: ThemeData = {
  base: "#333",
  tokens: {
    comment: { color: "#998", italic: true },
    quote: { color: "#998", italic: true },
    keyword: { color: "#333", bold: true },
    "selector-tag": { color: "#333", bold: true },
    subst: { color: "#333", bold: true },
    number: { color: "#008080" },
    literal: { color: "#008080" },
    variable: { color: "#008080" },
    "template-variable": { color: "#008080" },
    string: { color: "#d14" },
    doctag: { color: "#d14" },
    title: { color: "#900", bold: true },
    section: { color: "#900", bold: true },
    "selector-id": { color: "#900", bold: true },
    type: { color: "#458", bold: true },
    tag: { color: "#000080" },
    name: { color: "#000080" },
    attribute: { color: "#000080" },
    regexp: { color: "#009926" },
    link: { color: "#009926" },
    symbol: { color: "#990073" },
    bullet: { color: "#990073" },
    built_in: { color: "#0086b3" },
    "builtin-name": { color: "#0086b3" },
    meta: { color: "#999", bold: true },
    emphasis: { italic: true },
    strong: { bold: true },
  },
};

const githubDark: ThemeData = {
  base: "#c9d1d9",
  tokens: {
    keyword: { color: "#ff7b72" },
    doctag: { color: "#ff7b72" },
    type: { color: "#ff7b72" },
    "template-tag": { color: "#ff7b72" },
    "template-variable": { color: "#ff7b72" },
    "meta-keyword": { color: "#ff7b72" },
    title: { color: "#d2a8ff" },
    function: { color: "#d2a8ff" },
    class: { color: "#d2a8ff" },
    attr: { color: "#79c0ff" },
    attribute: { color: "#79c0ff" },
    literal: { color: "#79c0ff" },
    meta: { color: "#79c0ff" },
    number: { color: "#79c0ff" },
    variable: { color: "#79c0ff" },
    "selector-attr": { color: "#79c0ff" },
    "selector-class": { color: "#79c0ff" },
    "selector-id": { color: "#79c0ff" },
    regexp: { color: "#a5d6ff" },
    string: { color: "#a5d6ff" },
    "meta-string": { color: "#a5d6ff" },
    built_in: { color: "#ffa657" },
    symbol: { color: "#ffa657" },
    comment: { color: "#8b949e" },
    code: { color: "#8b949e" },
    formula: { color: "#8b949e" },
    name: { color: "#7ee787" },
    quote: { color: "#7ee787" },
    "selector-tag": { color: "#7ee787" },
    "selector-pseudo": { color: "#7ee787" },
    section: { color: "#1f6feb" },
    bullet: { color: "#f2cc60" },
    addition: { color: "#aff5b4" },
    deletion: { color: "#ffdcd7" },
    emphasis: { italic: true },
    strong: { bold: true },
  },
};

const a11yDark: ThemeData = {
  base: "#f8f8f2",
  tokens: {
    comment: { color: "#d4d0ab" },
    quote: { color: "#d4d0ab" },
    variable: { color: "#ffa07a" },
    "template-variable": { color: "#ffa07a" },
    tag: { color: "#ffa07a" },
    name: { color: "#ffa07a" },
    "selector-id": { color: "#ffa07a" },
    "selector-class": { color: "#ffa07a" },
    regexp: { color: "#ffa07a" },
    deletion: { color: "#ffa07a" },
    number: { color: "#f5ab35" },
    built_in: { color: "#f5ab35" },
    "builtin-name": { color: "#f5ab35" },
    literal: { color: "#f5ab35" },
    type: { color: "#f5ab35" },
    params: { color: "#f5ab35" },
    meta: { color: "#f5ab35" },
    link: { color: "#f5ab35" },
    attribute: { color: "#ffd700" },
    string: { color: "#abe338" },
    symbol: { color: "#abe338" },
    bullet: { color: "#abe338" },
    addition: { color: "#abe338" },
    title: { color: "#00e0e0" },
    section: { color: "#00e0e0" },
    keyword: { color: "#dcc6e0", bold: true },
    "selector-tag": { color: "#dcc6e0", bold: true },
    emphasis: { italic: true },
    strong: { bold: true },
  },
};

const a11yLight: ThemeData = {
  base: "#545454",
  tokens: {
    comment: { color: "#696969" },
    quote: { color: "#696969" },
    variable: { color: "#d91e18" },
    "template-variable": { color: "#d91e18" },
    tag: { color: "#d91e18" },
    name: { color: "#d91e18" },
    "selector-id": { color: "#d91e18" },
    "selector-class": { color: "#d91e18" },
    regexp: { color: "#d91e18" },
    deletion: { color: "#d91e18" },
    number: { color: "#aa5d00" },
    built_in: { color: "#aa5d00" },
    "builtin-name": { color: "#aa5d00" },
    literal: { color: "#aa5d00" },
    type: { color: "#aa5d00" },
    params: { color: "#aa5d00" },
    meta: { color: "#aa5d00" },
    link: { color: "#aa5d00" },
    attribute: { color: "#aa5d00" },
    string: { color: "#008000" },
    symbol: { color: "#008000" },
    bullet: { color: "#008000" },
    addition: { color: "#008000" },
    title: { color: "#007faa" },
    section: { color: "#007faa" },
    keyword: { color: "#7928a1", bold: true },
    "selector-tag": { color: "#7928a1", bold: true },
    emphasis: { italic: true },
    strong: { bold: true },
  },
};

const BUILTINS: Record<string, Theme> = {
  "vscode-dark": vscodeDarkTheme,
  "github-dark": buildBuiltin(githubDark),
  monokai: buildBuiltin(monokai),
  dracula: buildBuiltin(dracula),
  nord: buildBuiltin(nord),
  github: buildBuiltin(github),
  "a11y-dark": buildBuiltin(a11yDark),
  "a11y-light": buildBuiltin(a11yLight),
};

// A custom theme as it arrives from Agency: camelCase field -> { color, styles? }.
type CustomScheme = Record<string, { color?: string; styles?: string[] }>;

/**
 * Resolve a theme argument to a cli-highlight Theme.
 * - empty/undefined -> vscode-dark
 * - string  -> a built-in; THROWS on an unknown name
 * - object  -> a custom ColorScheme, merged over vscode-dark; THROWS on an
 *   invalid color
 */
export function resolveTheme(theme?: string | CustomScheme): Theme {
  if (theme == null || theme === "") return BUILTINS["vscode-dark"];
  if (typeof theme === "string") {
    const t = BUILTINS[theme];
    if (!t) {
      throw new Error(`Unknown color scheme "${theme}". Available: ${Object.keys(BUILTINS).join(", ")}`);
    }
    return t;
  }
  const merged = { ...(BUILTINS["vscode-dark"] as Record<string, (s: string) => string>) };
  for (const [field, ts] of Object.entries(theme)) {
    const cls = FIELD_TO_CLASS[field] ?? field;
    const styles = ts.styles ?? [];
    try {
      merged[cls] = buildStyleFn({
        color: ts.color,
        bold: styles.includes("bold"),
        italic: styles.includes("italic"),
        underline: styles.includes("underline"),
        dim: styles.includes("dim"),
      });
    } catch {
      throw new Error(`Invalid color "${ts.color}" for token "${field}"`);
    }
  }
  return merged as unknown as Theme;
}
```

- [ ] **Step 3: Write unit tests**

Create `lib/stdlib/syntax-themes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveTheme, vscodeDarkTheme } from "./syntax-themes.js";

// Apply a theme's token style fn and return the raw ANSI for inspection.
const fg = (theme: any, token: string) => theme[token]("x");

describe("resolveTheme", () => {
  it("named built-ins differ from vscode-dark for the same token", () => {
    // monokai keyword is #f92672 (249,38,114) + bold; vscode-dark keyword is #569CD6 (86,156,214)
    expect(fg(resolveTheme("monokai"), "keyword")).toContain("38;2;249;38;114");
    expect(fg(resolveTheme("monokai"), "keyword")).toContain("\x1b[1m"); // bold
    expect(fg(resolveTheme("vscode-dark"), "keyword")).toContain("38;2;86;156;214");
  });

  it("resolves all 8 built-ins to a usable theme", () => {
    for (const name of ["vscode-dark", "github-dark", "monokai", "dracula", "nord", "github", "a11y-dark", "a11y-light"]) {
      expect(typeof (resolveTheme(name) as any).keyword).toBe("function");
    }
  });

  it("empty/undefined resolves to vscode-dark", () => {
    expect(resolveTheme(undefined)).toBe(vscodeDarkTheme);
    expect(resolveTheme("")).toBe(vscodeDarkTheme);
  });

  it("throws on an unknown scheme name", () => {
    expect(() => resolveTheme("not-a-theme")).toThrow(/Unknown color scheme/);
  });

  it("a custom ColorScheme overrides the targeted token and inherits the rest", () => {
    const t = resolveTheme({ keyword: { color: "#ff0000", styles: ["bold"] } });
    expect(fg(t, "keyword")).toContain("38;2;255;0;0");
    expect(fg(t, "keyword")).toContain("\x1b[1m");
    // string inherits vscode-dark (#CE9178 = 206,145,120)
    expect(fg(t, "string")).toContain("38;2;206;145;120");
  });

  it("maps a camelCase field to its hyphenated class", () => {
    const t = resolveTheme({ selectorTag: { color: "#00ff00" } });
    expect(fg(t, "selector-tag")).toContain("38;2;0;255;0");
  });

  it("throws on an invalid custom color (bad name or malformed hex)", () => {
    expect(() => resolveTheme({ keyword: { color: "totally-not-a-color" } })).toThrow(/Invalid color/);
    expect(() => resolveTheme({ keyword: { color: "#zzzzzz" } })).toThrow(/Invalid color/);
  });
});
```

- [ ] **Step 4: Build and run**

Run: `pnpm run build && pnpm test:run lib/stdlib/syntax-themes.test.ts`
Expected: PASS. (If a built-in color literal triggers a typecheck issue, confirm `pnpm run typecheck` separately.)

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/syntax-themes.ts lib/stdlib/syntax-themes.test.ts lib/stdlib/syntax.ts
git commit -F /tmp/cs-task1.txt   # "Add syntax-themes registry and resolveTheme"
```

---

## Task 2: thread `theme` through `syntaxHighlight` and `diff`

**Files:**
- Modify: `lib/stdlib/syntax.ts`
- Modify: `lib/stdlib/syntax.test.ts`

- [ ] **Step 1: Import the registry and theme the highlighter**

At the top of `lib/stdlib/syntax.ts`, ensure these imports (the `Theme` type is now needed here; `highlight` stays):

```ts
import { highlight } from "cli-highlight";
import type { Theme } from "cli-highlight";
import { resolveTheme } from "./syntax-themes.js";
```

Replace the `syntaxHighlight` function with a thin wrapper over a new `highlightWithTheme` that takes an already-resolved `Theme`. The theme is resolved **outside** the highlight try-catch, so a bad theme throws (→ Agency failure) while a genuine highlight error still falls back to plain code:

```ts
export function highlightWithTheme(code: string, _language: string, theme: Theme): string {
  if (_language === "markdown" || _language === "md") {
    return highlightMarkdown(code);
  }
  try {
    const language = _language === "agency" ? "ts" : _language;
    return highlight(code, { language, ignoreIllegals: true, theme });
  } catch (error) {
    console.error(`Error highlighting code: ${error}`);
    return code; // genuine highlight failure -> unhighlighted; theme errors throw before here
  }
}

export function syntaxHighlight(
  code: string,
  _language: string,
  theme?: string | Record<string, { color?: string; styles?: string[] }>,
): string {
  return highlightWithTheme(code, _language, resolveTheme(theme));
}
```

- [ ] **Step 2: Thread `theme` through `diffBody`**

In `lib/stdlib/syntax.ts`, update `diffBody` to take an already-resolved `Theme` (resolved once in `_diff`, not per line) and use `highlightWithTheme`:

```ts
function diffBody(
  code: string,
  kind: "context" | "delete" | "insert",
  width: number,
  language: string,
  theme: Theme,
): string {
  if (kind === "context") return highlightWithTheme(code, language, theme);
  const open = kind === "delete" ? RED_OPEN : GREEN_OPEN;
  const highlighted = highlightWithTheme(code, language, theme);
  const tinted = open + highlighted.split(ANSI_RESET).join(ANSI_RESET + open);
  const padLen = Math.max(0, width - code.length);
  const padding = padLen > 0 ? " ".repeat(padLen) : "";
  return tinted + padding + ANSI_RESET;
}
```

- [ ] **Step 3: Add `theme` to `_diff`**

Update `_diff`'s signature and `renderBody` to carry `theme` (append `theme` as the last parameter):

```ts
export function _diff(
  oldText: string,
  newText: string,
  context: number,
  lineNumbers: boolean,
  color: "auto" | boolean,
  oldLabel: string,
  newLabel: string,
  ignoreWhitespace: boolean,
  hunkHeaders: boolean,
  summary: boolean,
  language: string,
  theme: string | Record<string, { color?: string; styles?: string[] }>,
): string {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  const colored = color === "auto" ? autoUseColor() : color === true;
  // Resolve once (only when highlighting). resolveTheme throws on a bad theme,
  // failing the whole diff early via Agency's auto-failure.
  const resolved = language ? resolveTheme(theme) : undefined;
  const renderBody =
    language && resolved
      ? (code: string, kind: "context" | "delete" | "insert", width: number) =>
          diffBody(code, kind, width, language, resolved)
      : undefined;
  return renderDiff(hunks, {
    lineNumbers,
    colored,
    oldLabel,
    newLabel,
    hunkHeaders,
    summary,
    renderBody,
  });
}
```

- [ ] **Step 4: Add a themed-highlight assertion**

Append to `lib/stdlib/syntax.test.ts`:

```ts
import { syntaxHighlight } from "./syntax.js";

describe("syntaxHighlight theme", () => {
  it("uses the requested named theme", () => {
    // monokai keyword #f92672 = 249,38,114
    const out = syntaxHighlight("const x = 1", "ts", "monokai");
    expect(out).toContain("38;2;249;38;114");
  });

  it("accepts a custom ColorScheme", () => {
    const out = syntaxHighlight("const x = 1", "ts", { keyword: { color: "#ff0000" } });
    expect(out).toContain("38;2;255;0;0");
  });

  it("throws on an unknown scheme (propagates as an Agency failure)", () => {
    expect(() => syntaxHighlight("const x = 1", "ts", "bad-theme")).toThrow(/Unknown color scheme/);
  });
});
```

- [ ] **Step 5: Build and run**

Run: `pnpm run build && pnpm test:run lib/stdlib/syntax.test.ts lib/stdlib/syntax-themes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/syntax.ts lib/stdlib/syntax.test.ts
git commit -F /tmp/cs-task2.txt   # "Thread theme through syntaxHighlight and diff"
```

---

## Task 3: Agency types + `theme` parameter

**Files:**
- Modify: `stdlib/syntax.agency`

- [ ] **Step 1: Add the scheme types**

Near the top of `stdlib/syntax.agency` (after the existing `import`/`HighlightMode`), add:

```ts
type Style = "bold" | "italic" | "underline" | "dim"

type TokenStyle = {
  color: string
  styles?: Style[]
}

# A custom color scheme. Each field is a highlight.js token class; the 10
# hyphenated classes use camelCase names (e.g. metaKeyword -> meta-keyword).
type ColorScheme = {
  keyword?: TokenStyle
  built_in?: TokenStyle
  type?: TokenStyle
  literal?: TokenStyle
  number?: TokenStyle
  regexp?: TokenStyle
  string?: TokenStyle
  subst?: TokenStyle
  symbol?: TokenStyle
  class?: TokenStyle
  function?: TokenStyle
  title?: TokenStyle
  params?: TokenStyle
  comment?: TokenStyle
  doctag?: TokenStyle
  meta?: TokenStyle
  section?: TokenStyle
  tag?: TokenStyle
  name?: TokenStyle
  attr?: TokenStyle
  attribute?: TokenStyle
  variable?: TokenStyle
  bullet?: TokenStyle
  code?: TokenStyle
  emphasis?: TokenStyle
  strong?: TokenStyle
  formula?: TokenStyle
  link?: TokenStyle
  quote?: TokenStyle
  addition?: TokenStyle
  deletion?: TokenStyle
  default?: TokenStyle
  metaKeyword?: TokenStyle
  metaString?: TokenStyle
  builtinName?: TokenStyle
  selectorTag?: TokenStyle
  selectorId?: TokenStyle
  selectorClass?: TokenStyle
  selectorAttr?: TokenStyle
  selectorPseudo?: TokenStyle
  templateTag?: TokenStyle
  templateVariable?: TokenStyle
}
```

- [ ] **Step 2: Add `theme` to `highlight` and update its docstring**

Replace the `highlight` function with:

```ts
export def highlight(
  code: string,
  language: string = "plaintext",
  mode: HighlightMode = "shell",
  theme: string | ColorScheme = "vscode-dark",
): string {
  """
  A tool for syntax highlighting code snippets. Specify the programming language for accurate highlighting (e.g., "javascript", "python", "json"). Defaults to plain text if no language is provided.

  Pick a color scheme by name, or pass a custom one. Named schemes:
  "vscode-dark" (default), "github-dark", "monokai", "dracula", "nord",
  "github" (light), "a11y-dark", "a11y-light" (accessible).

  A custom scheme maps token classes to colors, merged over "vscode-dark":

      highlight(code, "ts", theme: {
        keyword: { color: "#C586C0", styles: ["bold"] },
        comment: { color: "#6A9955", styles: ["italic"] },
        string:  { color: "green" }
      })

  An unknown scheme name or an invalid color (bad hex / unknown color name)
  returns a failure.

  @param code - The code snippet to highlight
  @param language - The programming language of the code (optional, defaults to "plaintext")
  @param mode - The output format for the highlighted code: "shell" for terminal output
  @param theme - A named color scheme (e.g. "dracula") or a custom ColorScheme object
  """
  return _syntaxHighlight(code, language, theme)
}
```

- [ ] **Step 3: Add `theme` to `diff`**

In the `diff` function, add `theme: string | ColorScheme = "vscode-dark"` as the last parameter, document it, and pass it to `_diff`:

```ts
  hunkHeaders: boolean = false,
  summary: boolean = false,
  language: string = "",
  theme: string | ColorScheme = "vscode-dark",
): string {
```

Add this line to the docstring's `@param` block:

```
  @param theme - When `language` is set, the syntax-highlighting color scheme: a named scheme (e.g. "dracula") or a custom ColorScheme object
```

And change the return call to:

```ts
  return _diff(oldText, newText, context, lineNumbers, color, oldLabel, newLabel, ignoreWhitespace, hunkHeaders, summary, language, theme)
```

- [ ] **Step 4: Build**

Run: `make`
Expected: builds cleanly; `stdlib/syntax.agency` recompiles and `docs/site/stdlib/syntax.md` regenerates with the `theme` params.

- [ ] **Step 5: Smoke-test from Agency**

Create `tests/agency/_theme-smoke.agency`:

```ts
import { highlight } from "std::syntax"

node main(): string {
  return highlight("const x = 1", "ts", theme: "monokai")
}
```

Run: `pnpm run a tests/agency/_theme-smoke.agency`
Expected: prints monokai-colored output (pink `const`). Then remove it: `rm tests/agency/_theme-smoke.agency tests/agency/_theme-smoke.js`

- [ ] **Step 6: Commit**

```bash
git add stdlib/syntax.agency docs/site/stdlib/syntax.md
git commit -F /tmp/cs-task3.txt   # "Add theme param + ColorScheme to std::syntax highlight and diff"
```

---

## Task 4: end-to-end Agency-js test

**Files:**
- Create: `tests/agency-js/stdlib/std-syntax-theme/{agent.agency,test.js,fixture.json}`

- [ ] **Step 1: Agent**

Create `tests/agency-js/stdlib/std-syntax-theme/agent.agency`:

```ts
import { highlight, diff } from "std::syntax"

node named(): string {
  return highlight("const x = 1", "ts", theme: "monokai")
}

node custom(): string {
  return highlight("const x = 1", "ts", theme: { keyword: { color: "#ff0000" } })
}

node themedDiff(): string {
  return diff("const x = 1", "const x = 2", color: true, language: "ts", theme: "monokai")
}

node badTheme(): string {
  return highlight("const x = 1", "ts", theme: "no-such-scheme")
}
```

- [ ] **Step 2: Harness**

Create `tests/agency-js/stdlib/std-syntax-theme/test.js`:

```js
import { writeFileSync } from "fs";
import { named, custom, themedDiff, badTheme } from "./agent.js";

const namedOut = (await named()).data;
const customOut = (await custom()).data;
const diffOut = (await themedDiff()).data;
// A bad theme throws inside highlight; Agency's auto try-catch turns it into a
// failure, so the node's return value is a failure Result.
const badOut = (await badTheme()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      // monokai keyword #f92672 = 249,38,114
      named: { monokaiKeyword: namedOut.includes("38;2;249;38;114") },
      // custom red keyword
      custom: { redKeyword: customOut.includes("38;2;255;0;0") },
      // themed diff: monokai fg AND the green/red diff backgrounds
      diff: {
        monokaiKeyword: diffOut.includes("38;2;249;38;114"),
        hasRedBg: diffOut.includes("\x1b[48;2;60;0;0m"),
        hasGreenBg: diffOut.includes("\x1b[48;2;0;45;0m"),
      },
      // unknown scheme -> failure
      bad: { isFailure: badOut && badOut.success === false },
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Expected fixture**

Create `tests/agency-js/stdlib/std-syntax-theme/fixture.json`:

```json
{
  "named": { "monokaiKeyword": true },
  "custom": { "redKeyword": true },
  "diff": { "monokaiKeyword": true, "hasRedBg": true, "hasGreenBg": true },
  "bad": { "isFailure": true }
}
```

- [ ] **Step 4: Run**

Run: `pnpm run a test js tests/agency-js/stdlib/std-syntax-theme`
Expected: `1/1 TS tests passed`.

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/stdlib/std-syntax-theme/agent.agency \
  tests/agency-js/stdlib/std-syntax-theme/test.js \
  tests/agency-js/stdlib/std-syntax-theme/fixture.json
git commit -F /tmp/cs-task4.txt   # "Add end-to-end test for syntax color schemes"
```

---

## Task 5: final verification

- [ ] **Step 1: Full unit + typecheck**

Run: `pnpm test:run lib/stdlib/syntax-themes.test.ts lib/stdlib/syntax.test.ts lib/utils/diff.test.ts`
Expected: PASS.

Run: `pnpm run typecheck`
Expected: exit 0, no `error TS`.

- [ ] **Step 2: Agency-js regressions**

Run: `pnpm run a test js tests/agency-js/stdlib/std-syntax-theme tests/agency-js/stdlib/std-syntax-diff-highlight`
Expected: all PASS (the highlighted-diff test still passes with the new theme plumbing defaulting to vscode-dark).

- [ ] **Step 3: Confirm docs**

Run: `grep -n "theme" docs/site/stdlib/syntax.md`
Expected: the `highlight` and `diff` signatures show the `theme` param and the `@param theme` lines are present.

---

## Self-Review notes (verified while writing)

- **Spec coverage:** `theme: string | ColorScheme` on `highlight` + `diff` → Tasks 2, 3. 8 built-ins incl. `a11y-dark`/`a11y-light` + `github` light → Task 1 (`BUILTINS`). `ColorScheme` typed object with camelCase hyphenated fields, merged over vscode-dark → Tasks 1 (`resolveTheme`, `FIELD_TO_CLASS`), 3. `TokenStyle { color, styles?: Style[] }` + invalid-color/unknown-scheme **throws** → Task 1 (`buildStyleFn`, `resolveTheme`), surfaced as a failure end-to-end → Task 4. `diff` keeps red/green bg, themes only fg → Task 2 + Task 4 assertion. Docstring examples → Task 3. New `syntax-themes.ts` module → Task 1.
- **Type consistency:** the custom-theme runtime shape `Record<string, { color?: string; styles?: string[] }>` is identical in `resolveTheme` (Task 1) and the public `syntaxHighlight`/`_diff` (Task 2); internally those resolve once and pass a `Theme` to `highlightWithTheme`/`diffBody`. `Style` values (`bold`/`italic`/`underline`/`dim`) match `applyStyles`. Built-in unthemed classes use the theme's base color (`buildBuiltin`); the custom path throws on a bad color rather than falling back.
- **No placeholders:** every theme literal is concrete (ported from highlight.js v10 CSS); every step shows full code and expected output.
- **Known soft spots:** `github-dark` was ported from highlight.js v11 (v10 lacked it) and mapped to v10 token keys — colors are GitHub's, granularity matches our v10 highlighter. The markdown highlight path is not themed (uses its own renderer) — out of scope and unchanged.
```
