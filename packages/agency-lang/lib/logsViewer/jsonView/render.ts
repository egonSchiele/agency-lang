import { JsonNode, LONG_STRING_THRESHOLD } from "./types.js";
import type { Color } from "../../tui/elements.js";

// A single rendered line in the JSON pane. Segments carry per-text
// style so the consumer can build TUI text elements with multiple
// colors (and so unit tests can assert colors per substring).
export type JsonLine = {
  // Path of the node that "owns" this line (the line where the
  // glyph and key sit). Used for cursor/expand state — clicking
  // on a continuation line still expands the owning node.
  ownerPath: string;
  segments: JsonSegment[];
};

export type JsonSegment = {
  text: string;
  fg?: Color;
  bg?: Color;
};

// Color palette per the design.
const KEY_FG: Color = "bright-white";
const STRING_FG: Color = "bright-green";
const NUMBER_FG: Color = "bright-cyan";
const BOOLEAN_FG: Color = "bright-magenta";
const NULL_FG: Color = "gray";
const GLYPH_FG: Color = "gray";
const PREVIEW_FG: Color = "gray";

const INDENT = "  ";

export type JsonRenderOpts = {
  // Set of paths whose container is expanded (object/array/longString).
  open: ReadonlySet<string>;
  // Path of the currently-focused line (gets a "> " marker).
  cursorPath?: string;
};

export function renderJson(node: JsonNode, opts: JsonRenderOpts): JsonLine[] {
  return renderNode(node, 0, opts, undefined, true);
}

// Render a JsonNode at the given depth. `keyLabel` is the JSON
// object-key (already JSON-quoted with the colon, e.g. `"usage": `)
// when this node is being rendered as an object value. `isLast`
// controls trailing-comma suppression.
function renderNode(
  node: JsonNode,
  depth: number,
  opts: JsonRenderOpts,
  keyLabel: string | undefined,
  isLast: boolean,
): JsonLine[] {
  const indent = INDENT.repeat(depth);
  const trailing = isLast ? "" : ",";

  switch (node.kind) {
    case "primitive":
      return [
        primitiveLine(node, indent, keyLabel, trailing, opts),
      ];
    case "longString":
      return renderLongString(node, indent, depth, keyLabel, trailing, opts);
    case "object":
      return renderObject(node, indent, depth, keyLabel, trailing, opts);
    case "array":
      return renderArray(node, indent, depth, keyLabel, trailing, opts);
  }
}

function primitiveLine(
  node: Extract<JsonNode, { kind: "primitive" }>,
  indent: string,
  keyLabel: string | undefined,
  trailing: string,
  opts: JsonRenderOpts,
): JsonLine {
  const segments: JsonSegment[] = [
    cursor(node.path, opts.cursorPath),
    { text: indent },
  ];
  if (keyLabel !== undefined) {
    segments.push({ text: keyLabel, fg: KEY_FG });
  }
  segments.push({ text: node.raw, fg: primitiveColor(node.valueType) });
  if (trailing) segments.push({ text: trailing });
  return { ownerPath: node.path, segments };
}

function primitiveColor(
  vt: "string" | "number" | "boolean" | "null",
): Color {
  switch (vt) {
    case "string":
      return STRING_FG;
    case "number":
      return NUMBER_FG;
    case "boolean":
      return BOOLEAN_FG;
    case "null":
      return NULL_FG;
  }
}

function renderLongString(
  node: Extract<JsonNode, { kind: "longString" }>,
  indent: string,
  depth: number,
  keyLabel: string | undefined,
  trailing: string,
  opts: JsonRenderOpts,
): JsonLine[] {
  const isOpen = opts.open.has(node.path);
  const glyph = isOpen ? "▼" : "▶";
  if (!isOpen) {
    const preview = node.raw.split("\n")[0].slice(0, LONG_STRING_THRESHOLD - 20);
    const segments: JsonSegment[] = [
      cursor(node.path, opts.cursorPath),
      { text: indent },
      { text: `${glyph} `, fg: GLYPH_FG },
    ];
    if (keyLabel !== undefined) {
      segments.push({ text: keyLabel, fg: KEY_FG });
    }
    segments.push(
      { text: `"${preview}…"`, fg: STRING_FG },
      { text: ` (${node.raw.length} chars)`, fg: PREVIEW_FG },
    );
    if (trailing) segments.push({ text: trailing });
    return [{ ownerPath: node.path, segments }];
  }
  // Open: the first line shows the glyph and key (if any) plus an
  // opening quote; subsequent lines indent the body; the final line
  // closes the quote.
  const childIndent = INDENT.repeat(depth + 1);
  const lines: JsonLine[] = [];
  const headerSegs: JsonSegment[] = [
    cursor(node.path, opts.cursorPath),
    { text: indent },
    { text: `${glyph} `, fg: GLYPH_FG },
  ];
  if (keyLabel !== undefined) headerSegs.push({ text: keyLabel, fg: KEY_FG });
  headerSegs.push({ text: '"', fg: STRING_FG });
  lines.push({ ownerPath: node.path, segments: headerSegs });
  for (const ln of node.raw.split("\n")) {
    lines.push({
      ownerPath: node.path,
      segments: [
        { text: "  " },
        { text: childIndent },
        { text: ln, fg: STRING_FG },
      ],
    });
  }
  const closeSegs: JsonSegment[] = [
    { text: "  " },
    { text: indent },
    { text: '"', fg: STRING_FG },
  ];
  if (trailing) closeSegs.push({ text: trailing });
  lines.push({ ownerPath: node.path, segments: closeSegs });
  return lines;
}

function renderObject(
  node: Extract<JsonNode, { kind: "object" }>,
  indent: string,
  depth: number,
  keyLabel: string | undefined,
  trailing: string,
  opts: JsonRenderOpts,
): JsonLine[] {
  const isOpen = opts.open.has(node.path);
  if (!isOpen) {
    return [
      collapsedContainer(node.path, indent, keyLabel, "{", `${node.entries.length} keys`, "}", trailing, opts),
    ];
  }
  const lines: JsonLine[] = [];
  lines.push(openLine(node.path, indent, keyLabel, "{", opts));
  node.entries.forEach((entry, i) => {
    const childKey = `${JSON.stringify(entry.key)}: `;
    const childLines = renderNode(
      entry.child,
      depth + 1,
      opts,
      childKey,
      i === node.entries.length - 1,
    );
    lines.push(...childLines);
  });
  lines.push(closeLine(node.path, indent, "}", trailing));
  return lines;
}

function renderArray(
  node: Extract<JsonNode, { kind: "array" }>,
  indent: string,
  depth: number,
  keyLabel: string | undefined,
  trailing: string,
  opts: JsonRenderOpts,
): JsonLine[] {
  const isOpen = opts.open.has(node.path);
  if (!isOpen) {
    return [
      collapsedContainer(node.path, indent, keyLabel, "[", `${node.items.length} items`, "]", trailing, opts),
    ];
  }
  const lines: JsonLine[] = [];
  lines.push(openLine(node.path, indent, keyLabel, "[", opts));
  node.items.forEach((item, i) => {
    const childLines = renderNode(
      item,
      depth + 1,
      opts,
      undefined,
      i === node.items.length - 1,
    );
    lines.push(...childLines);
  });
  lines.push(closeLine(node.path, indent, "]", trailing));
  return lines;
}

function collapsedContainer(
  path: string,
  indent: string,
  keyLabel: string | undefined,
  openChar: string,
  countLabel: string,
  closeChar: string,
  trailing: string,
  opts: JsonRenderOpts,
): JsonLine {
  const segments: JsonSegment[] = [
    cursor(path, opts.cursorPath),
    { text: indent },
    { text: "▶ ", fg: GLYPH_FG },
  ];
  if (keyLabel !== undefined) segments.push({ text: keyLabel, fg: KEY_FG });
  segments.push({ text: `${openChar} ${countLabel} ${closeChar}` });
  if (trailing) segments.push({ text: trailing });
  return { ownerPath: path, segments };
}

function openLine(
  path: string,
  indent: string,
  keyLabel: string | undefined,
  openChar: string,
  opts: JsonRenderOpts,
): JsonLine {
  const segments: JsonSegment[] = [
    cursor(path, opts.cursorPath),
    { text: indent },
    { text: "▼ ", fg: GLYPH_FG },
  ];
  if (keyLabel !== undefined) segments.push({ text: keyLabel, fg: KEY_FG });
  segments.push({ text: openChar });
  return { ownerPath: path, segments };
}

function closeLine(
  path: string,
  indent: string,
  closeChar: string,
  trailing: string,
): JsonLine {
  const segments: JsonSegment[] = [
    { text: "  " },
    { text: indent },
    { text: closeChar },
  ];
  if (trailing) segments.push({ text: trailing });
  return { ownerPath: path, segments };
}

function cursor(path: string, cursorPath?: string): JsonSegment {
  return { text: cursorPath === path ? "> " : "  " };
}

// Convert a line's segments to plain text — useful for tests and the
// outer composition layer when it just needs the text content.
export function lineToText(line: JsonLine): string {
  return line.segments.map((s) => s.text).join("");
}

// Compute the default-open set per the design: top-level container
// open; one level of nested containers open; small containers (≤ 3
// items) open. Returns paths only.
export function defaultOpenSet(root: JsonNode): Set<string> {
  const out = new Set<string>();
  if (isContainer(root)) out.add(root.path);
  // One level deep.
  for (const child of containerChildren(root)) {
    if (isContainer(child)) out.add(child.path);
    // Plus small grandchildren.
    for (const grand of containerChildren(child)) {
      if (isContainer(grand) && isSmall(grand)) out.add(grand.path);
    }
  }
  return out;
}

function isContainer(node: JsonNode): boolean {
  return node.kind === "object" || node.kind === "array";
}

function isSmall(node: JsonNode): boolean {
  if (node.kind === "object") return node.entries.length <= 3;
  if (node.kind === "array") return node.items.length <= 3;
  return false;
}

function containerChildren(node: JsonNode): JsonNode[] {
  if (node.kind === "object") return node.entries.map((e) => e.child);
  if (node.kind === "array") return node.items;
  return [];
}
