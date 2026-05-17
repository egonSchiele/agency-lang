import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { follow } from "./follow.js";

function makeTempFile(initial = ""): string {
  const p = path.join(os.tmpdir(), `follow-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(p, initial);
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("follow", () => {
  it("emits the appended chunk when the file grows", async () => {
    const p = makeTempFile("line1\n");
    const chunks: string[] = [];
    const watcher = follow({
      path: p,
      onAppend: (s) => chunks.push(s),
      intervalMs: 50,
    });
    try {
      fs.appendFileSync(p, "line2\nline3\n");
      // Allow the polled watcher to notice.
      for (let i = 0; i < 20 && chunks.length === 0; i++) await sleep(60);
      expect(chunks.join("")).toBe("line2\nline3\n");
    } finally {
      watcher.stop();
      fs.unlinkSync(p);
    }
  });

  it("does not emit the initial file contents on startup", async () => {
    const p = makeTempFile("preexisting\n");
    const chunks: string[] = [];
    const watcher = follow({
      path: p,
      onAppend: (s) => chunks.push(s),
      intervalMs: 50,
    });
    try {
      await sleep(200);
      expect(chunks).toEqual([]);
    } finally {
      watcher.stop();
      fs.unlinkSync(p);
    }
  });

  it("stop() stops emitting further events", async () => {
    const p = makeTempFile("");
    const chunks: string[] = [];
    const watcher = follow({
      path: p,
      onAppend: (s) => chunks.push(s),
      intervalMs: 50,
    });
    watcher.stop();
    try {
      fs.appendFileSync(p, "after-stop\n");
      await sleep(200);
      expect(chunks).toEqual([]);
    } finally {
      fs.unlinkSync(p);
    }
  });
});
