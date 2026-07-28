import { describe, it, expect } from "vitest";
import { _bashParser, _astToBash } from "./safeBash.js";

/** Drop `loc` fields so two trees compare on structure, not on where the
 *  text happened to sit. Rendering re-flows whitespace, so positions
 *  legitimately differ between the original and the re-parsed form. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "loc") continue;
    out[k] = strip(v);
  }
  return out;
}

// Every command family the classifier recognizes, plus the hostile
// quoting cases that would turn one command into two if rendering lost a
// quote.
const CORPUS = [
  "echo hello",
  "echo hello world",
  "echo 'a  b'",
  'echo "a b" c',
  "echo a'b'\"c\"",
  'echo "a; rm -rf /tmp/x"',
  'echo "a\\"b"',
  "echo $HOME",
  'echo "$HOME"/bin',
  "echo hi > out.txt",
  "echo hi >> out.txt",
  'echo hi > "my file.txt"',
  "git status",
  "git log",
  "git diff",
  "git diff --staged",
  "git log --format=oneline",
  "git checkout .",
  "ls -la",
  "cat src/main.ts",
  "git status; git log",
  "git status && git log",
  "git status || git log",
  "(git status && git log)",
];

describe("astToBash round-trips every command family the classifier sees", () => {
  // This is security-critical: when every command is recognized, bash is
  // handed a string rendered from the tree rather than the agent's text.
  // If rendering is lossy, we run something other than what we classified.
  for (const source of CORPUS) {
    it(`round-trips ${JSON.stringify(source)}`, () => {
      const first = _bashParser(source);
      expect(first.success, `corpus entry did not parse: ${source}`).toBe(true);
      if (!first.success) return;

      const rendered = first.result.map((c: unknown) => _astToBash(c)).join("; ");
      const second = _bashParser(rendered);
      expect(second.success, `rendered form did not re-parse: ${rendered}`).toBe(true);
      if (!second.success) return;

      // Compare the TREES, not the rendered strings. A string fixed point
      // passes on exactly the failure this test exists to catch: if
      // rendering lost the quotes, `echo "a; b"` renders to `echo a; b`,
      // which re-parses as TWO commands, which re-render (joined with
      // "; ") to the same string. Green test, one command became two.
      expect(strip(second.result)).toEqual(strip(first.result));
    });
  }
});
