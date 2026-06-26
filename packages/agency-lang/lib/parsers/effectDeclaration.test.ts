import { describe, it, expect } from "vitest";
import { effectDeclParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

describe("effectDeclParser", () => {
  it("parses a single-field payload with a namespaced effect", () => {
    const r = effectDeclParser("effect std::read { dir: string }");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "effectDeclaration",
      effect: "std::read",
      payloadType: {
        type: "objectType",
        properties: [
          { key: "dir", value: { type: "primitiveType", value: "string" } },
        ],
      },
    });
  });

  it("parses a bare effect label and multi-field payload", () => {
    const r = effectDeclParser(
      "effect deploy { service: string, version: string }",
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "effectDeclaration",
      effect: "deploy",
    });
    if (r.result.payloadType.type === "objectType") {
      expect(r.result.payloadType.properties.map((p) => p.key)).toEqual([
        "service",
        "version",
      ]);
    }
  });

  it("parses an empty payload", () => {
    const r = effectDeclParser("effect std::ping {}");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "effectDeclaration",
      effect: "std::ping",
    });
    if (r.result.payloadType.type === "objectType") {
      expect(r.result.payloadType.properties).toEqual([]);
    }
  });

  it("does not consume an effectSet declaration", () => {
    const r = effectDeclParser("effectSet FsKinds = <std::read>");
    expect(r.success).toBe(false);
  });

  it("parses a multi-line declaration with trailing comma", () => {
    // objectTypeParser already permits internal whitespace/newlines; this
    // test locks in that effect decls inherit that behavior so users can
    // format real payloads across multiple lines.
    const r = effectDeclParser(
      "effect std::write {\n  dir: string,\n  content: string,\n}",
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    if (r.result.payloadType.type === "objectType") {
      expect(r.result.payloadType.properties.map((p) => p.key)).toEqual([
        "dir",
        "content",
      ]);
    }
  });
});

describe("effect declaration at module level", () => {
  it("parses as a top-level effectDeclaration node", () => {
    const parsed = parseAgency(
      'effect std::read { dir: string }\nnode main() { print("hi") }',
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const decl = parsed.result.nodes.find(
      (n: any) => n.type === "effectDeclaration",
    );
    expect(decl).toMatchObject({ effect: "std::read" });
  });

  it("still parses an effectSet at module level (ordering)", () => {
    const parsed = parseAgency(
      'effectSet FsKinds = <std::read>\nnode main() { print("hi") }',
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      parsed.result.nodes.find(
        (n: any) => n.type === "typeAlias" && n.isEffectSet,
      ),
    ).toBeDefined();
  });

  it("parses an effect declaration inside a function body (body-dispatch wiring)", () => {
    // Pin the `_bodyNodeParser` wiring: if you forget to add
    // `effectDeclParser` next to `effectSetDeclParser` in the body
    // dispatcher, this test fails. Without it, the bug is silent because
    // every other test is module-level.
    const parsed = parseAgency(
      "def f() { effect std::read { dir: string }\n  return 1 }",
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Walk into the function body — succeeding to parse the program isn't
    // enough; we need the declaration to actually appear as a body node.
    // Without an explicit body check, a regression where the parser silently
    // discarded the declaration would still pass.
    const fn = parsed.result.nodes.find(
      (n: any) => n.type === "function" && n.functionName === "f",
    ) as any;
    expect(fn).toBeDefined();
    const decl = fn.body?.find((n: any) => n.type === "effectDeclaration");
    expect(decl).toMatchObject({
      type: "effectDeclaration",
      effect: "std::read",
    });
  });
});
