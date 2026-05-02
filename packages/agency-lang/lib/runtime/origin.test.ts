import { describe, it, expect } from "vitest";
import { moduleIdToOrigin } from "./origin.js";

describe("moduleIdToOrigin", () => {
  it("maps stdlib paths to std:: namespace", () => {
    expect(moduleIdToOrigin("stdlib/fs.agency")).toBe("std::fs");
    expect(moduleIdToOrigin("stdlib/shell.agency")).toBe("std::shell");
    expect(moduleIdToOrigin("stdlib/http.agency")).toBe("std::http");
    expect(moduleIdToOrigin("stdlib/index.agency")).toBe("std::index");
  });

  it("maps local files to ./ relative paths", () => {
    expect(moduleIdToOrigin("foo.agency")).toBe("./foo.agency");
    expect(moduleIdToOrigin("src/agents/deploy.agency")).toBe("./src/agents/deploy.agency");
  });

  it("maps package paths to pkg:: namespace", () => {
    expect(moduleIdToOrigin("node_modules/my-pkg/index.agency")).toBe("pkg::my-pkg");
    expect(moduleIdToOrigin("node_modules/@scope/pkg/foo.agency")).toBe("pkg::@scope/pkg/foo");
  });
});
