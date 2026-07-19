import { describe, it, expect } from "vitest";
import { _getNodesOfType } from "./agency.js";

describe("std::agency walks comprehension contents", () => {
  it("finds a call written inside a comprehension body", () => {
    const src = [
      "node main() {",
      "  const r = [double(x) for x in xs]",
      "}",
    ].join("\n");

    const calls = _getNodesOfType(src, ["functionCall"]) as any[];
    const names = calls.map((c) => c.functionName);
    expect(names).toContain("double");
  });

  it("finds a call in the iterable and in the filter", () => {
    const src = [
      "node main() {",
      "  const r = [x for x in getItems() if keep(x)]",
      "}",
    ].join("\n");

    const names = (_getNodesOfType(src, ["functionCall"]) as any[]).map(
      (c) => c.functionName,
    );
    expect(names).toContain("getItems");
    expect(names).toContain("keep");
  });
});
