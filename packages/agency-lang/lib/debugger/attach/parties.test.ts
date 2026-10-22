// A terminal debugger and a CLI visit on one run at once, with the real
// driver and a compiled fixture behind them. The rules are proved in
// sessionRules.test.ts; these are the paths that need the driver, the
// adapter, and the UI side's `serveDebuggerIO` together: both are sent
// the stop, the first to answer moves the program and the other is told,
// a late reply is refused, a terminal's read is withdrawn, either party's
// pause stops the program, and the session ends with the last party.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { TestDebuggerIO, fixtureDir, freshImport } from "../testHelpers.js";
import * as helper from "../../../tests/debugger/waiter.js";
import type { DebuggerCommand, Parties } from "../types.js";
import { memoryChannelPair, type Channel } from "./channel.js";
import { parseAttachMessage, type AttachMessage, type Hello } from "./protocol.js";
import { openSession, type AttachedSession } from "./server.js";
import { serveDebuggerIO } from "./serveIO.js";
import type { SessionTimers } from "./sessionChannel.js";

const fixtures = ["step-test", "awaits-helper"];
const compiled = path.join(fixtureDir, "step-test.ts");
const waits = path.join(fixtureDir, "awaits-helper.ts");

beforeAll(() => {
  for (const fixture of fixtures) {
    compile(
      {},
      path.join(fixtureDir, `${fixture}.agency`),
      path.join(fixtureDir, `${fixture}.ts`),
      {
        ts: true,
      },
    );
  }
});

const hello: Hello = { type: "hello", program: "agent.agency", node: "main", pid: 1 };

function fakeTimers(): SessionTimers & { fire(): void } {
  let pending: (() => void) | null = null;
  return {
    set: (fire) => {
      pending = fire;
      return pending;
    },
    clear: (handle) => {
      if (handle === pending) {
        pending = null;
      }
    },
    fire: () => {
      const fire = pending;
      pending = null;
      fire?.();
    },
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`gave up waiting for ${what}`);
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  const marker = {};
  const first = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(marker), 50)),
  ]);
  return first !== marker;
}

function open(mod: any, timers: SessionTimers): AttachedSession {
  return openSession({
    functions: {
      respondToInterrupts: mod.respondToInterrupts,
      respondToInterruptsForServe: mod.__respondToInterruptsForServe,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getDebugger: mod.__getDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    hello,
    session: { timers, log: () => {} },
  });
}

/** A terminal whose `waitForCommand` the test answers by hand, so the
 *  test decides who answers first. */
class HeldTerminal extends TestDebuggerIO {
  parties: Parties[] = [];
  withdrawn = 0;
  private waiting: {
    resolve: (command: DebuggerCommand) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor() {
    super([]);
  }

  override waitForCommand(): Promise<DebuggerCommand> {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  answer(command: DebuggerCommand): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.resolve(command);
  }

  isWaiting(): boolean {
    return this.waiting !== null;
  }

  withdraw(): void {
    this.withdrawn++;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(new Error("withdrawn"));
  }

  setParties(parties: Parties): void {
    this.parties.push(parties);
  }
}

/** A terminal on the session, served through the real UI-side code. */
function terminal(session: AttachedSession): { io: HeldTerminal; channel: Channel } {
  const [runSide, uiSide] = memoryChannelPair();
  const io = new HeldTerminal();
  serveDebuggerIO(uiSide, io);
  session.admit(runSide, "terminal");
  return { io, channel: uiSide };
}

/** A CLI visit driven by hand. */
type Visit = {
  channel: Channel;
  received: AttachMessage[];
  reply(id: number, result: unknown): void;
  pause(): void;
  close(): void;
};

function visit(session: AttachedSession): Visit {
  const [runSide, cliSide] = memoryChannelPair();
  const received: AttachMessage[] = [];
  cliSide.onMessage((raw) => {
    const message = parseAttachMessage(raw);
    if (message !== null) {
      received.push(message);
    }
  });
  cliSide.onMessage((raw) => {
    // Acknowledge every render, as a UI does.
    const message = parseAttachMessage(raw);
    if (message?.type === "request" && message.method === "render") {
      cliSide.send({ type: "reply", id: message.id, result: undefined });
    }
  });
  session.admit(runSide, "cli");
  return {
    channel: cliSide,
    received,
    reply: (id, result) => cliSide.send({ type: "reply", id, result }),
    pause: () => cliSide.send({ type: "pause" }),
    close: () => cliSide.close(),
  };
}

/** Whether the visit has been sent the stop's `waitForCommand`, which
 *  follows its acknowledgement of the render. */
function askedToCommand(received: AttachMessage[]): boolean {
  return received.some(
    (message) => message.type === "request" && message.method === "waitForCommand",
  );
}

function pendingAsk(received: AttachMessage[]): number {
  const asks = received.filter(
    (message) => message.type === "request" && message.method === "waitForCommand",
  );
  return (asks[asks.length - 1] as { id: number }).id;
}

function answeredMessages(received: AttachMessage[]): AttachMessage[] {
  return received.filter((message) => message.type === "answered");
}

describe("a terminal and a CLI visit on one run", () => {
  it("both are sent the stop; the CLI answers first, the terminal is told and its read is withdrawn", async () => {
    const mod = await freshImport(compiled);
    const session = open(mod, fakeTimers());
    const running = mod.main();

    const person = terminal(session);
    await until(() => person.io.isWaiting(), "the terminal's first stop");
    const agent = visit(session);
    await until(() => askedToCommand(agent.received), "the visit's copy");
    expect(person.io.parties.at(-1)).toEqual({ terminal: true, cli: true });

    const stop = pendingAsk(agent.received);
    agent.reply(stop, { type: "step" });

    await until(() => person.io.withdrawn === 1, "the withdraw");
    await until(() => person.io.logLines.includes("cli: step"), "the activity line");
    await until(() => person.io.isWaiting(), "the next stop at the terminal");
    expect(pendingAsk(agent.received)).not.toBe(stop);
    expect(agent.received.some((m) => m.type === "answered")).toBe(false);

    person.io.answer({ type: "continue" });
    expect((await running).data).toBe(3);
    await until(() => agent.received.some((m) => m.type === "finished"), "finished at the visit");
  });

  it("the terminal answers first, and the visit's late reply is refused with who answered", async () => {
    const mod = await freshImport(compiled);
    const session = open(mod, fakeTimers());
    const running = mod.main();

    const person = terminal(session);
    await until(() => person.io.isWaiting(), "the stop");
    const agent = visit(session);
    await until(() => askedToCommand(agent.received), "the visit's copy");
    const stop = pendingAsk(agent.received);

    person.io.answer({ type: "step" });
    await until(() => person.io.isWaiting(), "the next stop");

    agent.reply(stop, { type: "continue" });
    await until(() => answeredMessages(agent.received).length === 1, "the refusal");
    expect(answeredMessages(agent.received)[0]).toEqual({
      type: "answered",
      id: stop,
      by: "terminal",
      command: "step",
    });
    expect(await settled(running)).toBe(false);

    person.io.answer({ type: "continue" });
    expect((await running).data).toBe(3);
  });

  it("a terminal closing leaves the hold and the stopped program; the lease then ends it", async () => {
    const mod = await freshImport(compiled);
    const timers = fakeTimers();
    const session = open(mod, timers);
    const running = mod.main();

    const person = terminal(session);
    await until(() => person.io.isWaiting(), "the stop");
    const agent = visit(session);
    await until(() => askedToCommand(agent.received), "the visit's copy");
    agent.close();
    await until(() => person.io.parties.length >= 2, "the terminal told of the visit leaving");

    person.channel.close();
    expect(await settled(running)).toBe(false);

    timers.fire();
    expect((await running).data).toBe(3);
  });

  it("the visit's pause stops a program the terminal let run", async () => {
    // The fixture blocks in a helper at its first statement, so the
    // program is running, not stopped, when the pause arrives.
    const mod = await freshImport(waits);
    const session = open(mod, fakeTimers());
    const running = mod.main();

    const person = terminal(session);
    await until(() => person.io.isWaiting(), "the first stop");
    const agent = visit(session);
    await until(() => askedToCommand(agent.received), "the visit's copy");
    person.io.answer({ type: "continue" });
    await helper.untilWaiting();

    agent.pause();
    await new Promise((resolve) => setTimeout(resolve, 20));
    helper.releaseWaiter();

    await until(() => person.io.isWaiting(), "the stop the pause made");
    expect(await settled(running)).toBe(false);
    person.io.answer({ type: "continue" });
    expect((await running).data).toBe(2);
  });
});
