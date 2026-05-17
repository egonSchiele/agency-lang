import { describe, it, expect } from "vitest";
import { parseStatelogJsonl } from "./parse.js";

const v1 = (data: object, extra: object = {}) =>
  JSON.stringify({
    format_version: 1,
    trace_id: "t1",
    project_id: "p1",
    span_id: null,
    parent_span_id: null,
    data: { type: "debug", timestamp: "2026-05-16T00:00:00Z", ...data },
    ...extra,
  });

describe("parseStatelogJsonl", () => {
  it("parses well-formed JSONL into events", () => {
    const input = [v1({ message: "a" }), v1({ message: "b" })].join("\n") + "\n";
    const result = parseStatelogJsonl(input);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toEqual([]);
    expect(result.events[0].data.message).toBe("a");
  });

  it("skips blank lines silently", () => {
    const input = v1({}) + "\n\n\n" + v1({}) + "\n";
    const result = parseStatelogJsonl(input);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("records parse errors with line numbers but keeps going", () => {
    const input = [v1({}), "this is not json", v1({})].join("\n");
    const result = parseStatelogJsonl(input);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
  });

  it("rejects future format versions with one fatal error", () => {
    const future = JSON.stringify({
      format_version: 999,
      trace_id: "t",
      project_id: "p",
      span_id: null,
      parent_span_id: null,
      data: { type: "x", timestamp: "" },
    });
    const result = parseStatelogJsonl(future);
    expect(result.events).toHaveLength(0);
    expect(result.errors[0].kind).toBe("unsupported_version");
  });

  it("tolerates missing format_version (legacy files)", () => {
    const legacy = JSON.stringify({
      trace_id: "t",
      project_id: "p",
      span_id: null,
      parent_span_id: null,
      data: { type: "debug", timestamp: "" },
    });
    const result = parseStatelogJsonl(legacy);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].format_version).toBe(1);
  });
});
