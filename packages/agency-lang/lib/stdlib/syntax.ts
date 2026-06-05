import { highlight, Theme } from "cli-highlight";
import { color } from "@/utils/termcolors.js";
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