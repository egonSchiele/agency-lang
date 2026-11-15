import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAgencyFileCached } from "../parseCache.js";
import { walkNodes } from "../utils/node.js";
import type { AgencyNode } from "../types.js";

/**
 * A static runs when its module loads, so every program that imports
 * `std::agents/agency` runs the statics of the Agency agent's modules. A
 * handler in the program's own code cannot see what they read. So a static
 * in those modules may call only the functions listed here, each of which
 * reads nothing but the files packaged with Agency.
 *
 * Before adding a name, read the function and everything it calls. A
 * function that reads the user's files or the environment does not belong
 * here: call it inside a function instead. `searchTools`, and `buildTools`
 * in the agents that include it, read the search API keys.
 */
const MAY_RUN_AT_LOAD = [
  // Read a prompt or a skill from the packaged files.
  "agentPrompt",
  "agentSkill",
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

/** "file: NAME calls fn" for each static that calls an unlisted function. */
function unlistedCalls(file: string): string[] {
  const parsed = parseAgencyFileCached(file);
  if (!parsed.success) {
    throw new Error(`failed to parse ${file}`);
  }
  const found: string[] = [];
  for (const { node } of walkNodes(parsed.result.nodes)) {
    if (node.type !== "assignment" || !node.static) {
      continue;
    }
    for (const name of calledNames(node.value)) {
      if (!MAY_RUN_AT_LOAD.includes(name)) {
        found.push(`${path.relative(stdlib, file)}: ${node.variableName} calls ${name}`);
      }
    }
  }
  return found;
}

describe("the Agency agent's stdlib statics", () => {
  it("call only functions known to read nothing of the user's", () => {
    const files = [
      ...agencyFilesUnder(path.join(stdlib, "agents", "brains")),
      path.join(stdlib, "agents", "agency.agency"),
    ];
    expect(files.flatMap(unlistedCalls)).toEqual([]);
  });
});
