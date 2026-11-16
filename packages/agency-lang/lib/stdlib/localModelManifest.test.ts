import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { readDownloadManifest, MANIFEST_FILE } from "./localModelManifest.js";

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "manifest-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("download manifest", () => {
  it("reads URI → file name pairs", () => {
    withDir((dir) => {
      expect(readDownloadManifest(dir)).toEqual({});
      fs.writeFileSync(
        path.join(dir, MANIFEST_FILE),
        JSON.stringify({ "hf:org/repo:Q4_K_M": "repo.Q4_K_M.gguf" }),
      );
      expect(readDownloadManifest(dir)).toEqual({ "hf:org/repo:Q4_K_M": "repo.Q4_K_M.gguf" });
    });
  });

  it("tolerates a corrupt manifest (display metadata only, never throws)", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, MANIFEST_FILE), "{nope");
      expect(readDownloadManifest(dir)).toEqual({});
    });
  });

  it("drops non-string values instead of throwing", () => {
    withDir((dir) => {
      fs.writeFileSync(
        path.join(dir, MANIFEST_FILE),
        JSON.stringify({ good: "a.gguf", bad: 42, worse: { nested: true } }),
      );
      expect(readDownloadManifest(dir)).toEqual({ good: "a.gguf" });
    });
  });

  it("keys named like Object.prototype members are plain data (null-proto read)", () => {
    withDir((dir) => {
      // Raw string: in an object LITERAL `__proto__:` is prototype-setter
      // syntax and would never reach the JSON.
      fs.writeFileSync(
        path.join(dir, MANIFEST_FILE),
        '{"__proto__":"evil.gguf","toString":"t.gguf","normal":"n.gguf"}',
      );
      const manifest = readDownloadManifest(dir);
      expect(manifest["toString"]).toBe("t.gguf");
      expect(manifest["normal"]).toBe("n.gguf");
      expect(manifest["__proto__"]).toBe("evil.gguf"); // own key, plain data
      expect(({} as Record<string, unknown>)["__proto__"]).not.toBe("evil.gguf");
    });
  });
});
