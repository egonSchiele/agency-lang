import { describe, it, expect } from "vitest";
import { ScriptedInput } from "../input/scripted.js";

describe("ScriptedInput", () => {
  it("replays key events in order", async () => {
    const input = new ScriptedInput();
    input.feedKey({ key: "a" });
    input.feedKey({ key: "b" });
    expect(await input.nextKey()).toEqual({ key: "a" });
    expect(await input.nextKey()).toEqual({ key: "b" });
  });

  it("nextKey waits for input when queue is empty", async () => {
    const input = new ScriptedInput();
    const promise = input.nextKey();
    setTimeout(() => input.feedKey({ key: "x" }), 10);
    const result = await promise;
    expect(result).toEqual({ key: "x" });
  });

  it("nextLine returns fed line", async () => {
    const input = new ScriptedInput();
    input.feedLine("hello world");
    const line = await input.nextLine("prompt>");
    expect(line).toBe("hello world");
  });

  it("constructor accepts a list of strings or KeyEvents", async () => {
    const input = new ScriptedInput(["j", "k", { key: "c", ctrl: true }]);
    expect(await input.nextKey()).toEqual({ key: "j" });
    expect(await input.nextKey()).toEqual({ key: "k" });
    expect(await input.nextKey()).toEqual({ key: "c", ctrl: true });
  });
});
