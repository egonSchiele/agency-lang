import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { collectAgencyBundle, validateBundleCompiles } from "./bundle.js";

const SINGLE = `export node main(message: string) {\n  return message\n}\n`;
const HELPERS = `export def helper(x: string): string {\n  """h"""\n  return x\n}\n`;
const IMPORTS_HELPER = `import { helper } from "./helpers.agency"\n\nexport node main(x: string) {\n  return helper(x)\n}\n`;
const WITH_TS_INTEROP = `import { helper } from "./helpers.js"\n\nexport node main(x: string) {\n  return x\n}\n`;
const IMPORTS_NESTED = `import { deep } from "./sub/deep.agency"\n\nexport node main(x: string) {\n  return x\n}\n`;

let dir: string;
const write = (name: string, contents: string): string => {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    const soloPath = write("solo.agency", SINGLE);
    const result = collectAgencyBundle(soloPath, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.entrypoint).toBe("solo.agency");
    expect(result.bundle.files).toEqual([
      { name: "solo.agency", contents: SINGLE, absPath: soloPath },
    ]);
  });

  it("bundles the entrypoint and its sibling .agency imports", () => {
    write("helpers.agency", HELPERS);
    const mainPath = write("main.agency", IMPORTS_HELPER);
    const result = collectAgencyBundle(mainPath, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.entrypoint).toBe("main.agency");
    expect(result.bundle.files.map((f) => f.name).sort()).toEqual([
      "helpers.agency",
      "main.agency",
    ]);
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

  it("refuses an import that resolves outside the entrypoint's directory", () => {
    write("sub/deep.agency", HELPERS);
    const result = collectAgencyBundle(write("nested.agency", IMPORTS_NESTED), {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("outside the entrypoint's directory");
  });

  it("errors clearly when the entrypoint does not exist", () => {
    const result = collectAgencyBundle(path.join(dir, "missing.agency"), {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("Entrypoint not found");
  });
});

describe("validateBundleCompiles", () => {
  it("passes for a self-contained file", () => {
    const soloPath = write("v-solo.agency", SINGLE);
    const bundle = {
      entrypoint: "v-solo.agency",
      files: [{ name: "v-solo.agency", contents: SINGLE, absPath: soloPath }],
    };
    expect(validateBundleCompiles(bundle, {})).toEqual({ ok: true });
  });

  it("passes for a multi-file agent (imports resolve via sourcePath)", () => {
    write("v-helpers.agency", HELPERS);
    const mainPath = write("v-main.agency", IMPORTS_HELPER.replace("helpers", "v-helpers"));
    const helpersPath = path.join(dir, "v-helpers.agency");
    const bundle = {
      entrypoint: "v-main.agency",
      files: [
        { name: "v-helpers.agency", contents: HELPERS, absPath: helpersPath },
        { name: "v-main.agency", contents: IMPORTS_HELPER.replace("helpers", "v-helpers"), absPath: mainPath },
      ],
    };
    expect(validateBundleCompiles(bundle, {})).toEqual({ ok: true });
  });

  it("reports the file and error when compilation fails", () => {
    const badPath = write("bad.agency", "node main( {");
    const broken = {
      entrypoint: "bad.agency",
      files: [{ name: "bad.agency", contents: "node main( {", absPath: badPath }],
    };
    const result = validateBundleCompiles(broken, {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("bad.agency");
  });
});
