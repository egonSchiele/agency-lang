import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { readDownloadManifest, recordDownload, MANIFEST_FILE } from "./localModelManifest.js";

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "manifest-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("download manifest", () => {
  it("round-trips and upserts", () => {
    withDir((dir) => {
      expect(readDownloadManifest(dir)).toEqual({});
      recordDownload(dir, "hf:org/repo:Q4_K_M", "repo.Q4_K_M.gguf");
      recordDownload(dir, "hf:org/other:Q4_K_M", "other.Q4_K_M.gguf");
      recordDownload(dir, "hf:org/repo:Q4_K_M", "repo2.gguf"); // upsert wins
      expect(readDownloadManifest(dir)).toEqual({
        "hf:org/repo:Q4_K_M": "repo2.gguf",
        "hf:org/other:Q4_K_M": "other.Q4_K_M.gguf",
      });
    });
  });

  it("tolerates a corrupt manifest (display metadata only, never throws)", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, MANIFEST_FILE), "{nope");
      expect(readDownloadManifest(dir)).toEqual({});
      recordDownload(dir, "hf:a/b:Q", "b.gguf"); // overwrites the corrupt file
      expect(readDownloadManifest(dir)).toEqual({ "hf:a/b:Q": "b.gguf" });
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

  it("recordDownload creates the dir if missing and leaves no temp file", () => {
    withDir((dir) => {
      const nested = path.join(dir, "models");
      recordDownload(nested, "hf:a/b:Q", "b.gguf");
      expect(readDownloadManifest(nested)).toEqual({ "hf:a/b:Q": "b.gguf" });
      expect(fs.readdirSync(nested)).toEqual([MANIFEST_FILE]);
    });
  });

  it("recordDownload never throws: a failed write warns instead of failing the download", () => {
    withDir((dir) => {
      // Make the "dir" a plain file so mkdirSync/writeFileSync fail.
      const blocked = path.join(dir, "not-a-dir");
      fs.writeFileSync(blocked, "occupied");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => recordDownload(blocked, "hf:a/b:Q", "b.gguf")).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
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
