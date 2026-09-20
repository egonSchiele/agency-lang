import { describe, expect, it } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";
import { allCodes, errorsWithCode } from "./castTestUtils.js";

const PRELUDE = `
type Person = { name: string }

def isPositive(value: number): Result<number> {
  if (value > 0) {
    return success(value)
  }
  return failure("must be positive")
}

@validate(isPositive)
type Positive = number

type Wrapper = Positive

def use(n: any): any {
  return n
}
`;

const wrap = (body: string) =>
  `${PRELUDE}node main() {\n  const a: any = 1\n  const b: any = 2\n${body}\n}\n`;
const count = (body: string, code: string) => errorsWithCode(wrap(body), code).length;

describe("AG1016: a cast where Agency and TypeScript would group differently", () => {
  it.each(["a + b as number", "a * b as number", "a < b as boolean", "a in b as boolean"])(
    "refuses %s",
    (expr) => {
      expect(count(`  const r = ${expr}`, "AG1016")).toBe(1);
    },
  );

  it("reports every occurrence in one run", () => {
    expect(
      count(
        `  const r = a + b as number\n  const s = a - b as number\n  const t = a / b as number`,
        "AG1016",
      ),
    ).toBe(3);
  });

  it.each([
    "a + (b as number)",
    "(a + b) as number",
    "!a as boolean",
    "!(a as boolean)",
    "typeof a as string",
    "-a as number",
    "a == b as number",
    "a === b as number",
    "a != b as number",
    "a && b as boolean",
    "a || b as boolean",
    "a ?? b as number",
    "a |> use as any",
  ])("allows %s", (expr) => {
    expect(count(`  const r = ${expr}`, "AG1016")).toBe(0);
  });

  it("allows a cast on the right of a compound assignment", () => {
    expect(count(`  let n = 1\n  n += a as number`, "AG1016")).toBe(0);
  });

  it("still refuses a cast under + inside a compound assignment", () => {
    expect(count(`  let n = 1\n  n += a + b as number`, "AG1016")).toBe(1);
  });
});

describe("AG1017: a checked cast that can pause, where it cannot be lifted out", () => {
  // One case per position the hoist pass does not lift from. Every mode in
  // expressionSlots.ts that is "opaque" or "conditional" needs a row here.
  it.each([
    ["the left of catch", "const r = a as Positive! catch 0"],
    ["the right of catch", "const r = use(a) catch (b as Positive!)"],
    ["the right of &&", "const r = a && use(b as Positive!)"],
    ["the right of ||", "const r = a || use(b as Positive!)"],
    ["the right of ??", "const r = a ?? use(b as Positive!)"],
    ["a pipe stage", "const r = a |> use(b as Positive!)"],
    ["a try operand", "const r = try use(a as Positive!)"],
    ["a statement under with", "use(a as Positive!) with approve"],
  ])("refuses a tagged cast in %s", (_name, line) => {
    expect(count(`  ${line}`, "AG1017")).toBe(1);
  });

  // An if-expression lowers to an ifElse whose branches are statement
  // bodies, and the pass lifts into the branch it belongs to. The
  // agreement test in hoistPositions.test.ts pins that.
  it("allows a tagged cast in an if-expression branch", () => {
    expect(count(`  const r = if a then use(b as Positive!) else 0`, "AG1017")).toBe(0);
  });

  it("AG1019: refuses a tagged cast under a module-level static statement", () => {
    const found = allCodes(
      `${PRELUDE}static const s = use(1 as Positive!)\nnode main() {\n  return s\n}\n`,
    );
    expect(found).toContain("AG1019");
    expect(found).not.toContain("AG1017");
  });

  // The pass skips a conditional slot without walking into it, so a block
  // nested under one is never hoisted within. hoist-calls.md lists this as a
  // known gap for calls. For casts it is refused.
  it("refuses a tagged cast in a block body that sits under a conditional slot", () => {
    expect(
      count(
        `  const r = a && map([1]) as x {\n    const v = x as Positive!\n    return v\n  }`,
        "AG1017",
      ),
    ).toBe(1);
  });

  it("allows a tagged cast in a block body that the pass does reach", () => {
    expect(
      count(
        `  const r = map([1]) as x {\n    const v = x as Positive!\n    return v\n  }`,
        "AG1017",
      ),
    ).toBe(0);
  });

  it("refuses a tagged cast in a bare method-call statement, which the pass does not extract from", () => {
    expect(count(`  const xs: any = []\n  xs.push(a as Positive!)`, "AG1017")).toBe(1);
  });

  // AG1017 says "move it to its own line". These two already are, or have no
  // line to move to, so they get AG1019 with advice the author can follow.
  it("AG1019: refuses a tagged cast in a module-level initializer", () => {
    const found = allCodes(
      `${PRELUDE}const top = 1 as Positive!\nnode main() {\n  return top\n}\n`,
    );
    expect(found).toContain("AG1019");
    expect(found).not.toContain("AG1017");
  });

  // The builder asks typeRunsValidators with its own alias record. If the
  // checker's record lacked imported aliases, this would stay silent while
  // codegen emitted the pausing path.
  it("sees the tag on a type imported from another file", () => {
    const tagged = PRELUDE.replace("type Positive", "export type Positive");
    const source = `import { Positive } from "./tagged.agency"\nnode main() {\n  const a: any = 1\n  const r = a as Positive! catch 0\n}\n`;
    const report = typeCheckSource(
      source,
      "/virtual/main.agency",
      {},
      {
        "/virtual/main.agency": source,
        "/virtual/tagged.agency": tagged,
      },
    );
    expect(report.errors.map((error) => (error as { code?: string }).code)).toContain("AG1017");
  });

  it("checks expressions inside a parameter default", () => {
    const found = allCodes(
      `${PRELUDE}def f(xs: any = [1 as Positive!, 1 + 2 as number]): any {\n  return xs\n}\n`,
    );
    expect(found).toContain("AG1019");
    expect(found).toContain("AG1016");
  });

  // A handler body never pauses and the pass never rewrites one, so AG1017's
  // advice would be wrong there. AG1020 says what does help.
  it("AG1020: refuses a tagged cast in a handler body, and still reports AG1016 there", () => {
    const body = `  handle {\n    use(a)\n  } with (intr) {\n    const v = a as Positive!\n    const w = a + b as number\n    return approve()\n  }`;
    expect(count(body, "AG1020")).toBe(1);
    expect(count(body, "AG1017")).toBe(0);
    expect(count(body, "AG1016")).toBe(1);
  });

  it("AG1020: refuses it even on its own line, where moving it cannot help", () => {
    const body = `  handle {\n    use(a)\n  } with (intr) {\n    const v = a as Positive!\n    return approve()\n  }`;
    expect(count(body, "AG1020")).toBe(1);
  });

  it("allows an untagged checked cast in a handler body", () => {
    const body = `  handle {\n    use(a)\n  } with (intr) {\n    const v = a as Person!\n    return approve()\n  }`;
    expect(count(body, "AG1020")).toBe(0);
  });

  it("allows a tagged cast in the body of an if statement", () => {
    expect(count(`  if (a && b) {\n    const v = a as Positive!\n  }`, "AG1017")).toBe(0);
  });

  // These three fail loudly if the alias record or the tag search is thinner
  // than the one the builder uses. A miss here means the check fails open.
  it.each([
    ["an alias of a tagged type", "a as Wrapper! catch 0"],
    ["a Result of a tagged type", "a as Result<Positive>! catch 0"],
    ["an array of a tagged type", "a as Positive[]! catch 0"],
  ])("sees the tag through %s", (_name, expr) => {
    expect(count(`  const r = ${expr}`, "AG1017")).toBe(1);
  });

  it("allows an untagged checked cast on the left of catch", () => {
    expect(count(`  const r = a as Person! catch { name: "x" }`, "AG1017")).toBe(0);
  });

  it("allows a tagged cast on its own line and in a call argument", () => {
    expect(count(`  const r = a as Positive!\n  const s = use(a as Positive!)`, "AG1017")).toBe(0);
  });

  it("allows an unchecked cast to a tagged type anywhere", () => {
    expect(count(`  const r = a as Positive catch 0`, "AG1017")).toBe(0);
  });
});
