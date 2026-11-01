// `agency debug --attach`: the listing, the refusals, and one real
// session against a program running in a child process.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { nodeHost } from "@/host/node/nodeHost.js";
import {
  ensureSessionsDir,
  listRecords,
  recordPaths,
  removeStale,
  sessionsDir,
  writeRecord,
} from "@/debugger/attach/registry.js";
import { fixtureDir } from "@/debugger/testHelpers.js";
import { TestInput } from "@/debugger/testSession.js";
import { DebuggerUI } from "@/debugger/ui.js";
import { FrameRecorder, Screen } from "@/tui/index.js";
import { RunStrategy } from "@/importStrategy.js";
import { attachTarget } from "./debugFlags.js";
import {
  EARLY_START_LIMIT_MS,
  LATER_START_KEEP_MS,
  START_TIME_TOLERANCE_MS,
  attachCommand,
  checkedRecord,
  finishedLine,
  formatListing,
  liveStartTime,
  parseStartTime,
} from "./attach.js";

describe("the --attach flag", () => {
  it("is debug mode when absent, a listing when bare, and a pid otherwise", () => {
    expect(attachTarget({ file: "a.agency" })).toEqual({ mode: "debug" });
    expect(attachTarget({ attach: true })).toEqual({ mode: "attach" });
    expect(attachTarget({ attach: "4242" })).toEqual({ mode: "attach", pid: 4242 });
  });

  it("refuses a file with --attach and a pid that is not one", () => {
    expect(attachTarget({ attach: "42", file: "a.agency" })).toMatchObject({
      refused: expect.stringContaining("takes a pid"),
    });
    for (const notAPid of ["forty", "0x10", "1e3", " 42", "0", "-3"]) {
      expect(attachTarget({ attach: notAPid })).toMatchObject({
        refused: expect.stringContaining("needs a process id"),
      });
    }
  });

  it("refuses the run and debug flags with --attach", () => {
    expect(attachTarget({ attach: "42", others: ["--policy"] })).toMatchObject({
      refused:
        "--policy does not apply with --attach; the program keeps the options it was started with.",
    });
    expect(attachTarget({ attach: true, others: ["--rewind-size", "--trace"] })).toMatchObject({
      refused: expect.stringContaining("--rewind-size, --trace do not apply"),
    });
    expect(attachTarget({ attach: "42", others: [] })).toEqual({ mode: "attach", pid: 42 });
  });
});

describe("the listing", () => {
  it("prints a table with the time since each start", () => {
    const now = 1_700_000_000_000;
    const text = formatListing(
      [
        { pid: 48213, program: "agent.agency", node: "main", startedAt: now - 252_000 },
        { pid: 51002, program: "research.agency", node: "run", startedAt: now - 38_000 },
      ],
      now,
    );
    expect(text.split("\n")).toEqual([
      "  PID    PROGRAM          NODE  STARTED",
      "  48213  agent.agency     main  4m12s ago",
      "  51002  research.agency  run   38s ago",
    ]);
  });

  it("shows a program under the current directory relative to it", () => {
    const text = formatListing(
      [
        { pid: 1, program: "/home/me/project/agent.js", node: "main", startedAt: 0 },
        { pid: 2, program: "/tmp/agency-only-x/script.js", node: "main", startedAt: 0 },
      ],
      1000,
      "/home/me/project",
    );
    expect(text).toContain("  1    agent.js ");
    expect(text).toContain("  2    /tmp/agency-only-x/script.js ");
  });

  it("says so when nothing is running", () => {
    expect(formatListing([], 0)).toContain("No running Agency programs");
  });
});

describe("the start time from ps", () => {
  it("reads the C-locale lstart format as UTC, and nothing else", () => {
    expect(parseStartTime("Tue Oct 20 13:32:26 2026\n")).toBe(Date.UTC(2026, 9, 20, 13, 32, 26));
    // The repeated hour on the night the clocks go back is no longer
    // ambiguous: UTC has no such hour.
    expect(parseStartTime("Sun Nov  1 07:30:00 2026")).toBe(Date.UTC(2026, 10, 1, 7, 30, 0));
    expect(parseStartTime("")).toBeNull();
    expect(parseStartTime("not a date")).toBeNull();
    // What ps prints under LANG=de_DE.UTF-8 on macOS.
    expect(parseStartTime("Di. 20 Okt. 15:47:40 2026\n")).toBeNull();
  });

  it("asks ps in the C locale, whatever the user's language", () => {
    const previous = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    process.env.LANG = "de_DE.UTF-8";
    delete process.env.LC_ALL;
    try {
      const live = liveStartTime(process.pid);
      expect(live).toHaveProperty("started");
      const started = (live as { started: number }).started;
      expect(Math.abs(started - performance.timeOrigin)).toBeLessThan(START_TIME_TOLERANCE_MS);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("prints the value, or the error the run ended with", () => {
    expect(finishedLine(3, undefined)).toBe("Program finished. Return value: 3");
    expect(finishedLine(undefined, undefined)).toBe("Program finished. Return value: undefined");
    expect(finishedLine(undefined, "x")).toBe("Program threw: x");
    expect(
      finishedLine({ __type: "resultType", success: false, error: "kaboom", data: {} }, undefined),
    ).toBe("Program failed: kaboom");
  });

  it("says why when ps cannot answer", () => {
    // ps exits non-zero for a pid no process has.
    expect(liveStartTime(2_000_000_000)).toMatchObject({
      failed: expect.stringContaining("could not run ps"),
    });
  });
});

describe("checking a record before signalling", () => {
  let dir: string;
  beforeAll(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-")), "debug-sessions");
    ensureSessionsDir(dir);
  });
  afterAll(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("refuses an unknown pid", () => {
    expect(checkedRecord(dir, 2_000_000_000)).toMatchObject({
      refused: expect.stringContaining("is registered for attach"),
    });
  });

  it("refuses and removes the record of a process that is gone", () => {
    const gone = 2_000_000_000;
    writeRecord(dir, { pid: gone, program: "a.agency", node: "main", startedAt: Date.now() });
    expect(checkedRecord(dir, gone)).toMatchObject({
      refused: expect.stringContaining("is not running"),
    });
    expect(fs.existsSync(path.join(dir, `${gone}.json`))).toBe(false);
  });

  it("refuses and removes a record written long before the live process started", () => {
    const stale = performance.timeOrigin - 2 * LATER_START_KEEP_MS;
    writeRecord(dir, { pid: process.pid, program: "a.agency", node: "main", startedAt: stale });
    expect(checkedRecord(dir, process.pid)).toMatchObject({
      refused: expect.stringContaining("different process"),
    });
    expect(fs.existsSync(path.join(dir, `${process.pid}.json`))).toBe(false);
  });

  it("refuses but keeps a record written a little before the live process started", () => {
    const record = { pid: process.pid, program: "a.agency", node: "main", startedAt: Date.now() };
    writeRecord(dir, record);
    const steppedClock = () => ({ started: record.startedAt + 5 * START_TIME_TOLERANCE_MS });
    expect(checkedRecord(dir, process.pid, steppedClock)).toMatchObject({
      refused: expect.stringContaining("the record was kept"),
    });
    expect(fs.existsSync(path.join(dir, `${process.pid}.json`))).toBe(true);
  });

  it("accepts a record that matches the live process", () => {
    const startedAt = Math.round(performance.timeOrigin);
    writeRecord(dir, { pid: process.pid, program: "a.agency", node: "main", startedAt });
    expect(checkedRecord(dir, process.pid)).toMatchObject({ pid: process.pid });
  });

  it("accepts a process that started before its record, as one exec-ed by a wrapper did", () => {
    const record = { pid: process.pid, program: "a.agency", node: "main", startedAt: Date.now() };
    writeRecord(dir, record);
    const forkedEarlier = () => ({ started: record.startedAt - 10 * START_TIME_TOLERANCE_MS });
    expect(checkedRecord(dir, process.pid, forkedEarlier)).toMatchObject({ pid: process.pid });
  });

  it("refuses, and keeps, a record a long-running process with the same pid matches", () => {
    // What a record written on another machine looks like here.
    const record = { pid: process.pid, program: "a.agency", node: "main", startedAt: Date.now() };
    writeRecord(dir, record);
    const muchOlder = () => ({ started: record.startedAt - 2 * EARLY_START_LIMIT_MS });
    expect(checkedRecord(dir, process.pid, muchOlder)).toMatchObject({
      refused: expect.stringContaining(`remove ${path.join(dir, `${process.pid}.json`)}`),
    });
    expect(fs.existsSync(path.join(dir, `${process.pid}.json`))).toBe(true);
  });

  it("keeps the record and refuses when ps cannot say", () => {
    const startedAt = Math.round(performance.timeOrigin);
    writeRecord(dir, { pid: process.pid, program: "a.agency", node: "main", startedAt });
    const noPs = () => ({ failed: "could not run ps: spawn ps ENOENT" });
    expect(checkedRecord(dir, process.pid, noPs)).toMatchObject({
      refused: expect.stringContaining("spawn ps ENOENT"),
    });
    expect(fs.existsSync(path.join(dir, `${process.pid}.json`))).toBe(true);
  });
});

describe("attaching to a program in another process", () => {
  // The program is compiled into .agency-tmp under the package, which git
  // ignores and where it can resolve the runtime, and started with node; a
  // stray .js beside a tests/debugger fixture would break the other
  // debugger tests.
  const packageRoot = path.resolve(fixtureDir, "../..");
  const previousHome = process.env.AGENCY_HOME;
  let home = "";
  let work = "";
  let child: ChildProcess | null = null;
  let childOutput = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-"));
    fs.mkdirSync(path.join(packageRoot, ".agency-tmp"), { recursive: true });
    work = fs.mkdtempSync(path.join(packageRoot, ".agency-tmp", "attach-"));
    process.env.AGENCY_HOME = home;
  });
  afterAll(() => {
    child?.kill();
    if (previousHome === undefined) {
      delete process.env.AGENCY_HOME;
    } else {
      process.env.AGENCY_HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  async function startChild(): Promise<ChildProcess> {
    const out = path.join(work, "sleeps.js");
    compile({}, path.join(fixtureDir, "sleeps.agency"), out, {
      importStrategy: new RunStrategy(),
    });
    child = spawn(process.execPath, [out], {
      cwd: packageRoot,
      env: { ...process.env, AGENCY_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Kept for the failure message: a child that dies says why here.
    child.stdout!.on("data", (chunk: Buffer) => (childOutput += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (childOutput += chunk.toString()));
    // The record is written first and the socket opened a tick later;
    // the command refuses at once on a missing socket, so wait for both.
    const paths = recordPaths(sessionsDir(nodeHost()), child.pid!);
    const registered = (): boolean => fs.existsSync(paths.json) && fs.existsSync(paths.sock);
    for (let i = 0; i < 400 && !registered(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(registered(), childOutput).toBe(true);
    return child;
  }

  it("a registered child is ended by SIGUSR2 like any Node process", async () => {
    // The regression test for a program under nodemon, whose restart
    // sends SIGUSR2: before the socket was opened at registration, the
    // program took the signal as a request to open its debugger and
    // kept running, orphaned from its supervisor.
    const started = await startChild();
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      started.once("exit", (code, signal) => resolve({ code, signal })),
    );
    started.kill("SIGUSR2");
    expect(await exited).toEqual({ code: null, signal: "SIGUSR2" });
    // A process ended by a signal never runs its exit hook, so both files
    // stay until a sweep; the next registration in any program runs one.
    const paths = recordPaths(sessionsDir(nodeHost()), started.pid!);
    expect(fs.existsSync(paths.json)).toBe(true);
    expect(fs.existsSync(paths.sock)).toBe(true);
    const dir = sessionsDir(nodeHost());
    removeStale(dir, listRecords(dir));
    expect(fs.existsSync(paths.json)).toBe(false);
    expect(fs.existsSync(paths.sock)).toBe(false);
  });

  it("a program that finishes at once leaves nothing in the sessions directory", async () => {
    // `listen` binds the path in one tick and calls back in the next; a
    // program that ends between the two still removes both files in its
    // exit hook.
    const out = path.join(work, "no-return.js");
    compile({}, path.join(fixtureDir, "no-return.agency"), out, {
      importStrategy: new RunStrategy(),
    });
    const quick = spawn(process.execPath, [out], {
      cwd: packageRoot,
      env: { ...process.env, AGENCY_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    quick.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    quick.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => quick.once("exit", resolve));
    expect(code, output).toBe(0);
    const paths = recordPaths(sessionsDir(nodeHost()), quick.pid!);
    expect(fs.existsSync(paths.json)).toBe(false);
    expect(fs.existsSync(paths.sock)).toBe(false);
  });

  it("lists the program, then attaches, ignores escape, steps, and detaches on q", async () => {
    const started = await startChild();
    const listed: string[] = [];
    expect(await attachCommand({ print: (line) => listed.push(line) })).toBe(0);
    expect(listed.join("\n")).toContain(`${started.pid}`);
    expect(listed.join("\n")).toContain("sleeps.js");

    const input = new TestInput();
    const recorder = new FrameRecorder();
    const ui = new DebuggerUI(new Screen({ input, output: recorder, width: 120, height: 40 }));
    // Queued ahead: at the first stop escape does nothing. The step and
    // the quit are pressed at a stop, once its frame is on screen: `s`
    // pressed while the program runs, the attach phase included, asks it
    // to stop at its next statement, which the attach does anyway.
    input.feedKey({ key: "escape" });
    const printed: string[] = [];
    const session = attachCommand({
      pid: started.pid,
      ui,
      print: (line) => printed.push(line),
      printError: (line) => printed.push(line),
    });
    const plain = () => recorder.frames.map((recorded) => recorded.frame.toPlainText());
    const untilFrame = async (wanted: RegExp): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        if (plain().some((text) => wanted.test(text))) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no frame matching ${wanted}; last:\n${plain().at(-1)}`);
    };
    await untilFrame(/^│.x = 1 /m);
    input.feedKey({ key: "s" });
    await untilFrame(/^│.y = 2 /m);
    input.feedKey({ key: "q" });
    const code = await session;

    expect(code, printed.join("\n") + childOutput).toBe(0);
    const frames = plain();
    expect(frames.some((text) => text.includes(`attached to ${started.pid}`))).toBe(true);
    expect(frames.some((text) => text.includes("(q)detach"))).toBe(true);
    // The first stop is before `y = x + 1`, so its locals pane has no y;
    // the step runs that statement, and the second stop's pane shows
    // `y = 2`. (The source pane has no current-line marker here: the UI
    // looks for the compiled module beside the fixture, where this test
    // deliberately puts none; see debugger-future-work.md.)
    // The hello frame comes first, with empty panes, so the first stop is
    // the first frame whose locals pane shows x. A locals pane line
    // starts at the box edge with the row cursor's column (a space, or
    // the marker when the pane is focused); the source pane's lines
    // carry a line number first.
    const firstStop = frames.findIndex((text) => /^│.x = 1 /m.test(text));
    const afterStep = frames.findIndex((text) => /^│.y = 2 /m.test(text));
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(afterStep).toBeGreaterThan(firstStop);
    expect(frames[firstStop]).not.toMatch(/^│.y = 2 /m);
    expect(printed).toEqual([`Detached from pid ${started.pid}.`]);
    const exit = await new Promise<number | null>((resolve) => started.on("exit", resolve));
    expect(exit, childOutput).toBe(0);
  }, 20_000);
});
