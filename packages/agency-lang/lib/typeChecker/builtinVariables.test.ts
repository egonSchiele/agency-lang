import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

describe("__dirname builtin variable", () => {
  it("types __dirname as string", () => {
    const errs = typecheckSource(`
node main() {
  const x: number = __dirname
  return x
}
`);
    expect(errs.some((e) => /string/.test(e.message))).toBe(true);
  });

  it("allows __dirname where a string is expected", () => {
    const errs = typecheckSource(`
node main() {
  const x: string = __dirname
  return x
}
`);
    expect(errs).toEqual([]);
  });

  it("lets a local binding shadow the builtin", () => {
    const errs = typecheckSource(`
node main() {
  const __dirname: number = 5
  const y: number = __dirname
  return y
}
`);
    expect(errs).toEqual([]);
  });

  it("is not flagged by the undefined-variable diagnostic", () => {
    const errs = typecheckSource(
      `
node main() {
  print(__dirname)
  print(color.red("x"))
}
`,
      { typechecker: { undefinedVariables: "error" } },
    );
    expect(errs.filter((e) => /not defined|undefined/i.test(e.message))).toEqual(
      [],
    );
  });

  it("does not resolve prototype-chain names as builtin variables", () => {
    // A plain object lookup would find Object.prototype.toString and
    // return a function where a VariableType is expected. The guarded
    // lookup must fall through to normal (silent-any) resolution.
    const errs = typecheckSource(`
node main() {
  const x = toString
  return x
}
`);
    expect(errs).toEqual([]);
  });
});
