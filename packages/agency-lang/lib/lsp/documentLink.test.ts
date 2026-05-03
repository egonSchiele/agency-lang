import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getDocumentLinks } from "./documentLink.js";
import { parseAgency } from "../parser.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///project/test.agency", "agency", 1, content);
}

function parse(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return r.result;
}

describe("getDocumentLinks", () => {
  it("creates link for agency file import", () => {
    const source = 'import { greet } from "./helpers.agency"';
    const doc = makeDoc(source);
    const program = parse(source);
    const links = getDocumentLinks(program, doc, "/project/test.agency");
    expect(links.length).toBeGreaterThanOrEqual(1);
    const link = links.find((l) => l.target?.includes("helpers.agency"));
    expect(link).toBeDefined();
  });

  it("creates link for stdlib import", () => {
    const source = 'import { map } from "std::array"';
    const doc = makeDoc(source);
    const program = parse(source);
    const links = getDocumentLinks(program, doc, "/project/test.agency");
    const link = links.find((l) => l.target?.includes("array.agency"));
    expect(link).toBeDefined();
  });

  it("returns empty for non-agency imports", () => {
    const source = 'import { foo } from "some-npm-package"';
    const doc = makeDoc(source);
    const program = parse(source);
    const links = getDocumentLinks(program, doc, "/project/test.agency");
    // Non-agency imports should still produce a link but without a resolved target
    for (const link of links) {
      expect(link.target).toBeUndefined();
    }
  });
});
