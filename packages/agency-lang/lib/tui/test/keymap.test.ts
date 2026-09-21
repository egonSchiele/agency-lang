import { describe, expect, it } from "vitest";
import {
  cursorBindings,
  duplicateKeys,
  helpFrom,
  hintsFrom,
  runKey,
  type CursorMoves,
  type KeyBinding,
} from "../keymap.js";

type TestAction = { kind: "back" } | { kind: "none" };
const NONE: TestAction = { kind: "none" };

/** A CursorMoves that records nothing; each test overrides what it needs. */
function stillMoves(): CursorMoves {
  return { by: () => {}, toTop: () => {}, toBottom: () => {}, page: () => 10, halfPage: () => 5 };
}

function sampleBindings(log: string[], drillable: boolean): KeyBinding<TestAction>[] {
  return [
    { keys: ["j", "Down"], help: "move down", hint: "j k move", run: () => void log.push("down") },
    {
      keys: ["Enter"],
      help: "drill in",
      hint: "⏎ drill",
      when: () => drillable,
      run: () => ({ kind: "back" }),
    },
    { keys: ["x"], help: "a key with no footer hint", run: () => void log.push("x") },
  ];
}

describe("runKey", () => {
  it("runs the binding that owns the key, and falls back when it returns nothing", () => {
    const log: string[] = [];
    expect(runKey(sampleBindings(log, true), "Down", NONE)).toEqual({ kind: "none" });
    expect(log).toEqual(["down"]);
  });

  it("passes an action through", () => {
    expect(runKey(sampleBindings([], true), "Enter", NONE)).toEqual({ kind: "back" });
  });

  it("skips a binding whose condition is false", () => {
    expect(runKey(sampleBindings([], false), "Enter", NONE)).toEqual({ kind: "none" });
  });

  it("an unknown key does nothing", () => {
    expect(runKey(sampleBindings([], true), "Z", NONE)).toEqual({ kind: "none" });
  });
});

describe("what is derived from the table", () => {
  it("help lists every binding, keys then meaning", () => {
    expect(helpFrom(sampleBindings([], true))).toEqual([
      "j / Down — move down",
      "Enter — drill in",
      "x — a key with no footer hint",
    ]);
  });

  it("the footer lists only bindings that have a hint and are available now", () => {
    expect(hintsFrom(sampleBindings([], true))).toBe("j k move   ⏎ drill");
    expect(hintsFrom(sampleBindings([], false))).toBe("j k move");
  });

  it("finds a key bound twice", () => {
    const twice = [
      ...sampleBindings([], true),
      { keys: ["j"], help: "again", run: () => undefined },
    ];
    expect(duplicateKeys(twice)).toEqual(["j"]);
  });
});

describe("cursorBindings", () => {
  it("binds the keys every Agency TUI shares", () => {
    const keys = cursorBindings<TestAction>(stillMoves()).flatMap((binding) => binding.keys);
    expect(keys).toEqual([
      "j",
      "Down",
      "k",
      "Up",
      "g",
      "G",
      "Ctrl+F",
      "PageDown",
      "Ctrl+B",
      "PageUp",
      "Ctrl+D",
      "Ctrl+U",
    ]);
  });

  it("a full page is what the screen reports, and Ctrl+D is half of it", () => {
    const moved: number[] = [];
    const bindings = cursorBindings<TestAction>({
      by: (delta) => void moved.push(delta),
      toTop: () => {},
      toBottom: () => {},
      page: () => 20,
      halfPage: () => 10,
    });
    for (const key of ["Ctrl+F", "PageUp", "Ctrl+D", "Ctrl+U"]) {
      runKey(bindings, key, NONE);
    }
    expect(moved).toEqual([20, -20, 10, -10]);
  });
});
