import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config/config.js";

/** Type-check `main.agency` in a temp directory that also holds `others`,
 *  so a test can import a function from a second file. */
function checkFiles(
  main: string,
  others: Record<string, string>,
  config: AgencyConfig,
): TypeCheckError[] {
  const parsed = parseAgency(main);
  if (!parsed.success) {
    throw new Error(`parse failed: ${(parsed as { message?: string }).message ?? "unknown"}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-platform-"));
  try {
    for (const [name, text] of Object.entries(others)) {
      fs.writeFileSync(path.join(dir, name), text);
    }
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, main);
    const symbols = SymbolTable.build(file, config);
    const info = buildCompilationUnit(parsed.result, symbols, file, main);
    return typeCheck(parsed.result, config, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const browser: AgencyConfig = { platform: "browser" };

function platformErrors(main: string, others: Record<string, string> = {}): string[] {
  return checkFiles(main, others, browser)
    .filter((error) => error.code === "AG3029")
    .map((error) => error.message);
}

describe("the platform check", () => {
  it("refuses a node that calls read when the platform is the browser", () => {
    const [message] = platformErrors('node main() {\n  const text = read("notes.txt")\n}');
    expect(message).toContain(
      "Node 'main' needs the fileRead capability, which the browser platform does not have.",
    );
    expect(message).toContain(
      "main calls read from std::index (main.agency:2), which needs fileRead",
    );
  });

  it("passes a program that never calls read", () => {
    expect(platformErrors('node main() {\n  print("hello")\n}')).toEqual([]);
  });

  it("does nothing on the default platform", () => {
    const errors = checkFiles('node main() {\n  const text = read("notes.txt")\n}', {}, {});
    expect(errors.filter((error) => error.code === "AG3029")).toEqual([]);
  });

  it("follows a call through a function of the same file", () => {
    const [message] = platformErrors(
      'def loadNotes(): string {\n  return read("notes.txt")\n}\n\nnode main() {\n  const notes = loadNotes()\n}',
    );
    expect(message).toContain("main calls loadNotes (main.agency:6)");
    expect(message).toContain(
      "loadNotes calls read from std::index (main.agency:2), which needs fileRead",
    );
  });

  it("follows a call through an imported function and names its file", () => {
    const [message] = platformErrors(
      'import { loadNotes } from "./notes.agency"\n\nnode main() {\n  const notes = loadNotes()\n}',
      { "notes.agency": 'export def loadNotes(): string {\n  return read("notes.txt")\n}' },
    );
    expect(message).toContain(
      "main calls loadNotes from notes.agency (main.agency:4), which needs fileRead",
    );
  });

  it("reports an exported function, and not one the file keeps to itself", () => {
    const messages = platformErrors(
      'def helper(): string {\n  return read("a")\n}\n\nexport def loadNotes(): string {\n  return helper()\n}',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Function 'loadNotes' needs the fileRead capability");
    expect(messages[0]).toContain("loadNotes calls helper (main.agency:6)");
    expect(messages[0]).toContain("helper calls read from std::index (main.agency:2)");
  });

  it("sees a tool handed to llm", () => {
    const [message] = platformErrors(
      'node main() {\n  const answer = llm("read the notes", { tools: [read] })\n}',
    );
    expect(message).toContain("Node 'main' needs the fileRead capability");
    expect(message).toContain("main calls read from std::index (main.agency:2)");
  });

  it("sees a function stored in a variable and passed on", () => {
    const [message] = platformErrors(
      'node main() {\n  const reader = read\n  const texts = map(["a", "b"], reader)\n}',
    );
    expect(message).toContain("Node 'main' needs the fileRead capability");
    expect(message).toContain("main calls read from std::index (main.agency:2)");
  });

  it("sees a function received as a parameter and called", () => {
    const [message] = platformErrors(
      'def through(f: (name: string, dir: string, offset: number, limit: number, useAgentCwd: boolean) => Result<string>): string {\n  return f("a", "", 0, 0, true)\n}\n\nnode main() {\n  const text = through(read)\n}',
    );
    expect(message).toContain("Node 'main' needs the fileRead capability");
  });

  it("sees a function made with .partial and passed to map", () => {
    const [message] = platformErrors(
      'node main() {\n  const reader = read.partial(dir: "/tmp")\n  const texts = map(["a", "b"], reader)\n}',
    );
    expect(message).toContain("Node 'main' needs the fileRead capability");
  });

  it("still refuses a call inside with approve", () => {
    const [message] = platformErrors(
      'node main() {\n  const text = read("notes.txt") with approve\n}',
    );
    expect(message).toContain("Node 'main' needs the fileRead capability");
  });

  it("names the node when its own tag carries the capability", () => {
    const [message] = platformErrors('@capabilities(subprocess)\nnode main() {\n  print("x")\n}');
    expect(message).toContain("Node 'main' needs the subprocess capability");
    expect(message).toContain("main is tagged subprocess (main.agency)");
  });

  it("follows a call to a tagged function of the same file", () => {
    const [message] = platformErrors(
      '@capabilities(subprocess)\ndef which(name: string): string {\n  return name\n}\n\nnode main() {\n  const p = which("ls")\n}',
    );
    expect(message).toContain("Node 'main' needs the subprocess capability");
    expect(message).toContain("main calls which (main.agency:7)");
    expect(message).toContain("which is tagged subprocess (main.agency)");
  });

  it("reports each missing capability once, and not one the browser has", () => {
    const messages = platformErrors(
      '@capabilities(fileRead, env, subprocess)\ndef git(): string {\n  return "x"\n}\n\nnode main() {\n  const s = git()\n}',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("needs the fileRead capability");
    expect(messages[1]).toContain("needs the subprocess capability");
  });

  it("lets an effect the browser can serve through", () => {
    expect(platformErrors('node main() {\n  const home = env("HOME")\n}')).toEqual([]);
  });
});
