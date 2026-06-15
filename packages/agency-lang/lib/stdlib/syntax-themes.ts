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
