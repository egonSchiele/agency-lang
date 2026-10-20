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
  it("reads the C-locale lstart format and nothing else", () => {
    expect(parseStartTime("Tue Oct 20 13:32:26 2026\n")).toBe(
      new Date("Tue Oct 20 13:32:26 2026").getTime(),
    );
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
      expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(
        START_TIME_TOLERANCE_MS,
      );
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

  it("refuses and removes a record written before the live process started", () => {
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

  it("accepts a process that started before its record, as one exec-ed by a wrapper did", () => {
    const record = { pid: process.pid, program: "a.agency", node: "main", startedAt: Date.now() };
    writeRecord(dir, record);
    const forkedEarlier = () => ({ started: record.startedAt - 10 * START_TIME_TOLERANCE_MS });
    expect(checkedRecord(dir, process.pid, forkedEarlier)).toMatchObject({ pid: process.pid });
  });

  it("keeps the record and refuses when ps cannot say", () => {
    const startedAt = Date.now() - process.uptime() * 1000;
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
    const record = path.join(sessionsDir(nodeHost()), `${child.pid}.json`);
    for (let i = 0; i < 400 && !fs.existsSync(record); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(record), childOutput).toBe(true);
    return child;
  }

  it("lists the program, then attaches, ignores escape, steps, and detaches on q", async () => {
    const started = await startChild();
    const listed: string[] = [];
    expect(await attachCommand({ print: (line) => listed.push(line) })).toBe(0);
    expect(listed.join("\n")).toContain(`${started.pid}`);
    expect(listed.join("\n")).toContain("sleeps.js");

    const input = new TestInput();
    const recorder = new FrameRecorder();
    const ui = new DebuggerUI(new Screen({ input, output: recorder, width: 120, height: 40 }));
    // Queued ahead: at the first stop escape does nothing and the step
    // moves on; the second stop takes the quit.
    input.feedKey({ key: "escape" });
    input.feedKey({ key: "s" });
    input.feedKey({ key: "q" });
    const printed: string[] = [];
    const code = await attachCommand({
      pid: started.pid,
      ui,
      print: (line) => printed.push(line),
      printError: (line) => printed.push(line),
    });

    expect(code, printed.join("\n") + childOutput).toBe(0);
    const frames = recorder.frames.map((recorded) => recorded.frame.toPlainText());
    expect(frames.some((text) => text.includes(`attached to ${started.pid}`))).toBe(true);
    expect(frames.some((text) => text.includes("(q)detach"))).toBe(true);
    // The first stop is before `y = x + 1`, so its locals pane has no y;
    // the step runs that statement, and the second stop's pane shows
    // `y = 2`. (The source pane has no current-line marker here: the UI
    // looks for the compiled module beside the fixture, where this test
    // deliberately puts none; see debugger-future-work.md.)
    const firstStop = frames.findIndex((text) => text.includes(`attached to ${started.pid}`));
    const afterStep = frames.findIndex((text) => /\by = 2\b/.test(text));
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(afterStep).toBeGreaterThan(firstStop);
    expect(frames[firstStop]).not.toMatch(/\by = 2\b/);
    expect(printed).toEqual([`Detached from pid ${started.pid}.`]);
    const exit = await new Promise<number | null>((resolve) => started.on("exit", resolve));
    expect(exit, childOutput).toBe(0);
  }, 20_000);
});
