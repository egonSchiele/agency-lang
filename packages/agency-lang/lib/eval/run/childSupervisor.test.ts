import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import { makeChildSupervisor } from "./childSupervisor.js";

function harness() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const proc = {
    on: (event: string, listener: (...args: any[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: any[]) => void) =>
      emitter.removeListener(event, listener),
    exit: (code: number) => {
      exits.push(code);
      return undefined as never;
    },
  };
  const supervise = makeChildSupervisor(proc);
  const child = () => {
    const signals: string[] = [];
    return { signals, kill: (signal: string) => signals.push(signal) };
  };
  return { emitter, exits, supervise, child };
}

describe("child supervisor", () => {
  it("keeps one listener per signal however many children are live, and none when idle", () => {
    const h = harness();
    const children = Array.from({ length: 15 }, h.child);
    const stops = children.map((c) => h.supervise(c.kill));
    expect(h.emitter.listenerCount("SIGINT")).toBe(1);
    expect(h.emitter.listenerCount("SIGTERM")).toBe(1);

    h.emitter.emit("SIGINT");
    for (const c of children) expect(c.signals).toEqual(["SIGINT"]);

    stops.slice(0, 14).forEach((stop) => stop());
    expect(h.emitter.listenerCount("SIGINT")).toBe(1);
    stops[14]();
    stops[14](); // a second stop is harmless
    expect(h.emitter.listenerCount("SIGINT")).toBe(0);
  });

  it("a second signal force-quits: SIGKILL to every live child, then exit 130", () => {
    const h = harness();
    const settled = h.child();
    const stuck = h.child();
    h.supervise(settled.kill)();
    h.supervise(stuck.kill);

    h.emitter.emit("SIGINT");
    expect(stuck.signals).toEqual(["SIGINT"]);
    expect(h.exits).toEqual([]);

    h.emitter.emit("SIGINT");
    expect(stuck.signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(settled.signals).toEqual([]);
    expect(h.exits).toEqual([130]);
  });

  it("forgets a first signal once every child has settled", () => {
    const h = harness();
    const first = h.child();
    const stop = h.supervise(first.kill);
    h.emitter.emit("SIGINT");
    stop();

    const next = h.child();
    h.supervise(next.kill);
    h.emitter.emit("SIGINT");
    expect(next.signals).toEqual(["SIGINT"]);
    expect(h.exits).toEqual([]);
  });

  it("reaps live children with SIGKILL when the process exits", () => {
    const h = harness();
    const c = h.child();
    h.supervise(c.kill);
    h.emitter.emit("exit");
    expect(c.signals).toEqual(["SIGKILL"]);
  });
});
