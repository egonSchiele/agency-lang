import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  mlxModelDirName,
  mlxModelDir,
  readMlxModelRecord,
  writeMlxModelRecord,
  isMlxModelComplete,
  RECORD_FILE,
} from "./mlxModelRecord.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mlxrec-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("mlx model record", () => {
  it("names the directory org--repo under mlx/", () => {
    expect(mlxModelDirName("mlx-community/Qwen3-Coder-Next-4bit")).toBe(
      "mlx-community--Qwen3-Coder-Next-4bit",
    );
    expect(mlxModelDir(dir, "org/repo")).toBe(path.join(dir, "mlx", "org--repo"));
  });

  it("round-trips a record and reports completeness", () => {
    const model = path.join(dir, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    const record = {
      repo: "org/repo",
      revision: "abc",
      files: {
        "config.json": { size: 10, complete: true },
        "model.safetensors": { size: 100, sha256: "00", complete: false, chunks: [0] },
      },
    };
    writeMlxModelRecord(model, record);
    expect(readMlxModelRecord(model)).toEqual(record);
    expect(isMlxModelComplete(record)).toBe(false);
    record.files["model.safetensors"].complete = true;
    expect(isMlxModelComplete(record)).toBe(true);
  });

  it("a missing or corrupt record reads as null", () => {
    const model = path.join(dir, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    expect(readMlxModelRecord(model)).toBeNull();
    fs.writeFileSync(path.join(model, RECORD_FILE), "{not json");
    expect(readMlxModelRecord(model)).toBeNull();
    fs.writeFileSync(path.join(model, RECORD_FILE), JSON.stringify({ repo: 1 }));
    expect(readMlxModelRecord(model)).toBeNull();
    fs.writeFileSync(
      path.join(model, RECORD_FILE),
      JSON.stringify({ repo: "o/r", revision: "x", files: { model: null } }),
    );
    expect(readMlxModelRecord(model)).toBeNull();
  });
});
