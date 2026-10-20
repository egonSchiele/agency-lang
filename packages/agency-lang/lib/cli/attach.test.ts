// `agency debug --attach`: the listing, the refusals, and one real
// session against a program running in a child process.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { nodeHost } from "@/host/node/nodeHost.js";
import { ensureSessionsDir, sessionsDir, writeRecord } from "@/debugger/attach/registry.js";
import { fixtureDir } from "@/debugger/testHelpers.js";
import { TestInput } from "@/debugger/testSession.js";
import { DebuggerUI } from "@/debugger/ui.js";
import { FrameRecorder, Screen } from "@/tui/index.js";
import { RunStrategy } from "@/importStrategy.js";
import { attachTarget } from "./debugFlags.js";
import {
  START_TIME_TOLERANCE_MS,
  attachCommand,
  checkedRecord,
  formatListing,
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
    expect(attachTarget({ attach: "forty" })).toMatchObject({
      refused: expect.stringContaining("needs a process id"),
    });
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

  it("says so when nothing is running", () => {
    expect(formatListing([], 0)).toContain("No running Agency programs");
  });
});

describe("the start time from ps", () => {
  it("parses the lstart formats of macOS and Linux", () => {
    expect(parseStartTime("Tue Oct 20 13:32:26 2026\n")).toBe(
      new Date("Tue Oct 20 13:32:26 2026").getTime(),
    );
    expect(parseStartTime("")).toBeNull();
    expect(parseStartTime("not a date")).toBeNull();
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

  it("refuses and removes a record whose start time is not this process's", () => {
    const stale = Date.now() - process.uptime() * 1000 - 10 * START_TIME_TOLERANCE_MS;
    writeRecord(dir, { pid: process.pid, program: "a.agency", node: "main", startedAt: stale });
    expect(checkedRecord(dir, process.pid)).toMatchObject({
      refused: expect.stringContaining("different process"),
    });
    expect(fs.existsSync(path.join(dir, `${process.pid}.json`))).toBe(false);
  });

  it("accepts a record that matches the live process", () => {
    const startedAt = Date.now() - process.uptime() * 1000;
    writeRecord(dir, { pid: process.pid, program: "a.agency", node: "main", startedAt });
    expect(checkedRecord(dir, process.pid)).toMatchObject({ pid: process.pid });
  });
});

describe("attaching to a program in another process", () => {
  // The program is compiled into .tmp under the package, where it can
  // resolve the runtime, and started with node; a stray .js beside a
  // tests/debugger fixture would break the other debugger tests.
  const packageRoot = path.resolve(fixtureDir, "../..");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-"));
  fs.mkdirSync(path.join(packageRoot, ".tmp"), { recursive: true });
  const work = fs.mkdtempSync(path.join(packageRoot, ".tmp", "attach-"));
  const previousHome = process.env.AGENCY_HOME;
  let child: ChildProcess | null = null;

  beforeAll(() => {
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
    const started = spawn(process.execPath, [out], {
      cwd: packageRoot,
      env: { ...process.env, AGENCY_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = path.join(sessionsDir(nodeHost()), `${started.pid}.json`);
    for (let i = 0; i < 400 && !fs.existsSync(record); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(record)).toBe(true);
    return started;
  }

  it("lists the program, then attaches, steps, and detaches on q", async () => {
    child = await startChild();
    const listed: string[] = [];
    expect(await attachCommand({ print: (line) => listed.push(line) })).toBe(0);
    expect(listed.join("\n")).toContain(`${child.pid}`);
    expect(listed.join("\n")).toContain("sleeps.js");

    const input = new TestInput();
    const recorder = new FrameRecorder();
    const ui = new DebuggerUI(new Screen({ input, output: recorder, width: 120, height: 40 }));
    // Queued ahead: the first stop takes the step, the second the quit.
    input.feedKey({ key: "s" });
    input.feedKey({ key: "q" });
    const printed: string[] = [];
    const code = await attachCommand({ pid: child.pid, ui, print: (line) => printed.push(line) });

    expect(code).toBe(0);
    const frames = recorder.frames.map((recorded) => recorded.frame.toPlainText());
    expect(frames.some((text) => text.includes(`attached to ${child!.pid}`))).toBe(true);
    expect(frames.some((text) => text.includes("y = x + 1"))).toBe(true);
    expect(printed.join("\n")).toMatch(/Detached from pid|Program finished/);
    const exit = await new Promise<number | null>((resolve) => child!.on("exit", resolve));
    expect(exit).toBe(0);
  }, 20_000);
});
