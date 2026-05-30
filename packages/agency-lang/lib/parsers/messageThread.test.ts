import { describe, it, expect } from "vitest";
import { messageThreadParser } from "./parsers.js";
import { normalizeCode } from "@/index.js";

describe("messageThreadParser", () => {
  it("parses thread { ... } with no args", () => {
    const input = "thread {\n  foo()\n}";
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result.type).toBe("messageThread");
      expect(r.result.threadType).toBe("thread");
      expect(r.result.label).toBeNull();
      expect(r.result.summarize).toBeNull();
      expect(r.result.continueExpr).toBeNull();
      expect(r.result.sessionExpr).toBeNull();
    }
  });

  it("parses thread(label: \"x\") { ... }", () => {
    const input = 'thread(label: "coding task") {\n  foo()\n}';
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result.label).not.toBeNull();
      expect(r.result.summarize).toBeNull();
    }
  });

  it("parses thread(label, summarize) { ... }", () => {
    const input = 'thread(label: "x", summarize: true) {\n  foo()\n}';
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result.label).not.toBeNull();
      expect(r.result.summarize).not.toBeNull();
    }
  });

  it("parses thread(continue: priorId) { ... }", () => {
    const input = "thread(continue: priorId) {\n  foo()\n}";
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result.continueExpr).not.toBeNull();
      expect(r.result.sessionExpr).toBeNull();
    }
  });

  it("parses thread(session: \"coding\") { ... }", () => {
    const input = 'thread(session: "coding") {\n  foo()\n}';
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result.sessionExpr).not.toBeNull();
      expect(r.result.continueExpr).toBeNull();
    }
  });

  it("rejects unknown arg names", () => {
    const input = 'thread(bogus: "x") {\n  foo()\n}';
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(false);
  });

  it("rejects continue + session combined", () => {
    const input = 'thread(continue: priorId, session: "x") {\n  foo()\n}';
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(false);
  });

  it("parses subthread(label: \"x\") { ... }", () => {
    const input = 'subthread(label: "child") {\n  foo()\n}';
    const r = messageThreadParser(normalizeCode(input));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.result.threadType).toBe("subthread");
      expect(r.result.label).not.toBeNull();
    }
  });
});
