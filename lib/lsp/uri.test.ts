import { describe, expect, it } from "vitest";
import * as path from "path";
import { pathToUri, uriToPath } from "./uri.js";

describe("uri helpers", () => {
  it("round-trips file paths through file URIs", () => {
    const fsPath = path.resolve("/tmp/agency path/test.agency");
    const uri = pathToUri(fsPath);
    expect(uri.startsWith("file://")).toBe(true);
    expect(uriToPath(uri)).toBe(fsPath);
  });
});
