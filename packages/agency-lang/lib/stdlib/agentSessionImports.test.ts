import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The agent's session program is run by front-ends that have no terminal
 * (see docs/dev/agents/session-core.md). Loading a module runs its
 * top-level code, so the program's imports must never reach the modules
 * that draw: `trace.agency`, for one, prints every tool call from a
 * top-level callback.
 */

const AGENT_DIR = path.resolve(__dirname, "../agents/agency-agent");

// The terminal front-end. Nothing the session program imports may reach these.
const TERMINAL_MODULES = [
  "agent.agency",
  "lib/repl.agency",
  "lib/capabilitiesUi.agency",
  "lib/mcpMenu.agency",
  "lib/header.agency",
  "lib/transcript.agency",
  "lib/args.agency",
  "lib/policy.agency",
  "lib/trace.agency",
  "lib/runSession.agency",
  "lib/resume.agency",
];

const TERMINAL_FOLDERS = ["lib/slashCommands/"];

const RELATIVE_IMPORT = /from\s+"(\.{1,2}\/[^"]+\.agency)"/g;

function isTerminalModule(file: string): boolean {
  return (
    TERMINAL_MODULES.includes(file) || TERMINAL_FOLDERS.some((folder) => file.startsWith(folder))
  );
}

/** The agent's own files a module imports, as paths under the agent's folder. */
function importsOf(file: string): string[] {
  const source = readFileSync(path.join(AGENT_DIR, file), "utf8");
  const fromDir = path.dirname(file);
  return [...source.matchAll(RELATIVE_IMPORT)].map((match) =>
    path.normalize(path.join(fromDir, match[1])),
  );
}

/** Every file reachable from `roots` through relative imports. */
function importClosure(roots: string[]): string[] {
  const seen: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.includes(file)) continue;
    seen.push(file);
    queue.push(...importsOf(file));
  }
  return seen;
}

function terminalModulesReachedFrom(roots: string[]): string[] {
  return importClosure(roots).filter(isTerminalModule).sort();
}

describe("the agent's session program reaches no terminal code", () => {
  it("has the files it starts from", () => {
    for (const root of ["lib/turn.agency", "lib/record.agency", "lib/sessionSearch.agency"]) {
      expect(existsSync(path.join(AGENT_DIR, root)), root).toBe(true);
    }
  });

  it("the session program reaches none", () => {
    expect(terminalModulesReachedFrom(["program.agency"])).toEqual([]);
  });

  // The list above is kept by hand. This catches a new module that would
  // run a callback in every front-end, whatever it is called.
  it("the session program reaches no module with a top-level callback", () => {
    const withCallbacks = importClosure(["program.agency"]).filter((file) =>
      /^callback\("/m.test(readFileSync(path.join(AGENT_DIR, file), "utf8")),
    );
    expect(withCallbacks).toEqual([]);
  });

  it("the session program does reach the turn and the record", () => {
    const reached = importClosure(["program.agency"]);
    expect(reached).toContain("core.agency");
    expect(reached).toContain("lib/turn.agency");
    expect(reached).toContain("lib/record.agency");
  });

  it("the turn, the record and the session search reach none", () => {
    expect(
      terminalModulesReachedFrom([
        "lib/turn.agency",
        "lib/record.agency",
        "lib/sessionSearch.agency",
      ]),
    ).toEqual([]);
  });
});
