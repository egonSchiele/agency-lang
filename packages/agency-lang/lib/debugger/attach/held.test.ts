// A session the run holds between CLI visits, with the real driver and a
// compiled fixture behind it, on in-memory channels. The rules are proved
// in sessionRules.test.ts; these are the paths that need the driver and
// the adapter together: a program that stays stopped while no one is
// connected, the next visit picking up the pending request, the lease,
// and a program that ends while no one is there.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { fixtureDir, freshImport } from "../testHelpers.js";
import { memoryChannelPair, type Channel } from "./channel.js";
import type { AttachMessage, Hello } from "./protocol.js";
import { openSession, type AttachedSession } from "./server.js";
import { parseAttachMessage } from "./protocol.js";
import type { SessionTimers } from "./sessionChannel.js";

const fixture = "step-test";
const compiled = path.join(fixtureDir, `${fixture}.ts`);

beforeAll(() => {
  compile({}, path.join(fixtureDir, `${fixture}.agency`), compiled, { ts: true });
});

const hello: Hello = { type: "hello", program: "agent.agency", node: "main", pid: 1 };

/** Timers the test fires by hand. */
function fakeTimers(): SessionTimers & { fire(): void; armed(): boolean } {
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
    armed: () => pending !== null,
  };
}

/** One CLI visit: the messages it has been sent, and a way to answer. */
type Visit = {
  channel: Channel;
  received: AttachMessage[];
  reply(id: number, result: unknown): void;
  close(): void;
  /** Whether the run closed this visit's channel. */
  closed(): boolean;
};

function visit(session: AttachedSession): Visit {
  const [runSide, cliSide] = memoryChannelPair();
  const received: AttachMessage[] = [];
  let closed = false;
  cliSide.onMessage((raw) => {
    const message = parseAttachMessage(raw);
    if (message !== null) {
      received.push(message);
    }
  });
  cliSide.onClose(() => {
    closed = true;
  });
  session.admit(runSide, "cli");
  return {
    channel: cliSide,
    received,
    reply: (id, result) => cliSide.send({ type: "reply", id, result }),
    close: () => cliSide.close(),
    closed: () => closed,
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

function requests(received: AttachMessage[]): { id: number; method: string }[] {
  return received
    .filter((message) => message.type === "request")
    .map((message) => ({
      id: (message as { id: number }).id,
      method: (message as { method: string }).method,
    }));
}

function lastRequest(received: AttachMessage[]): { id: number; method: string } {
  const all = requests(received);
  return all[all.length - 1]!;
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

/** Answer every render a visit is sent, the way a UI acknowledges one. */
function ackRenders(seen: Visit): void {
  let answered = 0;
  seen.channel.onMessage(() => {
    for (const request of requests(seen.received).slice(answered)) {
      answered++;
      if (request.method === "render") {
        seen.reply(request.id, undefined);
      }
    }
  });
}

describe("a session the run holds between visits", () => {
  it("stays stopped while no visit is connected, and the next visit picks up the pending request", async () => {
    const mod = await freshImport(compiled);
    const timers = fakeTimers();
    const session = open(mod, timers);
    const running = mod.main();

    const first = visit(session);
    ackRenders(first);
    await until(() => lastRequest(first.received)?.method === "waitForCommand", "the first stop");
    expect(first.received[0]).toEqual(hello);
    const stop = lastRequest(first.received);
    first.close();
    expect(timers.armed()).toBe(true);

    // Nothing is connected and the program has not moved.
    expect(await settled(running)).toBe(false);

    const second = visit(session);
    ackRenders(second);
    await until(() => requests(second.received).length >= 2, "the render and the request again");
    expect(second.received[0]).toEqual(hello);
    expect(requests(second.received).map((request) => request.method)).toEqual([
      "render",
      "waitForCommand",
    ]);
    expect(lastRequest(second.received).id).toBe(stop.id);
    expect(timers.armed()).toBe(false);

    second.reply(stop.id, { type: "step" });
    await until(
      () =>
        requests(second.received).filter((request) => request.method === "waitForCommand").length >=
        2,
      "the next stop",
    );
    expect(lastRequest(second.received).id).not.toBe(stop.id);
    second.reply(lastRequest(second.received).id, { type: "continue" });

    expect((await running).data).toBe(3);
    await until(() => second.received.some((message) => message.type === "finished"), "finished");
    expect(second.received.at(-1)).toEqual({ type: "finished", value: 3 });
  });

  it("three visits that only read leave the program where it was", async () => {
    const mod = await freshImport(compiled);
    const timers = fakeTimers();
    const session = open(mod, timers);
    const running = mod.main();

    let stopId: number | null = null;
    for (let i = 0; i < 3; i++) {
      const reader = visit(session);
      ackRenders(reader);
      await until(() => lastRequest(reader.received)?.method === "waitForCommand", `stop ${i}`);
      stopId ??= lastRequest(reader.received).id;
      expect(lastRequest(reader.received).id).toBe(stopId);
      reader.close();
    }
    expect(await settled(running)).toBe(false);

    session.detach();
    expect((await running).data).toBe(3);
  });

  it("the lease running out lets the program finish", async () => {
    const mod = await freshImport(compiled);
    const timers = fakeTimers();
    const session = open(mod, timers);
    const running = mod.main();

    const only = visit(session);
    ackRenders(only);
    await until(() => lastRequest(only.received)?.method === "waitForCommand", "the stop");
    only.close();
    expect(await settled(running)).toBe(false);

    timers.fire();

    expect((await running).data).toBe(3);
    // The session is over: a visit now is refused.
    const late = visit(session);
    await until(() => late.received.length > 0, "the refusal");
    expect(late.received[0]).toEqual({ type: "refused", reason: "the session has ended" });
  });

  it("a program that ends while no visit is connected tells the next one, which is then closed", async () => {
    const mod = await freshImport(compiled);
    const timers = fakeTimers();
    const session = open(mod, timers);
    const running = mod.main();

    const first = visit(session);
    ackRenders(first);
    await until(() => lastRequest(first.received)?.method === "waitForCommand", "the stop");
    // `continue` from this visit, then leave before the program ends. The
    // memory pair delivers a message on a microtask, so one turn lets the
    // reply reach the run before the close does, as a socket would.
    first.reply(lastRequest(first.received).id, { type: "continue" });
    await Promise.resolve();
    first.close();
    expect((await running).data).toBe(3);

    const next = visit(session);
    await until(() => next.received.length > 0, "the news");
    expect(next.received).toEqual([{ type: "finished", value: 3 }]);
    expect(next.closed()).toBe(true);
  });

  it("a terminal is refused while the CLI holds the session", async () => {
    const mod = await freshImport(compiled);
    const timers = fakeTimers();
    const session = open(mod, timers);
    const running = mod.main();

    const held = visit(session);
    ackRenders(held);
    await until(() => lastRequest(held.received)?.method === "waitForCommand", "the stop");
    held.close();

    const [runSide, terminalSide] = memoryChannelPair();
    const received: AttachMessage[] = [];
    terminalSide.onMessage((raw) => {
      const message = parseAttachMessage(raw);
      if (message !== null) {
        received.push(message);
      }
    });
    session.admit(runSide, "terminal");
    await until(() => received.length > 0, "the refusal");
    expect(received[0]).toMatchObject({
      type: "refused",
      reason: expect.stringMatching(/by agency debug session$/),
    });

    session.detach();
    expect((await running).data).toBe(3);
  });
});
