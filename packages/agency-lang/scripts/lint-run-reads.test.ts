import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// The check is a script, so these tests run it as one, over the fixture
// projects in tests/lint-run-reads/.
const script = path.resolve(__dirname, "lint-run-reads.mjs");
const fixtures = path.resolve(__dirname, "../tests/lint-run-reads");

function runCheck(project: string): { status: number | null; output: string } {
  const result = spawnSync("node", [script, "--project", path.join(fixtures, project)], {
    encoding: "utf-8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

/** The `file:line` of every line in `file` marked `// expect: reported`. */
function markedLines(project: string, file: string): string[] {
  const lines = fs.readFileSync(path.join(fixtures, project, file), "utf-8").split("\n");
  return lines
    .map((line, index) => (line.includes("// expect: reported") ? `${file}:${index + 1}` : ""))
    .filter((location) => location !== "");
}

/** The `file:line` locations the check printed. Each is on a line of its own. */
function reportedLocations(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /^lib\/[\w/.]+:\d+$/.test(line))
    .sort();
}

describe("lint-run-reads", () => {
  const result = runCheck("project");

  it("fails when code can read the run after an await", () => {
    expect(result.status).toBe(1);
  });

  it("reports every marked line and nothing else", () => {
    const marked = markedLines("project", "lib/reported.ts").sort();
    expect(marked.length).toBe(5);
    expect(reportedLocations(result.output)).toEqual(marked);
  });

  it("leaves a first-line read and an opted-out read alone", () => {
    expect(result.output).not.toContain("lib/allowed.ts");
  });

  it("fails when it finds no reader functions to follow", () => {
    // Without this, renaming the file the readers live in would make the
    // check pass for any code at all.
    const noReaders = runCheck("no-readers");
    expect(noReaders.status).toBe(1);
    expect(noReaders.output).toContain("found no call to currentRun");
  });
});
