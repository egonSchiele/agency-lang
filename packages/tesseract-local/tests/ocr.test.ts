import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readText } from "../src/ocr.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "hello.png");

// Downloads real language data on the first run (about 4 MB). Skipped on CI.
const FIRST_RUN_DOWNLOAD_TIMEOUT_MS = 120_000;

describe("readText", () => {
  let tmp: string;
  beforeEach(() => {
    // realpath: on macOS os.tmpdir() sits under /var, which is a symlink.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tess-ocr-")));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses an empty path", async () => {
    await expect(readText("")).rejects.toThrow(/filepath/);
  });

  it("refuses a symlink to the image, before any language data is needed", async () => {
    const link = path.join(tmp, "link.png");
    fs.symlinkSync(fixture, link);
    await expect(readText(link)).rejects.toThrow();
  });

  it.skipIf(process.env.CI)(
    "reads the fixture",
    async () => {
      const text = await readText(fixture);
      expect(text.replace(/\s+/g, " ").trim()).toBe("HELLO AGENCY OCR TEST");
    },
    FIRST_RUN_DOWNLOAD_TIMEOUT_MS,
  );
});
