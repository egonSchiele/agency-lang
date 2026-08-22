import { describe, test, expect } from "vitest";
import { humanOutput, jsonOutput } from "./testOutput.js";
import { buildTestReport } from "./testReport.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writers: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) },
  };
}

describe("jsonOutput", () => {
  test("lines go to stderr; the document is the only thing on stdout, once", () => {
    const c = capture();
    const out = jsonOutput(c.writers);
    out.line("human");
    out.line("also human", "stdout");
    out.document(buildTestReport([]));
    expect(c.stdout).toEqual([`${JSON.stringify(buildTestReport([]))}\n`]);
    expect(c.stderr).toEqual(["human\n", "also human\n"]);
  });
});

describe("humanOutput", () => {
  test("lines go where they were asked to and no document is printed", () => {
    const c = capture();
    const out = humanOutput(c.writers);
    out.line("to stdout");
    out.line("to stderr", "stderr");
    out.document(buildTestReport([]));
    expect(c.stdout).toEqual(["to stdout\n"]);
    expect(c.stderr).toEqual(["to stderr\n"]);
  });
});
