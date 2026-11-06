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
});
