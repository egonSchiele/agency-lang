import { expect, it } from "vitest";

import { onSignals, type SignalProcess } from "./signals.js";

function fakeProcess() {
  const listeners: Record<string, (() => void)[]> = {};
  const exits: number[] = [];
  const proc: SignalProcess = {
    on: (event, listener) => {
      listeners[event] = [...(listeners[event] ?? []), listener];
    },
    removeListener: (event, listener) => {
      listeners[event] = (listeners[event] ?? []).filter((other) => other !== listener);
    },
    exit: (code) => {
      exits.push(code);
      return undefined as never;
    },
  };
  const send = (signal: string): void => (listeners[signal] ?? []).forEach((listener) => listener());
  return { proc, send, exits, listeners };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function setUp() {
  const fake = fakeProcess();
  const calls: string[] = [];
  let clock = 10_000;
  const remove = onSignals(
    {
      onFirst: () => calls.push("first"),
      onSecond: async () => {
        calls.push("second");
      },
    },
    { process: fake.proc, now: () => clock },
  );
  return { ...fake, calls, remove, advance: (ms: number) => (clock += ms) };
}

it("calls onFirst on the first signal and does not exit", async () => {
  const { send, calls, exits } = setUp();
  send("SIGINT");
  await settle();
  expect(calls).toEqual(["first"]);
  expect(exits).toEqual([]);
});

it("ignores a repeat that arrives within a second", async () => {
  const { send, calls, exits, advance } = setUp();
  send("SIGINT");
  advance(100);
  send("SIGINT");
  await settle();
  expect(calls).toEqual(["first"]);
  expect(exits).toEqual([]);
});

it("on a later second signal, calls onSecond and then exits with the signal's code", async () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    const { send, calls, exits, advance } = setUp();
    send("SIGINT");
    advance(2000);
    send(signal);
    await settle();
    expect(calls).toEqual(["first", "second"]);
    expect(exits).toEqual([code]);
  }
});

it("exits even when onSecond fails, and runs it only once", async () => {
  const fake = fakeProcess();
  let seconds = 0;
  let clock = 0;
  onSignals(
    {
      onFirst: () => {},
      onSecond: async () => {
        seconds += 1;
        throw new Error("delete failed");
      },
    },
    { process: fake.proc, now: () => clock },
  );
  fake.send("SIGINT");
  clock += 5000;
  fake.send("SIGINT");
  fake.send("SIGINT");
  await settle();
  expect(seconds).toBe(1);
  expect(fake.exits).toEqual([130]);
});

it("removes its handlers when asked", () => {
  const { remove, listeners } = setUp();
  remove();
  expect(Object.values(listeners).flat()).toEqual([]);
});
