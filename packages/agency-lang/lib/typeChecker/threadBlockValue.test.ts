import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const notAssignable = (source: string) =>
  typecheckSource(source).filter((error) => /not assignable/.test(error.message));

describe("the value of a thread block is a list of messages", () => {
  it.each(["thread", "subthread"])("refuses a %s block where a string is declared", (keyword) => {
    const source = `def f(): string {
  const a: string = ${keyword} {
    const x = 1
  }
  return a
}`;
    expect(notAssignable(source).length).toBeGreaterThan(0);
  });

  it("refuses the block even when it holds a return of the declared type", () => {
    const source = `def f(): string {
  const a: number = thread {
    return "hi"
  }
  return "done"
}`;
    expect(notAssignable(source).length).toBeGreaterThan(0);
  });

  it("refuses returning the value from a function declared to return a string", () => {
    const source = `def f(): string {
  const a = thread {
    const x = 1
  }
  return a
}`;
    expect(notAssignable(source).length).toBeGreaterThan(0);
  });

  it("allows the value as a list", () => {
    const source = `def f(): number {
  const messages = thread {
    const x = 1
  }
  const typed: any[] = thread {
    const y = 2
  }
  return messages.length + typed.length
}`;
    expect(typecheckSource(source)).toEqual([]);
  });

  it("still allows the value as a list when nothing in the block returns", () => {
    const source = `def f(): number {
  const messages = thread {
    const x = 1
  }
  return messages.length
}`;
    expect(returnWarnings(source)).toEqual([]);
  });
});

const returnWarnings = (source: string) =>
  typecheckSource(source).filter((error) => error.code === "AG6046");

describe("a return inside a thread block used as a value (AG6046)", () => {
  it("warns when the variable has no annotation, where no type error can", () => {
    const source = `def greet(): string {
  const step = thread {
    return llm("Say hello.")
  }
  print("got \${step}")
  return "done"
}`;
    const warnings = returnWarnings(source);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].message).toContain("'step'");
    expect(warnings[0].loc?.line).toBe(2);
  });

  it("warns for a subthread, and for a return nested in an if or a loop", () => {
    const source = `def greet(items: string[]): string {
  const step = subthread {
    if (items.length == 0) {
      return "none"
    }
    for (item in items) {
      return item
    }
  }
  return "done"
}`;
    expect(returnWarnings(source)).toHaveLength(2);
  });

  it("warns once for a return inside a thread value nested in another", () => {
    const source = `def greet(): string {
  const outer = thread {
    const inner = thread {
      return "hi"
    }
  }
  return "done"
}`;
    expect(returnWarnings(source)).toHaveLength(1);
  });

  it("does not warn for a return that belongs to a block argument", () => {
    const source = `def lengths(items: string[]): number[] {
  let out: number[] = []
  const messages = thread {
    out = map(items) as item {
      return item.length
    }
  }
  return out
}`;
    expect(returnWarnings(source)).toEqual([]);
  });

  it("does not warn for a thread block that is a statement", () => {
    const source = `def greet(): string {
  thread {
    return llm("Say hello.")
  }
  return "done"
}`;
    expect(returnWarnings(source)).toEqual([]);
  });
});
