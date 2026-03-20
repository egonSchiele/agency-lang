import { describe, it, expect } from "vitest";
import { ts, $ } from "./builders.js";
import { printTs } from "./prettyPrint.js";
import { auditNode } from "./audit.js";

describe("auditNode", () => {
  it("returns audit call for assign", () => {
    const node = ts.assign(ts.self("x"), ts.num(5));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!.node);
    expect(code).toContain("__ctx.audit");
    expect(code).toContain('"assignment"');
    expect(code).toContain('"__self.x"');
    expect(code).toContain("__self.x");
    expect(result!.behavior).toBe("append");
  });

  it("returns audit call for varDecl", () => {
    const node = ts.constDecl("myVar", ts.num(42));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!.node);
    expect(code).toContain('"assignment"');
    expect(code).toContain('"myVar"');
    expect(result!.behavior).toBe("append");
  });

  it("returns audit call for call", () => {
    const node = ts.call(ts.id("myFunc"), [ts.str("arg1")]);
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!.node);
    expect(code).toContain('"functionCall"');
    expect(code).toContain('"myFunc"');
    expect(result!.behavior).toBe("append");
  });

  it("returns replace behavior for return", () => {
    const node = ts.return(ts.num(42));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    // Return audit should be a statements node: [auditCall, originalReturn]
    expect(result!.node.kind).toBe("statements");
    expect(result!.behavior).toBe("replace");
  });

  it("returns replace behavior for functionReturn", () => {
    const node: any = { kind: "functionReturn", value: ts.num(42) };
    const result = auditNode(node);
    expect(result).not.toBeNull();
    expect(result!.node.kind).toBe("statements");
    expect(result!.behavior).toBe("replace");
  });

  it("unwraps await and inspects inner", () => {
    const node = ts.await(ts.call(ts.id("fetchData"), []));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!.node);
    expect(code).toContain('"functionCall"');
    expect(code).toContain('"fetchData"');
  });

  it("returns null for comment", () => {
    const node = ts.comment("this is a comment");
    expect(auditNode(node)).toBeNull();
  });

  it("returns null for if", () => {
    const node = ts.if(ts.bool(true), ts.statements([]));
    expect(auditNode(node)).toBeNull();
  });

  it("returns null for empty", () => {
    const node: any = { kind: "empty" };
    expect(auditNode(node)).toBeNull();
  });

  it("emits per-variable audits for array destructuring assignment (Promise.all pattern)", () => {
    // Simulates: [__self.x, __self.y] = await Promise.all([__self.x, __self.y])
    const node = ts.assign(
      ts.arr([ts.self("x"), ts.self("y")]),
      ts.await(
        ts.call(ts.prop(ts.id("Promise"), "all"), [
          ts.arr([ts.self("x"), ts.self("y")]),
        ]),
      ),
    );
    const result = auditNode(node);
    expect(result).not.toBeNull();
    // Should be a statements node with two audit calls
    expect(result!.node.kind).toBe("statements");
    const code = printTs(result!.node);
    expect(code).toContain('"__self.x"');
    expect(code).toContain('"__self.y"');
    expect(result!.behavior).toBe("append");
  });

  it("handles statements by auditing first meaningful child", () => {
    const node = ts.statements([
      ts.comment("ignore me"),
      ts.assign(ts.self("y"), ts.str("hello")),
    ]);
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!.node);
    expect(code).toContain('"assignment"');
  });
});
