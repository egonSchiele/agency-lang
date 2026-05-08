import { describe, expect, it } from "vitest";
import { graphNodeParser } from "./parsers.js";

describe("export node", () => {
  it("parses export node", () => {
    const result = graphNodeParser(`export node main() {\n  print("hello")\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.nodeName).toBe("main");
    }
  });

  it("parses node without export", () => {
    const result = graphNodeParser(`node main() {\n  print("hello")\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBeUndefined();
    }
  });
});
