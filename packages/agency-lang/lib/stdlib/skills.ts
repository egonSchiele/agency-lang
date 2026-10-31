import path from "#path";
import { currentHost } from "../runtime/currentHost.js";

/** The stdlib directory of the installed package, through the host so it
 *  resolves in both dev and npm installs. A platform where the package is
 *  bundled into the program, such as a browser, has none. */
function stdlibDir(): string {
  const installDir = currentHost().system.installDir();
  if (installDir === null) {
    throw new Error(
      "The files agency-lang ships (its docs, skills, and prompts) are not on disk on this platform.",
    );
  }
  return path.join(installDir, "stdlib");
}

/**
 * Absolute path to a section of the packaged Agency docs. `make` stages
 * `docs/site/{guide,cli}` into `stdlib/docs/` (see stage-stdlib-docs in
 * the makefile), so one copy serves compiled and source runs.
 */
export function _docsDir(section: "guide" | "cli" | "diagnostics" | "stdlib"): string {
  return path.join(_bundledDocsDir(), section);
}

/** The parent of every packaged docs section. */
export function _bundledDocsDir(): string {
  return path.join(stdlibDir(), "docs");
}

/**
 * tarsec's frontmatter serializer, the encode half of the parser
 * `std::markdown` wraps: `parse(stringify(x))` deep-equals `x` for every
 * flat string record it accepts. Throws on values the grammar cannot
 * hold (a key it cannot spell, or a value no quote character can
 * enclose); Agency callers wrap the call in `try`.
 */
export { stringifyFrontmatter as _stringifyFrontmatter } from "tarsec/parsers/markdown";

/**
 * Absolute path to the skills we ship for one agent, under
 * `stdlib/agents/skills/<agent>`. Resolved through the host for the same
 * reason as _docsDir: a path relative to the calling file works in the
 * repo and breaks once the package is installed into node_modules.
 *
 * The name is confined to that directory. `agentSkill` deliberately skips
 * the approval interrupt that `skillsDir` raises, on the grounds that these
 * files ship inside the package, so an `agent` of `"../../.."` would turn a
 * trusted scan into an unprompted scan of somewhere else entirely. Confining
 * here keeps that trust argument true.
 */
export function _agentSkillsDir(agent: string): string {
  const root = path.join(stdlibDir(), "agents", "skills");
  const resolved = path.resolve(root, agent);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `agentSkill: '${agent}' resolves outside the shipped skills directory. ` +
        `Skill names are relative paths under stdlib/agents/skills.`,
    );
  }
  return resolved;
}

/**
 * Absolute path to the prompt text we ship for the stdlib agents, under
 * `stdlib/agents/prompts`. Resolved through the host for the same reason
 * as _docsDir.
 */
export function _agentPromptsDir(): string {
  return path.join(stdlibDir(), "agents", "prompts");
}

// The characters Claude Code refuses in a skill name or folder name: control
// characters, zero-width, invisible, and bidirectional-control characters,
// private-use and tag characters, unusual blanks, and `<` and `>`.
const REFUSED_NAME_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00A0\u00AD\u061C\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u2069\u3000\uE000-\uF8FF\uFEFF\u{E0000}-\u{E007F}<>]/u;

// Names Claude Code keeps for its own synced skills.
const RESERVED_SKILL_FOLDER = "synced";
const RESERVED_SKILL_PREFIX = "anthropic-skills";

/** True when Claude Code would refuse `name` as a skill name or folder name,
 *  or reserves it, so a skill scan skips it. */
export function _refusedSkillName(name: string): boolean {
  if (REFUSED_NAME_CHARS.test(name)) {
    return true;
  }
  if (name !== name.trim() || name.includes("  ")) {
    return true;
  }
  if (name === RESERVED_SKILL_FOLDER || name === RESERVED_SKILL_PREFIX) {
    return true;
  }
  return name.startsWith(`${RESERVED_SKILL_PREFIX}:`);
}

/** A skill file split into its frontmatter and its body. */
export type SkillFile = {
  data: Record<string, string>;
  body: string;
};

const FENCE = "---";
const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+):(.*)$/;
const BLOCK_SCALAR = /^[>|][+-]?$/;

/** Read a `SKILL.md`: the top-level `key: value` lines of its frontmatter,
 *  as strings, and the text after it. A line that is not one of those
 *  never fails the whole block, so a frontmatter switch survives a list, a
 *  comment, or a multi-line value beside it. With no frontmatter, or an
 *  unclosed fence, the whole file is body. */
export function _parseSkillFile(raw: string): SkillFile {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n$/, "")
    .split("\n");
  const end = lines[0] === FENCE ? lines.indexOf(FENCE, 1) : -1;
  if (end === -1) {
    return { data: {}, body: lines.join("\n") };
  }
  return { data: readTopLevelKeys(lines.slice(1, end)), body: lines.slice(end + 1).join("\n") };
}

function readTopLevelKeys(lines: string[]): Record<string, string> {
  // Null prototype, so a key such as `__proto__` is plain data.
  const data: Record<string, string> = Object.create(null);
  let index = 0;
  while (index < lines.length) {
    const match = TOP_LEVEL_KEY.exec(lines[index]);
    index++;
    if (!match) {
      continue;
    }
    const [, key, rest] = match;
    const continuation: string[] = [];
    while (index < lines.length && isContinuation(lines[index])) {
      continuation.push(lines[index].trim());
      index++;
    }
    data[key] = valueOf(withoutComment(rest.trim()), continuation);
  }
  return data;
}

// An indented or blank line belongs to the key above it.
function isContinuation(line: string): boolean {
  return line === "" || line.startsWith(" ") || line.startsWith("\t");
}

// A `>` or `|` value is its indented lines. A plain value takes any
// indented lines after it, folded onto one line, but never a list item or a
// comment, so `allowed-tools:` followed by a list stays empty.
function valueOf(value: string, continuation: string[]): string {
  if (BLOCK_SCALAR.test(value)) {
    return value.startsWith(">")
      ? continuation.filter((line) => line !== "").join(" ")
      : continuation.join("\n").trim();
  }
  const folded = continuation.filter(
    (line) => line !== "" && !line.startsWith("- ") && !line.startsWith("#"),
  );
  return [unquote(value), ...folded].filter((part) => part !== "").join(" ");
}

// YAML starts a comment with a `#` at the start of the value or after a
// space. After a quoted value, everything past the closing quote is dropped.
function withoutComment(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    return close === -1 ? value : value.slice(0, close + 1);
  }
  if (value.startsWith("#")) {
    return "";
  }
  const comment = value.indexOf(" #");
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]);
  return quoted ? value.slice(1, -1) : value;
}
