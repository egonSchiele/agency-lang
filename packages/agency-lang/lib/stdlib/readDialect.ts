/**
 * What `cat`, `cat -n`, `head -n`, and `tail -n` print for a file's text.
 *
 * safeBash runs a lone read of one file through `_read` instead of the
 * program, so the approval it asks for means what the read tool's
 * approval means. These functions print the text the way the programs
 * do, with no file access. A parity test in tests/agency/safeBash.agency
 * compares each view with the real program.
 *
 * See docs/dev/stdlib/safe-bash.md, "The read family".
 */

/** How the shell-free path prints a file. Mirrors `ReadView` in
 * stdlib/safeBash/actions.agency, which must keep these fields. */
export type ReadView =
  | { kind: "whole" }
  | { kind: "numbered" }
  | { kind: "head"; lines: number }
  | { kind: "tail"; lines: number };

/** The text's lines, each keeping its `\n`. A last run with no `\n` is a
 * line too. Only `\n` ends a line, so a `\r` stays in its line. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line with its number right-aligned in six columns and a tab, the
 * format GNU and BSD `cat -n` share. */
function numbered(line: string, index: number): string {
  return `${String(index + 1).padStart(6, " ")}\t${line}`;
}

/** What cat, cat -n, head -n, or tail -n prints for `text`. */
export function _renderReadView(text: string, view: ReadView): string {
  switch (view.kind) {
    case "whole":
      return text;
    case "numbered":
      return linesOf(text).map(numbered).join("");
    case "head":
      return linesOf(text).slice(0, view.lines).join("");
    case "tail":
      return linesOf(text).slice(-view.lines).join("");
  }
}
