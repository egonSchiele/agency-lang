import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _recognizeTextLocalWith, parseBlocks, type OsascriptRunner } from "./ocr.js";

const ONE_BLOCK = JSON.stringify([
  { text: "HELLO", confidence: 1, box: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 } },
]);

describe("_recognizeTextLocalWith", () => {
  let tmp: string;
  let image: string;
  beforeEach(() => {
    // realpath: on macOS os.tmpdir() sits under /var, which is a symlink,
    // and fixedPath refuses a spelling with a link in it.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-")));
    image = path.join(tmp, "a.png");
    fs.writeFileSync(image, "pretend png bytes");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a platform that is not darwin without touching the file or running anything", async () => {
    let called = false;
    const runner: OsascriptRunner = async () => {
      called = true;
      return ONE_BLOCK;
    };
    await expect(
      _recognizeTextLocalWith(runner, "linux", path.join(tmp, "missing.png"), "", false),
    ).rejects.toThrow(/Vision OCR requires macOS/);
    expect(called).toBe(false);
  });

  it("refuses a missing file after approval", async () => {
    const runner: OsascriptRunner = async () => ONE_BLOCK;
    await expect(
      _recognizeTextLocalWith(runner, "darwin", path.join(tmp, "missing.png"), "", false),
    ).rejects.toThrow(/no such file/);
  });

  it("refuses a symlink at the approved spelling", async () => {
    const link = path.join(tmp, "link.png");
    fs.symlinkSync(image, link);
    const runner: OsascriptRunner = async () => ONE_BLOCK;
    await expect(_recognizeTextLocalWith(runner, "darwin", link, "", false)).rejects.toThrow();
  });

  it("surfaces a non-zero exit as an error naming osascript", async () => {
    const runner: OsascriptRunner = async () => {
      throw new Error("Command failed: osascript ... boom");
    };
    await expect(_recognizeTextLocalWith(runner, "darwin", image, "", false)).rejects.toThrow(
      /osascript/,
    );
  });

  it("rejects stdout that is not a JSON array", async () => {
    const runner: OsascriptRunner = async () => "not json";
    await expect(_recognizeTextLocalWith(runner, "darwin", image, "", false)).rejects.toThrow(
      /did not return JSON/,
    );
  });

  it("runs the shipped script by path over a temp copy, never the approved path, and removes it after", async () => {
    let seen: string[] = [];
    let tempSeen = "";
    let tempBytes = "";
    const runner: OsascriptRunner = async (args) => {
      seen = args;
      tempSeen = args[args.length - 3];
      tempBytes = fs.readFileSync(tempSeen, "utf8");
      return ONE_BLOCK;
    };
    await _recognizeTextLocalWith(runner, "darwin", image, "en-US", true);
    // The script is a file beside ocr.ts, the values ride on argv, and the
    // subprocess only ever sees a file this call wrote from validated bytes.
    const script = seen[seen.length - 4];
    expect(path.basename(script)).toBe("visionOcr.jxa");
    expect(fs.existsSync(script)).toBe(true);
    expect(seen.slice(-2)).toEqual(["en-US", "true"]);
    expect(tempSeen).not.toBe(image);
    expect(path.extname(tempSeen)).toBe(".png");
    expect(tempBytes).toBe("pretend png bytes");
    expect(fs.existsSync(tempSeen)).toBe(false);
  });

  it("removes the temp copy when the runner fails", async () => {
    let tempSeen = "";
    const runner: OsascriptRunner = async (args) => {
      tempSeen = args[args.length - 3];
      throw new Error("boom");
    };
    await expect(_recognizeTextLocalWith(runner, "darwin", image, "", false)).rejects.toThrow();
    expect(fs.existsSync(tempSeen)).toBe(false);
  });

  it("returns the parsed blocks", async () => {
    const runner: OsascriptRunner = async () => ONE_BLOCK;
    const blocks = await _recognizeTextLocalWith(runner, "darwin", image, "", false);
    expect(blocks).toEqual([
      { text: "HELLO", confidence: 1, box: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 } },
    ]);
  });
});

describe("parseBlocks", () => {
  it("rejects an element that is missing a field", () => {
    expect(() => parseBlocks(JSON.stringify([{ text: "x" }]))).toThrow(/confidence/);
  });
});
