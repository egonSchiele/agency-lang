// The `where` summary and the readers on a checkpoint the driver really
// drew: the step-test fixture stopped at its second statement, captured
// through a scripted IO, with the source map read from the compiled file
// as text.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { DebuggerDriver } from "@/debugger/driver.js";
import { TestDebuggerIO, fixtureDir, freshImport } from "@/debugger/testHelpers.js";
import { checkpointToWire } from "@/debugger/attach/channelIO.js";
import { checkpointFromWire } from "@/debugger/attach/serveIO.js";
import type { DebuggerCommand } from "@/debugger/types.js";
import type { Checkpoint } from "@/runtime/state/checkpointStore.js";
import type { DebugStopData } from "@/runtime/debugger.js";
import {
  lineFor,
  objectLiteralAfter,
  readSourceMap,
  sourceAround,
  sourcePathFor,
  stackOf,
} from "./readers.js";
import { runningText, whereJson, whereText } from "./where.js";

const fixture = "step-test";
const compiled = path.join(fixtureDir, `${fixture}.ts`);
const packageRoot = path.resolve(fixtureDir, "../..");

beforeAll(() => {
  compile({}, path.join(fixtureDir, `${fixture}.agency`), compiled, { ts: true });
});

/** The stops the driver showed on a run of the fixture, each with its
 *  checkpoint. */
async function stops(): Promise<{ checkpoint: Checkpoint; stop: DebugStopData }[]> {
  const mod = await freshImport(compiled);
  const seen: { checkpoint: Checkpoint; stop: DebugStopData }[] = [];
  const io = new (class extends TestDebuggerIO {
    override async render(checkpoint?: Checkpoint, stop?: DebugStopData): Promise<void> {
      await super.render(checkpoint, stop);
      // As the CLI gets it: over the wire and rebuilt.
      if (checkpoint && stop) {
        seen.push({ checkpoint: checkpointFromWire(checkpointToWire(checkpoint))!, stop });
      }
    }
  })([{ type: "step" }, { type: "step" }, { type: "continue" }] as DebuggerCommand[]);
  const driver = new DebuggerDriver({
    mod: {
      respondToInterrupts: mod.respondToInterrupts,
      respondToInterruptsForServe: mod.__respondToInterruptsForServe,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getDebugger: mod.__getDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    rewindSize: 30,
    ui: io,
    attached: true,
  });
  driver.attach();
  await mod.main();
  return seen;
}

const parties = { type: "parties" as const, terminal: false, cli: true };

describe("where", () => {
  it("names the stop with its line and statement, the stack, the usage, and what to do next", async () => {
    const [, second] = await stops();
    const map = readSourceMap(compiled);
    const line = lineFor(map, second!.stop);
    expect(line).toBe(3);
    const sourcePath = sourcePathFor(second!.stop.moduleId, packageRoot, compiled);
    expect(sourcePath).not.toBeNull();
    const statement = sourceAround(sourcePath!, line!, 0)!.lines[0];

    const text = whereText({
      program: "agent.js",
      node: "main",
      pid: 4242,
      parties,
      recent: ["cli: step"],
      edits: [],
      checkpoint: second!.checkpoint,
      stop: second!.stop,
      line,
      statement,
      interruptId: undefined,
    });
    expect(text.split("\n")).toEqual([
      "agent.js · node main · pid 4242",
      "stopped in main · tests/debugger/step-test.agency:3",
      "  y = 2",
      "stack   main",
      "usage   0 tokens · $0.00",
      "since   cli: step",
      "next    step, next, continue, frame, thread, branches, guards, edit, detach",
    ]);
  });

  it("says when a terminal is attached too, and gives the same facts as JSON", async () => {
    const [first] = await stops();
    const input = {
      program: "agent.js",
      node: "main",
      pid: 4242,
      parties: { ...parties, terminal: true },
      recent: [],
      edits: [],
      checkpoint: first!.checkpoint,
      stop: first!.stop,
      line: undefined,
      statement: undefined,
      interruptId: undefined,
    };
    expect(whereText(input)).toContain("a terminal debugger is attached too");
    expect(whereText(input)).toContain("stopped in main · tests/debugger/step-test.agency\n");
    const json = whereJson(input);
    expect(json.stop).toEqual({
      scope: "main",
      label: null,
      moduleId: "tests/debugger/step-test.agency",
      line: null,
      statement: null,
      depth: 0,
      branchPath: [],
    });
    expect(json.stack.map((frame) => frame.name)).toEqual(["main"]);
    expect(json.parties).toEqual({ terminal: true, cli: true });
  });

  it("the running line names the program and the way to a stop", () => {
    expect(runningText("agent.js", 4242, parties)).toBe(
      "agent.js · pid 4242 is running; wait stops here at its next stop",
    );
  });
});

describe("the readers", () => {
  it("the stack's frames carry their locals", async () => {
    const [, , third] = await stops();
    const frames = stackOf(third!.checkpoint, []);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.name).toBe("main");
    expect(frames[0]!.locals).toMatchObject({ x: 1, y: 2 });
    expect(frames[0]!.locals).not.toHaveProperty("z");
  });

  it("finds a map laid out over several lines, as the run strategy writes it", () => {
    const text =
      'x;\nconst __sourceMap = {\n  "m:main": { "1": { "line": 3, "col": 2 } }\n};\nexport { __sourceMap };';
    expect(objectLiteralAfter(text, "__sourceMap = ")).toBe(
      '{\n  "m:main": { "1": { "line": 3, "col": 2 } }\n}',
    );
    expect(objectLiteralAfter('a = { "k": "}" }', "a = ")).toBe('{ "k": "}" }');
    expect(objectLiteralAfter("nothing here", "__sourceMap = ")).toBeNull();
  });

  it("a compiled file with no map, or none at all, gives no line", () => {
    expect(readSourceMap(path.join(fixtureDir, "missing.js"))).toBeNull();
    expect(
      lineFor(null, { moduleId: "m", scopeName: "s", stepPath: "1", branchPath: [], depth: 0 }),
    ).toBeUndefined();
  });
});
