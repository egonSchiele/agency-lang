import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import * as serve from "./public.js";

describe("agency-lang/serve public surface", () => {
  it("exports the runtime functions", () => {
    expect(typeof serve.createServeHandler).toBe("function");
    expect(typeof serve.collectServeMetadata).toBe("function");
  });

  it("is mapped to the ./serve subpath in package.json exports", () => {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    expect(pkg.exports["./serve"]).toBeDefined();
    expect(pkg.exports["./serve"].import).toBe("./dist/lib/serve/public.js");
  });
});
