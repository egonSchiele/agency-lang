import { highlight, Theme } from "cli-highlight";
import { color } from "@/utils/termcolors.js";
import { computeHunks, renderDiff, renderPatch } from "@/utils/diff.js";
import { autoUseColor } from "@/utils/termcolors.js";
import { _parseMarkdown, _renderMarkdownForCli } from "./markdown.js";
import { Block, CodeBlock, List } from "tarsec/parsers/markdown";

// VS Code Dark+ color palette
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

// VS Code Dark+ inspired theme. The Theme type expects ChalkInstance
// values; our termcolors functions have a compatible call signature, so
// the cast is safe at runtime — cli-highlight only ever invokes these as
// `(text) => styledText`.
const vscodeDarkTheme = {
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

// Dim backgrounds for changed lines (RGB).
const DIM_RED: [number, number, number] = [60, 0, 0];
const DIM_GREEN: [number, number, number] = [0, 45, 0];
const ANSI_RESET = "\x1b[0m";

// The bare background-open SGR for an RGB (no text, no reset), derived from
// termcolors so the code format stays in one place.
function bgOpen(rgb: [number, number, number]): string {
  const wrapped = color.bgRgb(...rgb)(""); // "<open><reset>"
  return wrapped.slice(0, wrapped.length - ANSI_RESET.length);
}
const RED_OPEN = bgOpen(DIM_RED);
const GREEN_OPEN = bgOpen(DIM_GREEN);

// Render one diff line's body for the highlighted path. Context lines are
// plainly highlighted. Changed lines are highlighted with the SAME theme (so
// colors match context) and then given a continuous line background: real
// highlight.js grammars emit some punctuation/whitespace as unstyled raw text,
// so a per-token background theme would leave gaps. Instead we set the
// background once and re-arm it after every reset the highlighter emits, then
// pad to `width` so the bar is rectangular.
function diffBody(
  code: string,
  kind: "context" | "delete" | "insert",
  width: number,
  language: string,
): string {
  if (kind === "context") return syntaxHighlight(code, language);
  const open = kind === "delete" ? RED_OPEN : GREEN_OPEN;
  const highlighted = syntaxHighlight(code, language);
  const tinted = open + highlighted.split(ANSI_RESET).join(ANSI_RESET + open);
  const padLen = Math.max(0, width - code.length);
  const padding = padLen > 0 ? " ".repeat(padLen) : "";
  return tinted + padding + ANSI_RESET;
}

export function syntaxHighlight(code: string, _language: string): string {
  if (_language === "markdown" || _language === "md") {
    return highlightMarkdown(code);
  }
  try {
    const language = _language === "agency" ? "ts" : _language;
    const highlightedCode = highlight(code, {
      language,
      ignoreIllegals: true,
      theme: vscodeDarkTheme,
    });
    return highlightedCode;
  } catch (error) {
    console.error(`Error highlighting code: ${error}`);
    return code; // Return unhighlighted code on error
  }
}

/** For Markdown, plain `cli-highlight` only colors the syntax markers
 *  (fences, `#`, `*`) and leaves code-block bodies as a single style.
 *  Instead, parse the document, recursively highlight each fenced code
 *  block in its own language, then render the whole AST through the CLI
 *  renderer so the prose, links, headings, etc. get their own styling.
 *
 *  Falls back to the raw input when the parser cannot consume the
 *  whole document. The tarsec Markdown parser has edge cases where it
 *  reports `success: true` but leaves a large `rest` unconsumed —
 *  e.g. a heading immediately followed by a list item with no blank
 *  line between them. Rendering only `parsed.blocks` in that case
 *  silently drops everything after the bail point, which appeared to
 *  the user as the agent's reply being truncated mid-sentence. Trade
 *  the highlighting for the full text whenever the parser doesn't
 *  consume everything — losing color is better than losing content. */
function highlightMarkdown(code: string): string {
  const parsed = _parseMarkdown(code);
  if (!parsed.success) {
    console.error(
      `[std::syntax.highlight] Markdown parse failed; returning raw text. ` +
      `error=${JSON.stringify(parsed.error)}`,
    );
    return code;
  }
  // Defensive: any unconsumed input means the parser bailed mid-
  // document. The blocks it did produce are still valid, but
  // rendering only those would drop the unparsed tail. Log a
  // diagnostic with the first non-consumed bytes so a future report
  // of "the response was cut off" is one grep away from the trigger.
  if (parsed.rest.length > 0) {
    const preview = parsed.rest.slice(0, 80).replace(/\n/g, "\\n");
    console.error(
      `[std::syntax.highlight] Markdown parser left ${parsed.rest.length} ` +
      `chars unconsumed; returning raw text to avoid truncating output. ` +
      `Trigger preview: ${JSON.stringify(preview)}`,
    );
    return code;
  }
  const transformed = parsed.blocks.map(mapMarkdownBlock);
  return _renderMarkdownForCli(transformed);
}

function mapMarkdownBlock(block: Block): Block {
  if (
    block != null &&
    typeof block === "object"

  ) {
    const someBlock = (block as Record<string, unknown>)
    if (someBlock.type === "code-block") {
      const codeBlock = block as CodeBlock;
      return {
        ...codeBlock,
        content: syntaxHighlight(
          codeBlock.content ?? "",
          codeBlock.language ?? "plaintext",
        ),
      };
    } else if (someBlock.type === "list") {
      const listBlock = block as List;
      const items = listBlock.items.map((listItem) => {
        return {
          ...listItem,
          content: listItem.content.map(mapMarkdownBlock)
        }
      });
      return {
        ...listBlock,
        items,
      };
    }
  }
  return block;
}

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
): string {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  const colored = color === "auto" ? autoUseColor() : color === true;
  const renderBody = language
    ? (code: string, kind: "context" | "delete" | "insert", width: number) =>
        diffBody(code, kind, width, language)
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

export function _patch(
  oldText: string,
  newText: string,
  filename: string,
  context: number,
  ignoreWhitespace: boolean,
  newFilename: string,
): string {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  const oldLabel = oldText === "" ? "/dev/null" : `a/${filename}`;
  const newLabel = newText === "" ? "/dev/null" : `b/${newFilename || filename}`;
  return renderPatch(hunks, oldLabel, newLabel);
}