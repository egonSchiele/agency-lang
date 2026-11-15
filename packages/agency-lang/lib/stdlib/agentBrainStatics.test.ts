import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAgencyFileCached } from "../parseCache.js";
import { walkNodes } from "../utils/node.js";
import type { AgencyNode } from "../types.js";

/**
 * A top-level variable is set before any of the program's own code runs: a
 * static when its module loads, a plain `let` or `const` when a run starts.
 * So every program that imports `std::agents/agency` runs the top-level
 * variables of the Agency agent's modules, and a handler in the program's
 * own code cannot see what they read. A top-level variable in those
 * modules may call only the functions listed here, each of which reads
 * nothing but the files packaged with Agency.
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

/** "file: NAME calls fn" for each top-level variable that calls an unlisted function. */
function unlistedCalls(file: string): string[] {
  return topLevelCalls(file)
    .filter((call) => !MAY_RUN_AT_LOAD.includes(call.name))
    .map((call) => `${path.relative(stdlib, file)}: ${call.variable} calls ${call.name}`);
}

/** Each function call in the initializer of a top-level variable, static or not. */
function topLevelCalls(file: string): { variable: string; name: string }[] {
  const parsed = parseAgencyFileCached(file);
  if (!parsed.success) {
    throw new Error(`failed to parse ${file}`);
  }
  return parsed.result.nodes.flatMap((node) =>
    node.type === "assignment"
      ? calledNames(node.value).map((name) => ({ variable: node.variableName, name }))
      : [],
  );
}

describe("the Agency agent's top-level variables", () => {
  it("are seen by this check", () => {
    const calls = topLevelCalls(path.join(stdlib, "agents", "brains", "coordinator.agency"));
    expect(calls).toContainEqual({ variable: "COORDINATOR_PROMPT", name: "agentPrompt" });
  });

  it("call only functions known to read nothing of the user's", () => {
    const files = [
      ...agencyFilesUnder(path.join(stdlib, "agents", "brains")),
      path.join(stdlib, "agents", "agency.agency"),
    ];
    expect(files.flatMap(unlistedCalls)).toEqual([]);
  });
});
