// `agency debug session` against a program in another process, over a
// real socket: the program is compiled into .agency-tmp and started with
// node, as lib/cli/attach.test.ts does, and every command goes through
// `debugSession` with the default command code and a collected stdout.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { nodeHost } from "@/host/node/nodeHost.js";
import { sessionsDir } from "@/debugger/attach/registry.js";
import { fixtureDir } from "@/debugger/testHelpers.js";
import { RunStrategy } from "@/importStrategy.js";
import { ATTACH_SIGNAL } from "@/runtime/platform.node.js";
import { checkedRecord, connectWithRetry } from "../attach.js";
import { defaultCommandDeps } from "./commands.js";
import { debugSession, type SessionCliCommand, type SessionCliDeps } from "./index.js";

describe("agency debug session against a program in another process", () => {
  const packageRoot = path.resolve(fixtureDir, "../..");
  const previousHome = process.env.AGENCY_HOME;
  let home = "";
  let work = "";
  let child: ChildProcess | null = null;
  let childOutput = "";
  let out: string[] = [];
  let err: string[] = [];
  let deps: SessionCliDeps;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-"));
    fs.mkdirSync(path.join(packageRoot, ".agency-tmp"), { recursive: true });
    work = fs.mkdtempSync(path.join(packageRoot, ".agency-tmp", "session-"));
    process.env.AGENCY_HOME = home;
    deps = {
      sessionsDir: sessionsDir(nodeHost()),
      cwd: packageRoot,
      commandDeps: { ...defaultCommandDeps(packageRoot), moveWaitMs: 10_000 },
      checked: checkedRecord,
      signal: (pid) => process.kill(pid, ATTACH_SIGNAL),
      connect: (pid, sock) => connectWithRetry(pid, sock, 2_000),
      probeTimeoutMs: 1_000,
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
    };
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
    const program = path.join(work, "sleeps.js");
    compile({}, path.join(fixtureDir, "sleeps.agency"), program, {
      importStrategy: new RunStrategy(),
    });
    child = spawn(process.execPath, [program], {
      cwd: packageRoot,
      env: { ...process.env, AGENCY_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => (childOutput += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (childOutput += chunk.toString()));
    const record = path.join(sessionsDir(nodeHost()), `${child.pid}.json`);
    for (let i = 0; i < 400 && !fs.existsSync(record); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(record), childOutput).toBe(true);
    return child;
  }

  async function run(command: SessionCliCommand, pid?: number): Promise<number> {
    out = [];
    err = [];
    return debugSession(command, { json: false, pid }, deps);
  }
  const printed = (): string => out.join("") + err.join("");

  it("lists, attaches, reads, steps, continues, waits for the end, and the program exits 0", async () => {
    const started = await startChild();
    const pid = started.pid!;

    expect(await run({ name: "list" })).toBe(0);
    expect(printed()).toContain(`${pid}`);
    expect(printed()).toMatch(/sleeps\.js.*none/);

    // Nothing holds a session yet, so a command with no pid is refused
    // with the way forward.
    expect(await run({ name: "where" })).toBe(1);
    expect(printed()).toContain("no run holds a session");

    expect(await run({ name: "attach", pid })).toBe(0);
    expect(printed()).toContain(`sleeps.js · node main · pid ${pid}`);
    expect(printed()).not.toContain(packageRoot);
    // The line comes from the compiled program's map, read as text, and
    // the statement from the source under the current directory.
    expect(printed()).toMatch(
      /stopped in main · tests\/debugger\/sleeps\.agency:\d+\n  (sleep|y = x \+ 1)/,
    );
    expect(printed()).toContain("next    step");

    expect(await run({ name: "source", context: 1 })).toBe(0);
    expect(printed()).toMatch(/^>\s+\d+  /m);

    // The hold is live: the one held session is the target, and the
    // listing says so.
    expect(await run({ name: "list" })).toBe(0);
    expect(printed()).toMatch(/held/);
    expect(await run({ name: "where" })).toBe(0);
    expect(printed()).toMatch(/stopped in main/);
    expect(await run({ name: "stack" })).toBe(0);
    expect(printed()).toContain("#0 main");
    expect(await run({ name: "frame", globals: false })).toBe(0);
    expect(printed()).toContain("#0 main");

    // A step moves one statement; the next stop's frame holds what the
    // statement set.
    expect(await run({ name: "step" })).toBe(0);
    expect(printed()).toMatch(/stopped in main/);
    expect(await run({ name: "frame", globals: false })).toBe(0);
    expect(printed()).toContain("x = 1");

    expect(await run({ name: "continue" })).toBe(0);
    expect(printed()).toContain("is running");
    expect(await run({ name: "where" })).toBe(0);
    expect(printed()).toContain("is running");

    // The program sleeps, then ends; wait sees the end.
    expect(await run({ name: "wait", forMs: 15_000 })).toBe(2);
    expect(printed()).toContain("Program finished. Return value: 2");

    const exit = await new Promise<number | null>((resolve) => started.on("exit", resolve));
    expect(exit, childOutput).toBe(0);
  }, 40_000);

  it("detach releases the hold and the program runs on", async () => {
    const started = await startChild();
    const pid = started.pid!;

    expect(await run({ name: "attach", pid })).toBe(0);
    expect(await run({ name: "detach" })).toBe(0);
    expect(printed()).toContain("runs on");

    expect(await run({ name: "where" })).toBe(1);
    expect(printed()).toMatch(/no run holds a session|no session on/);

    const exit = await new Promise<number | null>((resolve) => started.on("exit", resolve));
    expect(exit, childOutput).toBe(0);
  }, 30_000);
});
