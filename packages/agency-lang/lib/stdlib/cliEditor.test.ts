import { describe, expect, it } from "vitest";
import { installEditorKey } from "./cliEditor.js";

describe("installEditorKey", () => {
  const CTRL_G = { name: "g", ctrl: true };

  function harness(useTTY = true) {
    const passed: unknown[] = [];
    const fakeRl = {
      line: "half a prompt",
      _ttyWrite(sequence: unknown, key: unknown) {
        passed.push([sequence, key]);
      },
    };
    const editorKey = installEditorKey(fakeRl as never, useTTY);
    return { fakeRl, passed, editorKey };
  }

  it("records the typed text and submits the line at the prompt", () => {
    const { fakeRl, passed, editorKey } = harness();
    editorKey.atPrompt(true);
    fakeRl._ttyWrite(undefined, CTRL_G);
    expect(passed).toEqual([["\r", { name: "return" }]]);
    expect(editorKey.takeTyped()).toBe("half a prompt");
  });

  it("gives the typed text once", () => {
    const { fakeRl, editorKey } = harness();
    editorKey.atPrompt(true);
    fakeRl._ttyWrite(undefined, CTRL_G);
    editorKey.takeTyped();
    expect(editorKey.takeTyped()).toBeNull();
  });

  it("passes the key through while a turn runs", () => {
    const { fakeRl, passed, editorKey } = harness();
    editorKey.atPrompt(true);
    editorKey.atPrompt(false);
    fakeRl._ttyWrite(undefined, CTRL_G);
    expect(passed).toEqual([[undefined, CTRL_G]]);
    expect(editorKey.takeTyped()).toBeNull();
  });

  it("passes other keys through", () => {
    const { fakeRl, passed, editorKey } = harness();
    editorKey.atPrompt(true);
    fakeRl._ttyWrite("g", { name: "g" });
    expect(passed).toEqual([["g", { name: "g" }]]);
    expect(editorKey.takeTyped()).toBeNull();
  });

  it("restores the original key handler on teardown", () => {
    const { fakeRl, passed, editorKey } = harness();
    editorKey.atPrompt(true);
    editorKey.teardown();
    fakeRl._ttyWrite(undefined, CTRL_G);
    expect(passed).toEqual([[undefined, CTRL_G]]);
  });

  it("leaves the key handler alone without a terminal", () => {
    const { fakeRl, passed, editorKey } = harness(false);
    editorKey.atPrompt(true);
    fakeRl._ttyWrite(undefined, CTRL_G);
    expect(passed).toEqual([[undefined, CTRL_G]]);
    expect(editorKey.takeTyped()).toBeNull();
  });
});
