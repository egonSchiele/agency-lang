import { describe, expect, it } from "vitest";
import { inFrameOf, makeMockCtx } from "../runtime/__tests__/testHelpers.js";
import type { Command, HostSubprocess, RunOptions, RunResult } from "../host/host.js";
import { memoryHost, type MemoryHost } from "../host/memoryHost.js";
import { noDetachedProcesses } from "./__tests__/fakeSubprocess.js";
import { builtinEffectSets } from "../runtime/effectSets.js";
import {
  _spawn,
  _spawnCount,
  _spawnDepth,
  _spawnPaths,
  _spawnProblem,
  spawnCommand,
  spawnEnvironment,
  type SpawnQuestion,
} from "./spawn.js";

const HOME = "/home/me/.agency";
const SPAWN_DIR = `${HOME}/spawned/abc`;
/** The file `question()` starts. */
const PROGRAM = "/work/scripts/report.agency";

function question(changes: Partial<SpawnQuestion> = {}): SpawnQuestion {
  return {
    dir: "/work/scripts",
    filename: "report.agency",
    node: "main",
    args: [],
    policy: {},
    maxCost: null,
    maxTime: null,
    messageCount: 0,
    name: "report.agency",
    cwd: "/work",
    outputFile: `${SPAWN_DIR}/output.log`,
    depth: 1,
    ...changes,
  };
}

type Launch = { command: Command; options: RunOptions | undefined; filesThen: string[] };

/** A host whose subprocess part records each launch, and what files the
 *  host held at that moment, and answers with `result`. */
function hostThatLaunches(
  result: Partial<RunResult>,
  variables: Record<string, string> = {},
): { host: MemoryHost; launches: Launch[] } {
  const launches: Launch[] = [];
  const answer: RunResult = {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: null,
    timedOut: false,
    aborted: false,
    ...result,
  };
  const subprocess: HostSubprocess = {
    run: async (command, options) => {
      launches.push({ command, options, filesThen: Object.keys(host.state.files) });
      return answer;
    },
    start: async () => {
      throw new Error("spawn does not use start");
    },
    locate: async () => null,
    ...noDetachedProcesses,
  };
  const host = memoryHost({
    variables: { AGENCY_HOME: HOME, ...variables },
    files: { [PROGRAM]: "node main() {}" },
    subprocess,
    cwd: "/work",
  });
  return { host, launches };
}

/** Run `fn` as a stdlib helper is run: with a current run whose context
 *  has `host`. */
function withRun<T>(host: MemoryHost, fn: (ctx: { spawnCount: number }) => T): T {
  const ctx = makeMockCtx();
  ctx.host = host;
  ctx.spawnCount = 0;
  return inFrameOf(ctx, ctx.stateStack, () => fn(ctx));
}

const STARTED = 'report.agency → report.js (in 100ms)\n{"pid":4242,"outputFile":"x"}\n';

describe("spawnCommand", () => {
  it("writes every flag, in order, and `--` before the program's arguments", () => {
    const command = spawnCommand(
      question({ maxCost: 2.5, maxTime: 90_000, args: ["--verbose", "x"], name: "nightly" }),
      "/p/policy.json",
      true,
    );
    expect(command).toEqual([
      "run",
      "--detach",
      `${SPAWN_DIR}/output.log`,
      "--wait-for-response",
      "--policy",
      "/p/policy.json",
      "--name",
      "nightly",
      "--max-cost",
      "2.5",
      "--max-time",
      "90000ms",
      "--messages",
      "-",
      "/work/scripts/report.agency:main",
      "--",
      "--verbose",
      "x",
    ]);
  });

  it("leaves out the flags that have no value, and still waits for a response", () => {
    expect(spawnCommand(question(), null, false)).toEqual([
      "run",
      "--detach",
      `${SPAWN_DIR}/output.log`,
      "--wait-for-response",
      "--name",
      "report.agency",
      "/work/scripts/report.agency:main",
      "--",
    ]);
  });
});

// The target is `<file>:<node>`. A node that is not a plain name would
// make the command read another file than the one that was approved.
describe("a node name that would change the file", () => {
  const TRICKS = ["x/../../../tmp/evil.agency", "x:main", "", "a b", "-x"];

  it("is refused before the interrupt", () => {
    for (const node of TRICKS) {
      expect(_spawnProblem("report.agency", node, null, null)).toContain("is not a node name");
    }
    expect(_spawnProblem("report.agency", "main", null, null)).toBeNull();
  });

  it("is refused by the command builder too", () => {
    for (const node of TRICKS) {
      expect(() => spawnCommand(question({ node }), null, false)).toThrow("is not a node name");
    }
  });
});

// The compiled file is the source's name with `.agency` replaced, so a
// source named anything else would be written over by its own output.
describe("a file whose name does not end in .agency", () => {
  it("is refused before the interrupt", () => {
    for (const filename of ["report", "report.agency.txt", "notes.md"]) {
      expect(_spawnProblem(filename, "main", null, null)).toContain("is not an Agency file");
    }
  });
});

describe("the limits", () => {
  it("are checked before the interrupt", () => {
    expect(_spawnProblem("report.agency", "main", -1, null)).toContain("maxCost");
    expect(_spawnProblem("report.agency", "main", Number.NaN, null)).toContain("maxCost");
    expect(_spawnProblem("report.agency", "main", null, 0.2)).toContain("maxTime");
    expect(_spawnProblem("report.agency", "main", null, -5)).toContain("maxTime");
    expect(_spawnProblem("report.agency", "main", 0, 1)).toBeNull();
  });
});

// A rule that approves a set, such as Shell, must not approve a spawn.
describe("the effect sets", () => {
  it("leave std::spawn out of every set", () => {
    const sets = builtinEffectSets();
    expect(Object.keys(sets).length).toBeGreaterThan(0);
    expect(JSON.stringify(sets)).toContain("std::run");
    expect(JSON.stringify(sets)).not.toContain("std::spawn");
  });
});

describe("spawnEnvironment", () => {
  it("sets the depth, and drops what ties a process to its caller's run", () => {
    const env = spawnEnvironment(
      {
        PATH: "/bin",
        AGENCY_TRACE_ID: "callers-trace",
        AGENCY_CONFIG_OVERRIDES: '{"log":{"logFile":"callers.jsonl"}}',
        AGENCY_IPC: "1",
        AGENCY_IPC_MAX_PAYLOAD: "100",
        AGENCY_SPAWN_DEPTH: "1",
        OPENAI_API_KEY: "kept",
      },
      2,
    );
    expect(env).toEqual({ PATH: "/bin", OPENAI_API_KEY: "kept", AGENCY_SPAWN_DEPTH: "2" });
  });
});

describe("_spawnDepth and _spawnPaths", () => {
  it("is 0 for a program a person started, and the variable's value otherwise", () => {
    expect(withRun(hostThatLaunches({}).host, () => _spawnDepth())).toBe(0);
    const spawned = hostThatLaunches({}, { AGENCY_SPAWN_DEPTH: "3" }).host;
    expect(withRun(spawned, () => _spawnDepth())).toBe(3);
    const garbled = hostThatLaunches({}, { AGENCY_SPAWN_DEPTH: "many" }).host;
    expect(withRun(garbled, () => _spawnDepth())).toBe(0);
  });

  it("names a folder and an output file under the home, and creates nothing", () => {
    const { host } = hostThatLaunches({});
    const filesBefore = Object.keys(host.state.files);
    const dirsBefore = Object.keys(host.state.dirs);
    const paths = withRun(host, () => _spawnPaths(null, null));
    expect(paths.dir.startsWith(`${HOME}/spawned/`)).toBe(true);
    expect(paths.outputFile).toBe(`${paths.dir}/output.log`);
    expect(paths.cwd).toBe("/work");
    expect(Object.keys(host.state.files)).toEqual(filesBefore);
    expect(Object.keys(host.state.dirs)).toEqual(dirsBefore);
  });

  it("makes the caller's own output file and working directory absolute", () => {
    const { host } = hostThatLaunches({});
    const paths = withRun(host, () => _spawnPaths("logs/out.log", "sub"));
    expect(paths.outputFile).toBe("/work/logs/out.log");
    expect(paths.cwd).toBe("/work/sub");
  });
});

describe("_spawn", () => {
  it("starts the program without its caller's trace, and counts the start", async () => {
    const { host, launches } = hostThatLaunches(
      { stdout: STARTED },
      { AGENCY_TRACE_ID: "callers-trace", AGENCY_CONFIG_OVERRIDES: "{}" },
    );
    const count = await withRun(host, async (ctx) => {
      expect(_spawnCount()).toBe(0);
      expect(await _spawn(question(), [], SPAWN_DIR)).toEqual({ pid: 4242 });
      return ctx.spawnCount;
    });
    expect(count).toBe(1);
    const { command, options } = launches[0]!;
    expect(command.kind === "program" && command.args.slice(1, 3)).toEqual(["run", "--detach"]);
    expect(options?.cwd).toBe("/work");
    expect(options?.env).toMatchObject({ AGENCY_SPAWN_DEPTH: "1" });
    expect(options?.env).not.toHaveProperty("AGENCY_TRACE_ID");
    expect(options?.env).not.toHaveProperty("AGENCY_CONFIG_OVERRIDES");
    expect(options?.input).toBeUndefined();
  });

  it("sends the messages on standard input, and writes them to no file", async () => {
    const { host, launches } = hostThatLaunches({ stdout: STARTED });
    const messages = [{ role: "user", content: "a secret plan" }];
    await withRun(host, () => _spawn(question({ messageCount: 1 }), messages, SPAWN_DIR));
    const { command, options, filesThen } = launches[0]!;
    expect(options?.input).toBe(JSON.stringify(messages));
    expect(command.kind === "program" && command.args).toContain("--messages");
    const held = [...filesThen, ...Object.keys(host.state.files)];
    for (const file of held) {
      expect(new TextDecoder().decode(host.state.files[file] ?? new Uint8Array())).not.toContain(
        "a secret plan",
      );
    }
  });

  it("hands the policy over in a file that is gone afterwards", async () => {
    const { host, launches } = hostThatLaunches({ stdout: STARTED });
    const policy = { "test::ask": [{ action: "approve" as const }] };
    await withRun(host, () => _spawn(question({ policy }), [], SPAWN_DIR));
    const { command, filesThen } = launches[0]!;
    expect(filesThen).toContain(`${SPAWN_DIR}/policy.json`);
    expect(command.kind === "program" && command.args).toContain(`${SPAWN_DIR}/policy.json`);
    expect(Object.keys(host.state.files)).not.toContain(`${SPAWN_DIR}/policy.json`);
  });

  it("writes no policy file for a policy with no rules", async () => {
    const { host, launches } = hostThatLaunches({ stdout: STARTED });
    await withRun(host, () => _spawn(question(), [], SPAWN_DIR));
    expect(launches[0]!.filesThen).toEqual([PROGRAM]);
    expect(launches[0]!.command.kind === "program" && launches[0]!.command.args).not.toContain(
      "--policy",
    );
  });

  it("makes no folder when the caller gave the output file and the policy has no rules", async () => {
    const { host } = hostThatLaunches({ stdout: STARTED });
    await withRun(host, () =>
      _spawn(question({ outputFile: "/work/logs/out.log" }), [], SPAWN_DIR),
    );
    expect(Object.keys(host.state.dirs)).not.toContain(SPAWN_DIR);
  });

  it("throws the end of the error output on a failed start, counts nothing, and removes the policy", async () => {
    const { host } = hostThatLaunches({ exitCode: 1, stderr: "report.agency: syntax error" });
    const policy = { "test::ask": [{ action: "approve" as const }] };
    const count = await withRun(host, async (ctx) => {
      await expect(_spawn(question({ policy }), [], SPAWN_DIR)).rejects.toThrow(
        "Could not start report.agency: report.agency: syntax error",
      );
      return ctx.spawnCount;
    });
    expect(count).toBe(0);
    expect(Object.keys(host.state.files)).toEqual([PROGRAM]);
  });

  // An approval can take a while. The file is checked again after it.
  it("starts nothing when the approved file is gone by the time it is approved", async () => {
    const { host, launches } = hostThatLaunches({ stdout: STARTED });
    delete host.state.files[PROGRAM];
    await withRun(host, async () => {
      await expect(_spawn(question(), [], SPAWN_DIR)).rejects.toThrow(
        "report.agency is not a file in /work/scripts.",
      );
    });
    expect(launches).toEqual([]);
  });

  // The command may have started the program before it was stopped.
  it("counts a start whose command timed out, and still fails", async () => {
    const { host } = hostThatLaunches({ exitCode: null, timedOut: true });
    const count = await withRun(host, async (ctx) => {
      await expect(_spawn(question(), [], SPAWN_DIR)).rejects.toThrow("took too long");
      return ctx.spawnCount;
    });
    expect(count).toBe(1);
  });

  it("throws when the command reports no pid", async () => {
    const { host } = hostThatLaunches({ stdout: "something else\n" });
    await withRun(host, async () => {
      await expect(_spawn(question(), [], SPAWN_DIR)).rejects.toThrow("did not report a pid");
    });
  });
});
