import { describe, expect, it } from "vitest";
import { forwardSigintTo } from "./sigintForwarder.js";

function fakeChild() {
  const signals: string[] = [];
  return { signals, kill: (signal: string) => signals.push(signal) };
}

describe("forwardSigintTo", () => {
  it("installs one listener for many children and removes it when the last one leaves", () => {
    const before = process.listenerCount("SIGINT");
    const children = Array.from({ length: 15 }, fakeChild);
    const stops = children.map((child) => forwardSigintTo(child));
    expect(process.listenerCount("SIGINT")).toBe(before + 1);

    process.emit("SIGINT");
    for (const child of children) expect(child.signals).toEqual(["SIGINT"]);

    stops.slice(0, 14).forEach((stop) => stop());
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    stops[14]();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("stops forwarding to a child that has settled", () => {
    const done = fakeChild();
    const running = fakeChild();
    const stopDone = forwardSigintTo(done);
    const stopRunning = forwardSigintTo(running);
    stopDone();
    stopDone(); // a second call is harmless

    process.emit("SIGINT");
    expect(done.signals).toEqual([]);
    expect(running.signals).toEqual(["SIGINT"]);
    stopRunning();
  });
});
