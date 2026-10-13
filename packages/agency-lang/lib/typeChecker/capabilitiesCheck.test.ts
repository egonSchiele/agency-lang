import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const messagesOf = (src: string) => typecheckSource(src).map((e) => e.message);
const aboutCapabilities = (src: string) =>
  messagesOf(src).filter((m) => /capabilit/i.test(m) && !/raises/.test(m));

describe("@capabilities checking", () => {
  it("accepts known names on a def and on a node, and a tag with no names", () => {
    expect(
      aboutCapabilities(
        "@capabilities(fileRead, subprocess)\nexport def a(path: string): string { return path }\n" +
          '@capabilities()\ndef b(): string { return "x" }\n' +
          '@capabilities(network)\nnode main() {\n  const x = a("p")\n}',
      ),
    ).toEqual([]);
  });

  it("errors on an unknown name and suggests the closest one", () => {
    const msgs = messagesOf("@capabilities(flies)\ndef load(path: string): string { return path }");
    expect(
      msgs.find((m) => /Unknown capability 'flies' on 'load'\. Did you mean 'fileRead'\?/.test(m)),
    ).toBeDefined();
  });

  it("errors on a non-identifier argument", () => {
    const msgs = messagesOf(
      '@capabilities("fileRead")\ndef load(path: string): string { return path }',
    );
    expect(
      msgs.find((m) =>
        /@capabilities arguments must be bare capability names \(on 'load'\)/.test(m),
      ),
    ).toBeDefined();
  });

  it("errors on a repeated tag", () => {
    const msgs = messagesOf(
      "@capabilities(fileRead)\n@capabilities(network)\ndef sync(path: string): string { return path }",
    );
    expect(
      msgs.find((m) => /@capabilities appears more than once on 'sync'/.test(m)),
    ).toBeDefined();
  });

  it("errors on a tag above an effect declaration and says where to move it", () => {
    const msgs = messagesOf("@capabilities(subprocess)\neffect app::shell { command: string }");
    expect(
      msgs.find((m) =>
        /@capabilities goes on a def or a node\. Move it to the function that raises the effect\./.test(
          m,
        ),
      ),
    ).toBeDefined();
  });

  it("errors on a tag above a static const, a bare call, a type alias, and at the end of a file", () => {
    const cases = [
      '@capabilities(fileRead)\nstatic const x = "a"',
      '@capabilities(fileRead)\nprint("a")',
      "@capabilities(fileRead)\ntype T = { a: string }",
      'def f(): string { return "a" }\n@capabilities(fileRead)',
    ];
    for (const src of cases) {
      const msgs = messagesOf(src);
      expect(msgs.find((m) => /^@capabilities goes on a def or a node\.$/.test(m))).toBeDefined();
    }
  });

  it("checks the names only inside the tag", () => {
    // A program may still use the capability names as its own names.
    const msgs = messagesOf(
      "def terminal(network: string): string { return network }\n" +
        'node main() { const fileRead = terminal("x") }',
    );
    expect(msgs.filter((m) => /capabilit/i.test(m))).toEqual([]);
  });
});
