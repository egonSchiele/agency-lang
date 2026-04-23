import { describe, expect, it } from "vitest";
import { formatSource } from "./formatter.js";

describe("formatSource", () => {
  it("does not inject stdlib imports when formatting user source", () => {
    const formatted = formatSource("node main(){print(1)}\n");
    expect(formatted).toContain("node main()");
    expect(formatted).not.toContain('import {');
    expect(formatted).not.toContain('"std::index"');
  });
});
