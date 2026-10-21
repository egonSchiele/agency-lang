import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../compiler/defaultSession.js";
import type { SourceMap } from "./sourceMap.js";

/** The source map of a compiled program, read back from its output. */
function sourceMapOf(source: string): SourceMap {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-source-map-"));
  try {
    const file = path.join(dir, "prog.agency");
    fs.writeFileSync(file, source);
    const outputFile = compile({}, file, path.join(dir, "prog.ts"), { quiet: true });
    expect(outputFile).not.toBeNull();
    const output = fs.readFileSync(outputFile ?? "", "utf-8");
    const match = /const __sourceMap = (.*);/.exec(output);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the source map covers every statement", () => {
  it("records a compound assignment and a postfix increment, in a node and in a loop", () => {
    const map = sourceMapOf(
      [
        "node main() {",
        '  let story = ""',
        "  let count = 0",
        '  story += "once"',
        "  count++",
        "  for (i in range(2)) {",
        '    story += "more"',
        "    count++",
        "  }",
        "  return story",
        "}",
        "",
      ].join("\n"),
    );
    // The module id is the file's path relative to the working directory.
    const key = Object.keys(map).find((k) => k.endsWith("prog.agency:main"));
    expect(key).toBeDefined();
    const main = map[key ?? ""];
    // Every statement line of the program, the `+=` and `++` lines among
    // them, both in the node's body and in the loop's.
    const recorded = Object.values(main).map((loc) => loc.line + 1);
    for (const line of [2, 3, 4, 5, 6, 7, 8, 10]) {
      expect(recorded).toContain(line);
    }
  });
});
