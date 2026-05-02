import { describe, it, expect } from "vitest";
import { parallelBlockParser, seqBlockParser, bodyParser } from "./parsers.js";

describe("parallelBlockParser", () => {
  it("parses an empty parallel block", () => {
    const input = `parallel {
}`;
    const result = parallelBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("parallelBlock");
      expect(result.result.body).toEqual([]);
    }
  });

  it("parses a parallel block with two let bindings", () => {
    const input = `parallel {
  let a = foo()
  let b = bar()
}`;
    const result = parallelBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("parallelBlock");
      expect(result.result.body).toHaveLength(2);
      expect(result.result.body[0].type).toBe("assignment");
      expect(result.result.body[1].type).toBe("assignment");
    }
  });

  it("parses a parallel block containing a seq block", () => {
    const input = `parallel {
  let a = foo()
  seq {
    let b = bar()
    let c = baz(b)
  }
}`;
    const result = parallelBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.body).toHaveLength(2);
      expect(result.result.body[0].type).toBe("assignment");
      expect(result.result.body[1].type).toBe("seqBlock");
      const inner = result.result.body[1] as any;
      expect(inner.body).toHaveLength(2);
    }
  });

  it("parses nested parallel blocks", () => {
    const input = `parallel {
  let x = foo()
  parallel {
    let p = a()
    let q = b()
  }
}`;
    const result = parallelBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.body).toHaveLength(2);
      expect(result.result.body[1].type).toBe("parallelBlock");
    }
  });

  it("throws a clear error if the opening brace is missing", () => {
    // After matching `parallel`, the parser expects `{` and throws via parseError if absent.
    const input = `parallel oops`;
    expect(() => parallelBlockParser(input)).toThrow(
      /expected `\{` to open parallel block body/,
    );
  });
});

describe("seqBlockParser", () => {
  it("parses an empty seq block", () => {
    const input = `seq {
}`;
    const result = seqBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("seqBlock");
      expect(result.result.body).toEqual([]);
    }
  });

  it("parses a seq block with multiple statements", () => {
    const input = `seq {
  let a = foo()
  let b = bar(a)
  baz(b)
}`;
    const result = seqBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.body).toHaveLength(3);
    }
  });

  it("allows control flow inside seq", () => {
    const input = `seq {
  if (cond) {
    foo()
  }
  for (x in xs) {
    bar(x)
  }
}`;
    const result = seqBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.body).toHaveLength(2);
      expect(result.result.body[0].type).toBe("ifElse");
      expect(result.result.body[1].type).toBe("forLoop");
    }
  });
});

describe("parallel/seq via bodyParser integration", () => {
  it("parses a parallel block as a top-level statement in a function body", () => {
    const input = `let z = 1
parallel {
  let a = foo()
  let b = bar()
}
let w = 2
`;
    const result = bodyParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toHaveLength(3);
      expect(result.result[0].type).toBe("assignment");
      expect(result.result[1].type).toBe("parallelBlock");
      expect(result.result[2].type).toBe("assignment");
    }
  });

  it("does not confuse identifiers that start with `parallel` or `seq`", () => {
    // `parallelism` and `sequence` should parse as plain assignments, not blocks.
    const input = `let parallelism = 1
let sequence = 2
`;
    const result = bodyParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toHaveLength(2);
      expect(result.result[0].type).toBe("assignment");
      expect(result.result[1].type).toBe("assignment");
    }
  });
});
