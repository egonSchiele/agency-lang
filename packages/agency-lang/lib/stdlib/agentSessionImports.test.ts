import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * The session driver (lib/stdlib/agentDriver) is TypeScript that every
 * front-end loads, an app's engine included. So its imports, followed
 * through every TypeScript file they reach, must not reach the terminal
 * either: not the agent's terminal modules, not the REPL's TypeScript, and
 * not the agency CLI. And it is agency-lang's own: nothing of a front-end's.
 */
const LIB_DIR = path.resolve(__dirname, "..");
const DRIVER_DIR = path.join(LIB_DIR, "stdlib/agentDriver");

// The REPL's TypeScript and the agency CLI, as paths under lib/.
const TERMINAL_TS = ["stdlib/cli.ts", "stdlib/cliCompleter.ts", "stdlib/cliEditor.ts"];
const TERMINAL_TS_FOLDERS = ["cli/"];

// `import … from "x"`, `export … from "x"` and `import "x"`.
const TS_IMPORT = /^(?:(?:import|export)\b[^;]*?\bfrom\s+|import\s+)"([^"]+)"/gm;

type TsWalk = { tsFiles: string[]; agencyModules: string[]; packages: string[] };

/** Where a relative import in `from` points, as a path under lib/: a
 *  TypeScript file, or a compiled Agency module of the agent. */
function resolveTsImport(from: string, spec: string): string {
  const target = path.normalize(path.join(path.dirname(from), spec));
  const asTs = target.replace(/\.js$/, ".ts");
  return existsSync(path.join(LIB_DIR, asTs)) ? asTs : target;
}

/** Every file of lib/ reachable from `roots` (paths under lib/) through
 *  TypeScript imports, the agent's Agency modules they reach, and every
 *  package they name. */
function tsClosure(roots: string[]): TsWalk {
  const walk: TsWalk = { tsFiles: [], agencyModules: [], packages: [] };
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (walk.tsFiles.includes(file)) continue;
    walk.tsFiles.push(file);
    const source = readFileSync(path.join(LIB_DIR, file), "utf8");
    for (const match of source.matchAll(TS_IMPORT)) {
      const spec = match[1];
      if (!spec.startsWith(".")) {
        walk.packages.push(spec);
        continue;
      }
      const target = resolveTsImport(file, spec);
      if (target.startsWith("agents/agency-agent/")) {
        walk.agencyModules.push(
          target.slice("agents/agency-agent/".length).replace(/\.js$/, ".agency"),
        );
      } else if (target.endsWith(".ts")) {
        queue.push(target);
      }
    }
  }
  return walk;
}

function driverWalk(): TsWalk {
  const roots = readdirSync(DRIVER_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => `stdlib/agentDriver/${file}`);
  return tsClosure(roots);
}

describe("the session driver reaches no terminal code", () => {
  const walk = driverWalk();

  it("walks the driver's files and what they import", () => {
    expect(walk.tsFiles).toContain("stdlib/agentDriver/index.ts");
    expect(walk.tsFiles).toContain("stdlib/agentSessions.ts");
  });

  it("reaches none of the agent's terminal modules", () => {
    expect(terminalModulesReachedFrom(walk.agencyModules)).toEqual([]);
  });

  it("reaches none of the REPL's TypeScript or the agency CLI", () => {
    const terminal = walk.tsFiles.filter(
      (file) =>
        TERMINAL_TS.includes(file) || TERMINAL_TS_FOLDERS.some((folder) => file.startsWith(folder)),
    );
    expect(terminal).toEqual([]);
  });

  it("imports nothing of Perry's", () => {
    expect(walk.packages.filter((spec) => /perry/i.test(spec))).toEqual([]);
  });
});
