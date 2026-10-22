import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseResumeEdits, parseResumeOverrides } from "./resumeOverrides.js";

describe("parseResumeEdits", () => {
  it("takes each --edit as one edit and --edits as a file of them, in that order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agency-resume-edits-"));
    const file = path.join(dir, "edits.json");
    writeFileSync(file, JSON.stringify([{ op: "removeTool", tool: "search" }]));
    const edits = parseResumeEdits(
      { edit: ['{"op":"appendMessage","text":"stop"}'], edits: "edits.json" },
      dir,
    );
    expect(edits).toEqual([
      { op: "appendMessage", text: "stop" },
      { op: "removeTool", tool: "search" },
    ]);
    expect(parseResumeEdits({})).toEqual([]);
  });

  it("refuses an --edit that is not JSON, or not an edit, naming the reason", () => {
    expect(() => parseResumeEdits({ edit: ["{nope"] })).toThrow("--edit is not valid JSON");
    expect(() => parseResumeEdits({ edit: ['{"op":"bogus"}'] })).toThrow(
      /--edit is not an edit: op:/,
    );
    expect(() =>
      parseResumeEdits({ edit: ['{"op":"setLocal","name":"__proto__","value":1}'] }),
    ).toThrow("not a prototype key");
    expect(() => parseResumeEdits({ edits: "missing.json" }, tmpdir())).toThrow(
      "--edits could not read",
    );
  });
});

describe("parseResumeOverrides", () => {
  it("parses JSON values and falls back to strings", () => {
    const result = parseResumeOverrides({
      localVar: ["count=2", "label=hello"],
      arg: ["enabled=true"],
      globalVar: ['config={"mode":"safe"}'],
    });

    expect(result).toEqual({
      locals: { count: 2, label: "hello" },
      args: { enabled: true },
      globals: { config: { mode: "safe" } },
    });
    expect(Object.getPrototypeOf(result.locals!)).toBeNull();
  });

  it("keeps equals signs after the first one", () => {
    expect(parseResumeOverrides({ localVar: ["url=a=b"] }).locals).toEqual({ url: "a=b" });
  });

  it("rejects malformed assignments", () => {
    expect(() => parseResumeOverrides({ arg: ["missing"] })).toThrow("--arg expects name=value");
    expect(() => parseResumeOverrides({ globalVar: ["=value"] })).toThrow(
      "--global-var expects name=value",
    );
    expect(() => parseResumeOverrides({ localVar: ["__proto__=polluted"] })).toThrow(
      "invalid Agency variable name",
    );
  });
});
