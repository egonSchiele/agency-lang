import { describe, it, expect } from "vitest";
import { renderInterrupts } from "./interrupts.js";
import type { AnalysisResult } from "@/analysis/interrupts.js";

describe("renderInterrupts", () => {
  it("renders a site with no handlers as (none) under the standard header", () => {
    const r: AnalysisResult = {
      sites: [{
        site: { file: "/x/a.agency", line: 5, effect: "std::read" },
        handlers: [],
      }],
    };
    const out = renderInterrupts(r);
    expect(out).toContain("/x/a.agency:5  interrupt of effect std::read");
    expect(out).toContain("Possible enclosing handlers:");
    expect(out).toContain("(none)");
  });

  it("omits the effect clause when effect is unknown", () => {
    const r: AnalysisResult = {
      sites: [{
        site: { file: "/x/a.agency", line: 5, effect: "unknown" },
        handlers: [],
      }],
    };
    const out = renderInterrupts(r);
    expect(out).toContain("/x/a.agency:5  interrupt");
    expect(out).not.toContain("of effect");
  });

  it("renders inline and functionRef handlers in the right format", () => {
    const r: AnalysisResult = {
      sites: [{
        site: { file: "/x/a.agency", line: 5, effect: "std::read" },
        handlers: [
          { file: "/x/m.agency", line: 10, shape: "inline" },
          { file: "/x/m.agency", line: 18, shape: "functionRef", functionName: "approveReads" },
        ],
      }],
    };
    const out = renderInterrupts(r);
    expect(out).toContain("handle block at /x/m.agency:10");
    expect(out).toContain("handle via fn approveReads at /x/m.agency:18");
  });

  it("emits one block per site, separated by blank lines", () => {
    const r: AnalysisResult = {
      sites: [
        { site: { file: "/x/a.agency", line: 1, effect: "std::read" }, handlers: [] },
        { site: { file: "/x/a.agency", line: 5, effect: "std::write" }, handlers: [] },
      ],
    };
    const out = renderInterrupts(r);
    const blocks = out.trim().split(/\n\n/);
    expect(blocks).toHaveLength(2);
  });

  it("ends the output with a single trailing newline", () => {
    const r: AnalysisResult = {
      sites: [{
        site: { file: "/x/a.agency", line: 5, effect: "std::read" },
        handlers: [],
      }],
    };
    const out = renderInterrupts(r);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("returns an empty-ish (newline-only) string for no sites", () => {
    const out = renderInterrupts({ sites: [] });
    expect(out).toBe("\n");
  });
});
