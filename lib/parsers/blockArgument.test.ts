import { describe, it, expect } from "vitest";
import { blockArgumentParser } from "./parsers.js";
import { functionCallParser } from "./parsers.js";

describe("blockArgumentParser", () => {
  it("parses block with no params", () => {
    const input = `as {
  print("hello")
}`;
    const result = blockArgumentParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("blockArgument");
      expect(result.result.params).toEqual([]);
      expect(result.result.body.length).toBe(1);
    }
  });

  it("parses block with single param", () => {
    const input = `as item {
  print(item)
}`;
    const result = blockArgumentParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.params).toHaveLength(1);
      expect(result.result.params[0].name).toBe("item");
    }
  });

  it("parses block with multiple params", () => {
    const input = `as (prev, attempt) {
  print(prev, attempt)
}`;
    const result = blockArgumentParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.params).toHaveLength(2);
      expect(result.result.params[0].name).toBe("prev");
      expect(result.result.params[1].name).toBe("attempt");
    }
  });

  it("parses block with underscore param", () => {
    const input = `as _ {
  print("hi")
}`;
    const result = blockArgumentParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.params).toHaveLength(1);
      expect(result.result.params[0].name).toBe("_");
    }
  });

  it("fails without as keyword", () => {
    const input = `{
  print("hello")
}`;
    const result = blockArgumentParser(input);
    expect(result.success).toBe(false);
  });
});

describe("function call with block argument", () => {
  it("parses function call with no-param block", () => {
    const input = `sample(5) as {
  print("hello")
}`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("sample");
      expect(result.result.arguments).toHaveLength(1);
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.params).toEqual([]);
      expect(result.result.block!.body).toHaveLength(1);
    }
  });

  it("parses function call with single param block", () => {
    const input = `map(items) as item {
  print(item)
}`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("map");
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.params).toHaveLength(1);
      expect(result.result.block!.params[0].name).toBe("item");
    }
  });

  it("parses function call with multi param block", () => {
    const input = `retry(3) as (prev, attempt) {
  print(prev)
}`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("retry");
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.params).toHaveLength(2);
    }
  });

  it("parses function call without block (no block field)", () => {
    const result = functionCallParser("foo(1, 2)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.block).toBeUndefined();
    }
  });

  it("parses function call with no args and a block", () => {
    const input = `run() as {
  print("hi")
}`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("run");
      expect(result.result.arguments).toHaveLength(0);
      expect(result.result.block).toBeDefined();
    }
  });
});
