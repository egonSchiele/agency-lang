import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAgencyFileCached } from "../parseCache.js";
import { walkNodes } from "../utils/node.js";
import { getImportedNames } from "../types/importStatement.js";
import type { AgencyNode, AgencyProgram } from "../types.js";

/**
 * A static runs when its module loads, so every program that imports
 * `std::agents/agency` runs the statics of the Agency agent's modules. A
 * handler in the program's own code cannot see those reads. This test reads
 * the source instead: no static in those modules may call a function that
 * reads files or the environment, except `agentPrompt` and `agentSkill`,
 * which read only the files packaged with Agency.
 *
 * The check sees a call written directly in a static's initializer. It does
 * not see a read inside a helper that the static calls. The plan's rule that
 * the stdlib brains read no file outside the packaged prompts and skills
 * covers that case.
 */
const READERS = [
  "read",
  "readBinary",
  "exists",
  "ls",
  "glob",
  "grep",
  "skillsDir",
  "commandsDir",
  "env",
];

const stdlib = path.join(process.cwd(), "stdlib");

function agencyFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return agencyFilesUnder(full);
    }
    return entry.name.endsWith(".agency") ? [full] : [];
  });
}

/** The names a program imports from `std::fs`. */
function fsImports(program: AgencyProgram): string[] {
  return program.nodes.flatMap((node) =>
    node.type === "importStatement" && node.modulePath === "std::fs"
      ? node.importedNames.flatMap(getImportedNames)
      : [],
  );
}

/** The functions called anywhere in a static's initializer. */
function calledNames(value: AgencyNode): string[] {
  const names: string[] = [];
  for (const { node } of walkNodes([value])) {
    if (node.type === "functionCall") {
      names.push(node.functionName);
    }
  }
  return names;
}

/** "file: NAME calls fn" for each static that calls a reader. */
function readingStatics(file: string): string[] {
  const parsed = parseAgencyFileCached(file);
  if (!parsed.success) {
    throw new Error(`failed to parse ${file}`);
  }
  const forbidden = [...READERS, ...fsImports(parsed.result)];
  const found: string[] = [];
  for (const { node } of walkNodes(parsed.result.nodes)) {
    if (node.type !== "assignment" || !node.static) {
      continue;
    }
    for (const name of calledNames(node.value)) {
      if (forbidden.includes(name)) {
        found.push(`${path.relative(stdlib, file)}: ${node.variableName} calls ${name}`);
      }
    }
  }
  return found;
}

describe("the Agency agent's stdlib statics", () => {
  it("read no file or environment variable when the module loads", () => {
    const files = [
      ...agencyFilesUnder(path.join(stdlib, "agents", "brains")),
      path.join(stdlib, "agents", "agency.agency"),
    ];
    expect(files.flatMap(readingStatics)).toEqual([]);
  });
});
