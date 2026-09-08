import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function errors(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info)
    .errors.filter((e) => e.severity === "error")
    .map((e) => e.message);
}

const RAISER = `
effect ask { q: string }
def raiser(): string {
  interrupt ask("x", { q: "h" })
  return "ok"
}
`;

describe("narrowing inside an inline handler body (issue #612)", () => {
  it("narrows a Result guarded with `is success` / `is failure` in the handler", () => {
    expect(
      errors(`
${RAISER}
node main() {
  handle {
    return raiser()
  } with (data) {
    const contents = try raiser()
    if (contents is failure(err)) {
      let m: string = err
    }
    if (contents is success(text)) {
      let t: string = text
    }
    return approve()
  }
}
`),
    ).toEqual([]);
  });

  it("narrows with isSuccess / isFailure in the handler too", () => {
    expect(
      errors(`
${RAISER}
def work(): string {
  handle {
    return raiser()
  } with (data) {
    const contents = try raiser()
    if (isFailure(contents)) {
      let m = contents.error
    }
    return approve()
  }
  return "x"
}
`),
    ).toEqual([]);
  });

  it("treats a local the handle body declares as possibly unset in the handler", () => {
    const out = errors(`
${RAISER}
def work(): string {
  handle {
    const name: string = raiser()
    return name
  } with (data) {
    let seen: string = name
    return approve()
  }
  return "x"
}
`);
    expect(out.some((m) => m.includes("'string | null' is not assignable to type 'string'"))).toBe(
      true,
    );
  });

  it("does not keep a narrowing the handle body may have undone", () => {
    const out = errors(`
type U = { kind: "a", v: string } | { kind: "b", w: number }
${RAISER}
def work(u: U, other: U): string {
  if (u.kind == "a") {
    handle {
      u = other
      return raiser()
    } with (data) {
      let s = u.v
      return approve()
    }
  }
  return "x"
}
`);
    expect(out.some((m) => m.includes("not available on every member"))).toBe(true);
  });

  it("keeps the handler parameter bound when the handle body declares a local of the same name", () => {
    expect(
      errors(`
${RAISER}
def work(): string {
  handle {
    const data: number = 1
    return raiser()
  } with (data) {
    let m: string = data.message
    return approve()
  }
  return "x"
}
`),
    ).toEqual([]);
  });
});

describe("narrowing in code after a `return match(...)` (issue #538)", () => {
  it("still narrows a try-result guarded with `is success` / `is failure`", () => {
    expect(
      errors(`
${RAISER}
def cmd(): boolean { return true }

def dispatch(m: string): boolean {
  return match(m) {
    "" => true
    "/x" => cmd()
  }
  const r = try raiser()
  if (r is success(v)) {
    let s: string = v
  } else if (r is failure(e)) {
    let msg: string = e
  }
  return true
}
`),
    ).toEqual([]);
  });

  it("keeps post-guard narrowing across statements in dead code", () => {
    expect(
      errors(`
${RAISER}
def f(): string {
  return "early"
  const r = try raiser()
  if (isFailure(r)) {
    return "failed"
  }
  return r.value
}
`),
    ).toEqual([]);
  });

  it("keeps a narrowing established before the exit in the dead code after it", () => {
    expect(
      errors(`
${RAISER}
def f(): string {
  const r = try raiser()
  if (isFailure(r)) {
    return "failed"
  }
  return r.value
  let again: string = r.value
  return again
}
`),
    ).toEqual([]);
  });

  it("does not let a dead match yield undo narrowing established before the match", () => {
    expect(
      errors(`
${RAISER}
def f(c: boolean): string {
  const r = try raiser()
  if (isFailure(r)) {
    return "f"
  }
  const x = match (r.value) {
    "a" => {
      if (c) {
        return "1"
      } else {
        return "2"
      }
      return "3"
    }
    _ => "5"
  }
  return r.value
}
`),
    ).toEqual([]);
  });
});
