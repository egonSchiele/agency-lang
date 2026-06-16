import { describe, it, expect } from "vitest";
import { raiseStatementParser } from "./parsers.js";

describe("raiseStatementParser", () => {
  it("parses a structured raise into an interruptStatement with viaRaise", () => {
    const r = raiseStatementParser('raise std::write("Are you sure?", { filename: "a" })');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "std::write",
      viaRaise: true,
    });
    expect(r.result.arguments.length).toBe(2);
  });

  it("parses a NON-namespaced (bare) named effect", () => {
    const r = raiseStatementParser('raise deploy("confirm?", {})');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "deploy",
      viaRaise: true,
    });
  });

  it("`raise interrupt(...)` wraps the interrupt expression → effect unknown", () => {
    const r = raiseStatementParser('raise interrupt("Interrupting main")');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "unknown",
      viaRaise: true,
    });
  });

  it("`raise interrupt EFFECT(...)` wraps a structured interrupt expression", () => {
    const r = raiseStatementParser('raise interrupt std::write("m", {})');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "std::write",
      viaRaise: true,
    });
  });

  it("parses a bare raise with effect unknown", () => {
    const r = raiseStatementParser('raise("Are you sure?")');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "unknown",
      viaRaise: true,
    });
  });

  it("does not mis-parse an identifier like raiseHand()", () => {
    const r = raiseStatementParser("raiseHand()");
    expect(r.success).toBe(false);
  });
});
