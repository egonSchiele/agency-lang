// A debugger attached to a running program over a channel. The first
// group puts an in-memory pair between the run side and a scripted
// `DebuggerIO`; the last test goes through the real thing: `runNode`
// registers the process, the attach signal opens the socket, and a client
// on that socket drives the program.
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { hasInterrupts, isDebugger } from "@/runtime/interrupts.js";
import { isPaused } from "@/runtime/pause.js";
import { ATTACH_SIGNAL } from "@/runtime/platform.node.js";
import { functionRefReviver, nativeTypeReplacer } from "@/runtime/revivers/index.js";
import { AgencyFunction } from "@/runtime/agencyFunction.js";
import { TestDebuggerIO, fixtureDir, freshImport, withLLMMocks } from "../testHelpers.js";
import type { DebuggerCommand, DebuggerIO } from "../types.js";
import { memoryChannelPair, type Channel } from "./channel.js";
import { lineChannel } from "./lineChannel.js";
import { readRecord, recordPaths, sessionsDir } from "./registry.js";
import { attachOverChannel, type AttachedSession } from "./server.js";
import { checkpointFromWire, serveDebuggerIO, type ServeEvents } from "./serveIO.js";
import type { Hello } from "./protocol.js";
import { nodeHost } from "@/host/node/nodeHost.js";
import * as helper from "../../../tests/debugger/waiter.js";

const fixtures = {
  stepTest: "step-test",
  awaitsHelper: "awaits-helper",
  agentShaped: "agent-shaped",
  noReturn: "no-return",
  llmAfterStep: "llm-after-step",
};

function compiledPath(name: string): string {
  return path.join(fixtureDir, `${name}.ts`);
}

beforeAll(() => {
  for (const name of Object.values(fixtures)) {
    compile({}, path.join(fixtureDir, `${name}.agency`), compiledPath(name), { ts: true });
  }
});

const hello: Hello = { type: "hello", program: "agent.agency", node: "main", pid: 1 };

type Attached = {
  session: AttachedSession;
  io: TestDebuggerIO;
  uiSide: Channel;
  events: { hellos: Hello[]; finished: { value: unknown; error?: string }[]; refused: string[] };
};

/** The run side attached through one end of a memory pair, a scripted IO
 *  served on the other. */
function attachWithMemoryChannel(
  mod: any,
  commands: DebuggerCommand[],
  io: DebuggerIO & TestDebuggerIO = new TestDebuggerIO(commands),
): Attached {
  const [runSide, uiSide] = memoryChannelPair();
  const events: Attached["events"] = { hellos: [], finished: [], refused: [] };
  const handlers: ServeEvents = {
    hello: (message) => events.hellos.push(message),
    finished: (value, error) => events.finished.push({ value, error }),
    refused: (reason) => events.refused.push(reason),
  };
  serveDebuggerIO(uiSide, io, handlers);
  const session = attachOverChannel(runSide, {
    functions: {
      respondToInterrupts: mod.respondToInterrupts,
      respondToInterruptsForServe: mod.__respondToInterruptsForServe,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getDebugger: mod.__getDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    hello,
  });
  return { session, io, uiSide, events };
}

function expectNoStop(result: any): void {
  if (hasInterrupts(result?.data)) {
    expect(result.data.some((intr: unknown) => isDebugger(intr))).toBe(false);
  }
}

describe("a debugger attached over a channel", () => {
  it("says hello, shows the stops, steps, and reports the end", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { io, events } = attachWithMemoryChannel(mod, [{ type: "step" }, { type: "continue" }]);

    const result = await mod.main();

    expectNoStop(result);
    expect(result.data).toBe(3);
    expect(events.hellos).toEqual([hello]);
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(2);
    expect(io.renderCalls[0]!.scopeName).toBe("main");
    expect(io.logLines).toContainEqual("Program finished. Return value: 3");
    expect(events.finished).toEqual([{ value: 3, error: undefined }]);
  });

  it("a node that returns nothing still reports the end", async () => {
    const mod = await freshImport(compiledPath(fixtures.noReturn));
    const { events } = attachWithMemoryChannel(mod, [{ type: "continue" }]);

    await mod.main();

    expect(events.finished).toEqual([{ value: undefined, error: undefined }]);
  });

  it("a run that ends by throwing reports the error", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new (class extends TestDebuggerIO {
      override async waitForCommand(): Promise<DebuggerCommand> {
        return await new Promise(() => {});
      }
    })([]);
    const { events } = attachWithMemoryChannel(mod, [], io);
    const cancel = new AbortController();
    const running = mod.main({ abortSignal: cancel.signal });
    for (let i = 0; i < 200 && io.renderCalls.length < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    cancel.abort();

    await expect(running).rejects.toThrow(/cancel/i);
    expect(events.finished).toHaveLength(1);
    expect(events.finished[0]).toMatchObject({ error: expect.stringMatching(/cancel/i) });
  });

  it("a run that runs through while another is stopped does not end the session", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new (class extends TestDebuggerIO {
      override async waitForCommand(): Promise<DebuggerCommand> {
        return await new Promise(() => {});
      }
    })([]);
    const { session, events, uiSide } = attachWithMemoryChannel(mod, [], io);
    const stopped = mod.main();
    for (let i = 0; i < 200 && io.renderCalls.length < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect((await mod.main()).data).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.finished).toEqual([]);
    expect(session.driver.debuggerState.attached).toBeDefined();
    expect(io.logLines.some((line) => line.startsWith("Program finished"))).toBe(false);
    uiSide.close();
    expect((await stopped).data).toBe(3);
  });

  it("set over the channel changes a local the program returns", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { io } = attachWithMemoryChannel(mod, [
      { type: "step" },
      { type: "set", varName: "x", value: 10 },
      { type: "continue" },
    ]);

    const result = await mod.main();

    expect(result.data).toBe(12);
    expect(io.overrides).toEqual({});
    expect(io.logLines).toContainEqual("Set x = 10");
  });

  it("closing the channel resumes a stopped run and removes the debugger", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new (class extends TestDebuggerIO {
      private answered = false;
      override async waitForCommand(): Promise<DebuggerCommand> {
        if (!this.answered) {
          this.answered = true;
          return { type: "step" };
        }
        return await new Promise(() => {});
      }
    })([]);
    const { session, uiSide } = attachWithMemoryChannel(mod, [], io);

    const running = mod.main();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rendersBeforeClose = io.renderCalls.length;
    uiSide.close();
    const result = await running;

    expect(result.data).toBe(3);
    expect(rendersBeforeClose).toBe(2);
    expect(io.renderCalls.length).toBe(rendersBeforeClose);
    expect(session.driver.debuggerState.attached).toBeUndefined();
  });

  it("a pause during a step the debugger ran does not end the session", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const { session, events, io } = attachWithMemoryChannel(mod, [
      { type: "step" },
      { type: "continue" },
    ]);
    const pause = new AbortController();
    const running = mod.main({ pauseSignal: pause.signal });
    await helper.untilWaiting();
    pause.abort();
    helper.releaseWaiter();
    const paused = await running;

    expect(isPaused(paused.data)).toBe(true);
    expect(events.finished).toEqual([]);
    expect(session.driver.debuggerState.attached).toBeDefined();

    const final = await mod.resumeFromCheckpoint(paused.data);
    expect(final.data).toBe(2);
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(2);
    expect(events.finished).toEqual([{ value: 2, error: undefined }]);
  });

  it("a UI that throws ends the session and the program runs on", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new (class extends TestDebuggerIO {
      private renders = 0;
      override async render(): Promise<void> {
        this.renders += 1;
        if (this.renders === 2) {
          throw new Error("the panel could not be drawn");
        }
      }
    })([{ type: "step" }, { type: "step" }, { type: "step" }]);
    const { session, uiSide } = attachWithMemoryChannel(mod, [], io);
    const uiSideClosed = new Promise<void>((resolve) => uiSide.onClose(resolve));

    const result = await mod.main();

    expect(result.data).toBe(3);
    await uiSideClosed;
    expect(session.driver.debuggerState.attached).toBeUndefined();
  });

  it("a reply of the wrong shape ends the session and the program runs on", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new (class extends TestDebuggerIO {
      override async waitForCommand(): Promise<DebuggerCommand> {
        return null as never;
      }
    })([]);
    const { session, uiSide } = attachWithMemoryChannel(mod, [], io);
    const uiSideClosed = new Promise<void>((resolve) => uiSide.onClose(resolve));

    const result = await mod.main();

    expect(result.data).toBe(3);
    await uiSideClosed;
    expect(session.driver.debuggerState.attached).toBeUndefined();
  });

  it("a checkpoint holding a function is rebuilt in a process that loaded no program", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { io } = attachWithMemoryChannel(mod, [{ type: "continue" }]);
    await mod.main();
    const wire = JSON.parse(JSON.stringify(io.renderCalls[0]!.toJSON(), nativeTypeReplacer));
    wire.stack.stack[0].locals.fn = {
      __nativeType: "FunctionRef",
      name: "search",
      module: "agent.agency",
    };

    const registry = functionRefReviver.registry;
    functionRefReviver.registry = null;
    try {
      const rebuilt = checkpointFromWire(wire);
      expect(rebuilt).toBeDefined();
      expect(AgencyFunction.isAgencyFunction(rebuilt!.stack.stack[0]!.locals.fn)).toBe(true);
    } finally {
      functionRefReviver.registry = registry;
    }
  });

  it("the pause key crosses the channel and stops the program at its next statement", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const { io } = attachWithMemoryChannel(mod, [{ type: "continue" }, { type: "continue" }]);

    const running = mod.main();
    await helper.untilWaiting();
    io.pause();
    helper.releaseWaiter();
    const result = await running;

    expectNoStop(result);
    expect(result.data).toBe(2);
    expect(io.logLines).toContain("Pausing at the next statement");
    expect(io.renderCalls).toHaveLength(2);
  });

  it("what the program is waiting on reaches the UI side", async () => {
    await withLLMMocks([{ return: "hi" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      const { io } = attachWithMemoryChannel(mod, [{ type: "continue" }]);

      expect((await mod.main()).data).toBe("hi");

      expect(io.busyCalls.map((entries) => entries.map((entry) => entry.kind))).toEqual([
        ["model"],
        [],
      ]);
      expect(io.busyCalls[0][0].label).toBe("round 1");
    });
  });

  it("the stop inside a tool call reaches the UI side with its branch", async () => {
    const mocks = [
      { toolCall: { name: "search", args: { query: "grant", breakHere: true } } },
      { return: "grant summary" },
      { toolCall: { name: "writeUp", args: { notes: "grant summary" } } },
      { return: "final report" },
    ];
    await withLLMMocks(mocks, async () => {
      const mod = await freshImport(compiledPath(fixtures.agentShaped));
      // continue to the debugger() statement inside the search tool, then on.
      const { io } = attachWithMemoryChannel(mod, [{ type: "continue" }, { type: "continue" }]);

      const result = await mod.main("research");

      expectNoStop(result);
      expect(result.data).toBe("final report");
      const inTool = io.renderCalls.find((cp) => cp.listBranches().length > 0);
      expect(inTool).toBeDefined();
      expect(inTool!.listBranches().some((branch) => branch.label === "search")).toBe(true);
    });
  });
});

describe("a program registered for attach, over the socket", () => {
  // The record and the signal listener are per process, written by the
  // first node run on the Node host with no debugger (the runs above all
  // had one, but an earlier test file in this worker may have run one);
  // the context a debugger attaches to is the one that most recently
  // started a node. AGENCY_HOME is one temporary directory for the whole
  // run (lib/debugger/attach/vitest.globalSetup.ts), so the record is
  // found wherever in the run it was written.
  const dir = sessionsDir(nodeHost());

  it("writes its record, opens the socket on the signal, and takes a debugger", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const running = mod.main();
    await helper.untilWaiting();

    const record = readRecord(dir, process.pid);
    expect(record).not.toBeNull();
    expect(record!.node).toBe("main");
    expect(Math.abs(record!.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);

    // The signal handler, called the way the signal would call it.
    process.emit(ATTACH_SIGNAL as "SIGUSR2");
    const sock = recordPaths(dir, process.pid).sock;
    // The socket appears at listen and is chmod 600 right after; ready
    // means both.
    const ready = (): boolean => fs.existsSync(sock) && (fs.statSync(sock).mode & 0o777) === 0o600;
    for (let i = 0; i < 100 && !ready(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready()).toBe(true);

    const socket = net.connect(sock);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const channel = lineChannel(socket);
    const io = new TestDebuggerIO([{ type: "step" }, { type: "continue" }]);
    const hellos: Hello[] = [];
    const finished: unknown[] = [];
    serveDebuggerIO(channel, io, {
      hello: (message) => hellos.push(message),
      finished: (value) => finished.push(value),
    });
    const closedByRun = new Promise<void>((resolve) => channel.onClose(resolve));
    helper.releaseWaiter();

    const result = await running;
    await closedByRun;

    expectNoStop(result);
    expect(result.data).toBe(2);
    expect(hellos).toHaveLength(1);
    expect(hellos[0]!.pid).toBe(process.pid);
    expect(hellos[0]!.node).toBe("main");
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(2);
    expect(finished).toEqual([2]);

    // A second debugger while one is attached is refused; after a
    // detach, the socket takes the next one.
    const again = mod.main();
    await helper.untilWaiting();
    const first = net.connect(sock);
    await new Promise<void>((resolve) => first.once("connect", resolve));
    const firstChannel = lineChannel(first);
    const firstIo = new TestDebuggerIO([]);
    const firstHello = new Promise<void>((resolve) =>
      serveDebuggerIO(firstChannel, firstIo, { hello: () => resolve() }),
    );
    await firstHello;
    const second = net.connect(sock);
    await new Promise<void>((resolve) => second.once("connect", resolve));
    const refused = await new Promise<string>((resolve) =>
      serveDebuggerIO(lineChannel(second), new TestDebuggerIO([]), { refused: resolve }),
    );
    expect(refused).toMatch(/^already attached since /);
    helper.releaseWaiter();
    expect((await again).data).toBe(2);
  });
});
