import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { collectAgencyBundle, validateBundleCompiles } from "./bundle.js";

const SINGLE = `export node main(message: string) {\n  return message\n}\n`;
const WITH_TS_INTEROP = `import { helper } from "./helpers.js"\n\nexport node main(x: string) {\n  return x\n}\n`;
const WITH_AGENCY_IMPORT = `import { helper } from "./helpers.agency"\n\nexport node main(x: string) {\n  return x\n}\n`;

let dir: string;
const write = (name: string, contents: string): string => {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, "utf-8");
  return filePath;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(process.cwd(), "deploy-bundle-test-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("collectAgencyBundle", () => {
  it("bundles a single self-contained file", () => {
    const result = collectAgencyBundle(write("solo.agency", SINGLE), {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.entrypoint).toBe("solo.agency");
    expect(result.bundle.files).toEqual([{ name: "solo.agency", contents: SINGLE }]);
  });

  it("refuses local TypeScript/JavaScript interop imports", () => {
    const result = collectAgencyBundle(write("interop.agency", WITH_TS_INTEROP), {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("./helpers.js");
    expect(result.error).toContain("can't be deployed");
  });

  it("refuses local .agency imports (multi-file not supported yet)", () => {
    const result = collectAgencyBundle(write("multi.agency", WITH_AGENCY_IMPORT), {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("single-file");
    expect(result.error).toContain("statelog#9");
  });

  it("errors when the entrypoint does not exist", () => {
    const result = collectAgencyBundle(path.join(dir, "missing.agency"), {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("File not found");
  });
});

describe("validateBundleCompiles", () => {
  it("passes for a file that compiles", () => {
    const bundle = { entrypoint: "solo.agency", files: [{ name: "solo.agency", contents: SINGLE }] };
    expect(validateBundleCompiles(bundle, {})).toEqual({ ok: true });
  });

  it("reports the file and error when compilation fails", () => {
    const broken = { entrypoint: "bad.agency", files: [{ name: "bad.agency", contents: "node main( {" }] };
    const result = validateBundleCompiles(broken, {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("bad.agency");
  });
});
