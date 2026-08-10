// The XML grammar and the parseXml entry point. Recursive descent over the
// newline-normalized source, using tarsec's parse state for error reporting:
// every failure past a commit point ('<' + name start, '<?', '<!--',
// '<![CDATA[', '<!DOCTYPE') is a registered committed failure, so the
// runNested wrapper can format it with line/column while the nested state is
// still installed. Custom parser functions are used throughout (sanctioned
// where combinators fight the problem: close-tag matching against the open
// tag, counter threading, targeted diagnostics).
//
// Document grammar (from the spec):
//   document := BOM? XMLDecl? Misc* Doctype? Misc* element Misc* EOF
//   Misc     := XML-whitespace | comment | processing-instruction
//   content  := text | CDATA | comment | processing-instruction | element
import {
  committedFailure,
  failure,
  getErrorMessage,
  getParseState,
  runNested,
  success,
  type Parser,
  type ParserResult,
} from "tarsec";
import { decodeReferences, validateChars } from "./entities.js";
import {
  MAX_DEPTH,
  MAX_INPUT_BYTES,
  MAX_TREE_ENTRIES,
  type ParseXmlResult,
  type XmlDocument,
  type XmlElement,
  type XmlNode,
} from "./types.js";

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const EQ = 0x3d;
const QUOT = 0x22;
const APOS = 0x27;
const SP = 0x20;
const TAB = 0x09;
const NL = 0x0a;
const COLON = 0x3a;
const UNDERSCORE = 0x5f;

function isNameStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === UNDERSCORE || c === COLON;
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d;
}

function isWs(c: number): boolean {
  return c === SP || c === TAB || c === NL;
}

// 1-based line/column in the normalized source, matching tarsec's display.
function lineColOf(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === NL) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

/**
 * Parse an XML string into a document tree. Never throws: every outcome —
 * including limit violations and hostile input — is the discriminated
 * result. Error strings carry line/column and construct context.
 */
export function parseXml(rawInput: string): ParseXmlResult {
  const bytes = Buffer.byteLength(rawInput, "utf8");
  if (bytes > MAX_INPUT_BYTES) {
    return {
      ok: false,
      error: `input is ${bytes} bytes (UTF-8); the maximum is ${MAX_INPUT_BYTES} bytes`,
    };
  }
  // One normalization pass so tarsec positions, entity-decoder offsets, and
  // output text all share a single coordinate system (XML newline rule:
  // CRLF and lone CR become LF).
  const source = rawInput.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const wrapper: Parser<XmlDocument> = () => {
    const p = new DocumentParse(source);
    const r = p.parseDocument();
    if (!r.success) {
      // Format while the nested state is still installed; the registered
      // committed failure wins, the raw failure message is the fallback.
      const msg = getErrorMessage() ?? r.message;
      return failure(msg, r.rest);
    }
    return r;
  };
  const result = runNested(wrapper, source);
  if (!result.success) {
    return { ok: false, error: result.message };
  }
  return { ok: true, doc: result.result };
}

// All state for one parse: position, depth, and the tree-entry budget.
// Fresh per parseXml call; nothing survives it.
class DocumentParse {
  private readonly source: string;
  private depth = 0;
  private entries = 0;

  constructor(source: string) {
    this.source = source;
  }

  // A committed failure at `offset`, registered in tarsec's parse state so
  // getErrorMessage() prefers it (the one local helper the plan requires).
  private fail<T>(message: string, offset: number): ParserResult<T> {
    const f = committedFailure(message, this.source.slice(offset));
    getParseState().committedFailure = f;
    return f;
  }

  private reserve<T>(what: string, offset: number): ParserResult<null> {
    this.entries++;
    if (this.entries > MAX_TREE_ENTRIES) {
      return this.fail(
        `document exceeds the tree entry limit of ${MAX_TREE_ENTRIES} (counting elements, attributes, and text nodes); refusing to parse further ${what}`,
        offset,
      );
    }
    return success(null, "");
  }

  private at(i: number): number {
    return i < this.source.length ? this.source.charCodeAt(i) : -1;
  }

  private startsWith(s: string, i: number): boolean {
    return this.source.startsWith(s, i);
  }

  private skipWs(i: number): number {
    while (isWs(this.at(i))) i++;
    return i;
  }

  private readName(i: number): { name: string; end: number } | null {
    if (!isNameStart(this.at(i))) return null;
    let j = i + 1;
    while (isNameChar(this.at(j))) j++;
    return { name: this.source.slice(i, j), end: j };
  }

  // document := BOM? XMLDecl? Misc* Doctype? Misc* element Misc* EOF
  parseDocument(): ParserResult<XmlDocument> {
    let i = 0;
    if (this.at(0) === 0xfeff) i = 1;
    if (this.startsWith("<?xml", i) && isWs(this.at(i + 5))) {
      const end = this.source.indexOf("?>", i);
      if (end === -1) return this.fail("unterminated XML declaration", i);
      i = end + 2;
    }
    let sawDoctype = false;
    let root: XmlElement | null = null;
    for (;;) {
      i = this.skipWs(i);
      if (i >= this.source.length) break;
      const misc = this.tryMisc(i);
      if (misc !== null) {
        if (!misc.result.success) return misc.result as ParserResult<XmlDocument>;
        i = misc.end;
        continue;
      }
      if (this.startsWith("<?xml", i) && (isWs(this.at(i + 5)) || this.at(i + 5) === 0x3f)) {
        return this.fail("the XML declaration may appear only once, at the very beginning of the document", i);
      }
      if (this.startsWith("<!DOCTYPE", i)) {
        if (root !== null) return this.fail("a DOCTYPE must appear before the root element", i);
        if (sawDoctype) return this.fail("at most one DOCTYPE declaration is allowed", i);
        const d = this.parseDoctype(i);
        if (!d.result.success) return d.result as ParserResult<XmlDocument>;
        sawDoctype = true;
        i = d.end;
        continue;
      }
      if (this.startsWith("<![CDATA[", i)) {
        return this.fail("CDATA sections are only allowed inside an element", i);
      }
      if (this.at(i) === LT && isNameStart(this.at(i + 1))) {
        if (root !== null) return this.fail("a document may have only one root element", i);
        const el = this.parseElement(i);
        if (!el.result.success) return el.result as ParserResult<XmlDocument>;
        root = el.result.result;
        i = el.end;
        continue;
      }
      if (root === null) {
        return this.fail("expected an element (a document has exactly one root element)", i);
      }
      return this.fail("content after the root element is not allowed", i);
    }
    if (root === null) {
      return this.fail("expected an element (the document is empty)", 0);
    }
    return success({ root }, "");
  }

  // Comment or PI at `i`, or null if `i` starts neither. The XML
  // declaration is handled by the caller and rejected here.
  private tryMisc(i: number): { result: ParserResult<null>; end: number } | null {
    if (this.startsWith("<!--", i)) {
      const c = this.parseComment(i);
      return { result: c.result, end: c.end };
    }
    if (this.startsWith("<?", i)) {
      if (this.startsWith("<?xml", i) && (isWs(this.at(i + 5)) || this.at(i + 5) === 0x3f)) {
        return null; // misplaced declaration; caller produces the message
      }
      const end = this.source.indexOf("?>", i + 2);
      if (end === -1) return { result: this.fail("unterminated processing instruction", i), end: i };
      return { result: success(null, ""), end: end + 2 };
    }
    return null;
  }

  private parseComment(i: number): { result: ParserResult<null>; end: number } {
    // Inside a comment the first `--` must belong to the `-->` terminator.
    const dd = this.source.indexOf("--", i + 4);
    if (dd === -1) return { result: this.fail("unterminated comment", i), end: i };
    if (this.at(dd + 2) !== GT) {
      return { result: this.fail("`--` is not allowed inside a comment", dd), end: i };
    }
    return { result: success(null, ""), end: dd + 3 };
  }

  private parseDoctype(i: number): { result: ParserResult<null>; end: number } {
    // Quote-aware scan: quoted strings may contain `[` and `>`; an unquoted
    // `[` starts an internal subset, which is unsupported.
    let j = i + 9;
    let quote = -1;
    while (j < this.source.length) {
      const c = this.at(j);
      if (quote !== -1) {
        if (c === quote) quote = -1;
      } else if (c === QUOT || c === APOS) {
        quote = c;
      } else if (c === 0x5b /* [ */) {
        return { result: this.fail("DTD internal subsets are not supported", j), end: i };
      } else if (c === GT) {
        return { result: success(null, ""), end: j + 1 };
      }
      j++;
    }
    return {
      result: this.fail(quote !== -1 ? "unterminated quoted string in DOCTYPE" : "unterminated DOCTYPE declaration", i),
      end: i,
    };
  }

  // Element at `i` (caller guarantees '<' + name start).
  private parseElement(i: number): { result: ParserResult<XmlElement>; end: number } {
    const openOffset = i;
    const nm = this.readName(i + 1);
    if (nm === null) {
      return { result: this.fail("expected a tag name after `<`", i + 1), end: i };
    }
    const tag = nm.name;
    // Commit point reached: '<' + name. Depth is checked before any child
    // recursion and restored in finally on every path.
    this.depth++;
    try {
      if (this.depth > MAX_DEPTH) {
        return {
          result: this.fail(`element nesting exceeds the depth limit of ${MAX_DEPTH}`, openOffset),
          end: i,
        };
      }
      const res = this.reserve("elements", openOffset);
      if (!res.success) return { result: res as ParserResult<XmlElement>, end: i };

      const attrs: Record<string, string> = Object.create(null);
      let j = nm.end;
      for (;;) {
        const wsStart = j;
        j = this.skipWs(j);
        const c = this.at(j);
        if (c === GT || (c === SLASH && this.at(j + 1) === GT)) break;
        if (!isNameStart(c)) {
          return {
            result: this.fail(
              c === -1 ? `unclosed <${tag}> tag (expected \`>\` or \`/>\`)` : `expected an attribute name, \`>\`, or \`/>\` in <${tag}>`,
              j,
            ),
            end: i,
          };
        }
        if (j === wsStart) {
          return { result: this.fail(`expected whitespace before attribute in <${tag}>`, j), end: i };
        }
        const a = this.parseAttribute(j, tag, attrs);
        if (!a.result.success) return { result: a.result as ParserResult<XmlElement>, end: i };
        j = a.end;
      }

      if (this.at(j) === SLASH) {
        return { result: success({ kind: "element", tag, attrs, children: [] }, ""), end: j + 2 };
      }
      j++;

      const children: XmlNode[] = [];
      for (;;) {
        // Text run: everything up to the next '<' (references included).
        const lt = this.source.indexOf("<", j);
        const runEnd = lt === -1 ? this.source.length : lt;
        if (runEnd > j) {
          const run = this.source.slice(j, runEnd);
          const cdEnd = run.indexOf("]]>");
          if (cdEnd !== -1) {
            return { result: this.fail("`]]>` is not allowed in ordinary text", j + cdEnd), end: i };
          }
          const decoded = decodeReferences(run, j);
          if (!decoded.ok) {
            return { result: this.fail(decoded.message, decoded.offset), end: i };
          }
          const txt = this.pushText(children, decoded.text, j);
          if (!txt.success) return { result: txt as ParserResult<XmlElement>, end: i };
          j = runEnd;
        }
        if (j >= this.source.length) {
          const opened = lineColOf(this.source, openOffset);
          return {
            result: this.fail(`unclosed <${tag}> (opened at line ${opened.line}, col ${opened.col})`, j),
            end: i,
          };
        }
        if (this.startsWith("</", j)) {
          const cn = this.readName(j + 2);
          if (cn === null || cn.name !== tag) {
            // Only failure paths pay for the O(offset) position scan; the
            // successful-close hot path must stay O(1) per element.
            const opened = lineColOf(this.source, openOffset);
            const found = cn === null ? "`</`" : `</${cn.name}>`;
            return {
              result: this.fail(
                `expected </${tag}> to close <${tag}> opened at line ${opened.line}, col ${opened.col}, but found ${found} (tag names are case-sensitive)`,
                j,
              ),
              end: i,
            };
          }
          const gt = this.skipWs(cn.end);
          if (this.at(gt) !== GT) {
            return { result: this.fail(`expected \`>\` after </${tag}`, gt), end: i };
          }
          return { result: success({ kind: "element", tag, attrs, children }, ""), end: gt + 1 };
        }
        if (this.startsWith("<!--", j)) {
          const c = this.parseComment(j);
          if (!c.result.success) return { result: c.result as ParserResult<XmlElement>, end: i };
          j = c.end;
          continue;
        }
        if (this.startsWith("<![CDATA[", j)) {
          const end = this.source.indexOf("]]>", j + 9);
          if (end === -1) {
            return { result: this.fail("unterminated CDATA section", j), end: i };
          }
          const content = this.source.slice(j + 9, end);
          const valid = validateChars(content, j + 9);
          if (!valid.ok) {
            return { result: this.fail(valid.message, valid.offset), end: i };
          }
          const txt = this.pushText(children, content, j);
          if (!txt.success) return { result: txt as ParserResult<XmlElement>, end: i };
          j = end + 3;
          continue;
        }
        if (this.startsWith("<!DOCTYPE", j)) {
          return { result: this.fail("a DOCTYPE must appear before the root element", j), end: i };
        }
        if (this.startsWith("<?", j)) {
          const misc = this.tryMisc(j);
          if (misc === null) {
            return {
              result: this.fail("the XML declaration may appear only once, at the very beginning of the document", j),
              end: i,
            };
          }
          if (!misc.result.success) return { result: misc.result as ParserResult<XmlElement>, end: i };
          j = misc.end;
          continue;
        }
        if (isNameStart(this.at(j + 1))) {
          const child = this.parseElement(j);
          if (!child.result.success) return { result: child.result as ParserResult<XmlElement>, end: i };
          children.push(child.result.result);
          j = child.end;
          continue;
        }
        return { result: this.fail("expected a tag name after `<`", j + 1), end: i };
      }
    } finally {
      this.depth--;
    }
  }

  // Append decoded/CDATA text: merge into an adjacent text node (no new
  // entry) or reserve and push a new one. Empty contributions are dropped —
  // an empty CDATA or a fully-consumed run adds nothing. Whitespace-only
  // text is retained like any other text.
  private pushText(children: XmlNode[], text: string, offset: number): ParserResult<null> {
    if (text === "") return success(null, "");
    const last = children.length > 0 ? children[children.length - 1] : null;
    if (last !== null && last.kind === "text") {
      last.text += text;
      return success(null, "");
    }
    const res = this.reserve("text", offset);
    if (!res.success) return res;
    children.push({ kind: "text", text });
    return success(null, "");
  }

  // Attribute at `i` (caller guarantees a name-start char).
  private parseAttribute(
    i: number,
    tag: string,
    attrs: Record<string, string>,
  ): { result: ParserResult<null>; end: number } {
    const nm = this.readName(i);
    if (nm === null) {
      return { result: this.fail(`expected an attribute name in <${tag}>`, i), end: i };
    }
    let j = this.skipWs(nm.end);
    if (this.at(j) !== EQ) {
      return { result: this.fail(`expected \`=\` after attribute name "${nm.name}" in <${tag}>`, j), end: i };
    }
    j = this.skipWs(j + 1);
    const q = this.at(j);
    if (q !== QUOT && q !== APOS) {
      return {
        result: this.fail(`attribute value for "${nm.name}" in <${tag}> must be quoted (with " or ')`, j),
        end: i,
      };
    }
    const valStart = j + 1;
    let k = valStart;
    for (;;) {
      const c = this.at(k);
      if (c === -1) {
        return { result: this.fail(`unterminated attribute value for "${nm.name}" in <${tag}>`, j), end: i };
      }
      if (c === q) break;
      if (c === LT) {
        return {
          result: this.fail(`attribute values may not contain a literal \`<\` (in "${nm.name}" of <${tag}>)`, k),
          end: i,
        };
      }
      k++;
    }
    const raw = this.source.slice(valStart, k);
    const decoded = decodeReferences(raw, valStart);
    if (!decoded.ok) {
      return { result: this.fail(decoded.message, decoded.offset), end: i };
    }
    if (Object.prototype.hasOwnProperty.call(attrs, nm.name)) {
      return { result: this.fail(`duplicate attribute "${nm.name}" in <${tag}>`, i), end: i };
    }
    const res = this.reserve("attributes", i);
    if (!res.success) return { result: res, end: i };
    attrs[nm.name] = decoded.text;
    return { result: success(null, ""), end: k + 1 };
  }
}
