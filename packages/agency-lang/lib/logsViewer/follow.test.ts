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

  it("reassembles a multi-byte char split across poll boundaries", async () => {
    // "€" is 3 UTF-8 bytes (E2 82 AC). Append the first two bytes, let a
    // poll consume them, then append the rest. A naive per-poll
    // `buf.toString("utf-8")` would corrupt both halves into U+FFFD; the
    // StringDecoder must hold the partial char and complete it next poll.
    const p = makeTempFile("");
    const chunks: string[] = [];
    const watcher = follow({
      path: p,
      onAppend: (s) => chunks.push(s),
      intervalMs: 50,
    });
    try {
      const euro = Buffer.from("€\n", "utf-8");
      fs.appendFileSync(p, euro.subarray(0, 2));
      // Give the poller a few cycles: the partial char must be buffered,
      // never emitted as garbage.
      await sleep(180);
      expect(chunks.join("")).toBe("");
      fs.appendFileSync(p, euro.subarray(2));
      for (let i = 0; i < 20 && !chunks.join("").includes("\n"); i++) {
        await sleep(60);
      }
      expect(chunks.join("")).toBe("€\n");
      expect(chunks.join("")).not.toContain("�");
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
