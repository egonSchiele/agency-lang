import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { startFakeHub, sha256hex, type FakeHub, type FakeFile } from "./__tests__/fakeHub.js";
import {
  fetchHubSnapshot,
  planChunks,
  downloadHubSnapshot,
  GATED_MESSAGE,
  type DownloadEvent,
  type HubSnapshot,
} from "./hubDownload.js";
import { readMlxModelRecord, writeMlxModelRecord, isMlxModelComplete } from "./mlxModelRecord.js";

function bytes(n: number, seed: number): Buffer {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    buf[i] = (i * 31 + seed) % 251;
  }
  return buf;
}

const FILES: FakeFile[] = [
  { path: "config.json", bytes: Buffer.from('{"a":1}') },
  { path: "model-00001-of-00002.safetensors", bytes: bytes(5300, 1) },
  { path: "model-00002-of-00002.safetensors", bytes: bytes(2100, 2) },
  { path: "original/tokenizer.json", bytes: bytes(1500, 3) },
];

let dir: string;
let hub: FakeHub;

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-")));
  hub = await startFakeHub("org/repo", FILES);
});

afterEach(async () => {
  await hub.close();
  safeDeleteDirectoryWithin(os.tmpdir(), dir);
});

const opts = () => ({ hubUrl: hub.baseUrl, allowHttp: true, chunkBytes: 1000, retryDelayMs: 1 });

async function download(extra: Record<string, unknown> = {}, target: string = path.join(dir, "m")) {
  const snap = await fetchHubSnapshot("org/repo", undefined, {
    hubUrl: hub.baseUrl,
    allowHttp: true,
  });
  return downloadHubSnapshot(snap, target, { ...opts(), ...extra });
}

function expectFilesMatch(target: string) {
  for (const f of FILES) {
    expect(fs.readFileSync(path.join(target, f.path)).equals(f.bytes)).toBe(true);
  }
}

describe("fetchHubSnapshot", () => {
  it("returns the commit and every file with size, and a sha256 for LFS files", async () => {
    const snap = await fetchHubSnapshot("org/repo", undefined, {
      hubUrl: hub.baseUrl,
      allowHttp: true,
    });
    expect(snap.revision).toBe(hub.sha);
    expect(snap.files).toEqual([
      { path: "config.json", size: 7 },
      { path: "model-00001-of-00002.safetensors", size: 5300, sha256: sha256hex(FILES[1].bytes) },
      { path: "model-00002-of-00002.safetensors", size: 2100, sha256: sha256hex(FILES[2].bytes) },
      { path: "original/tokenizer.json", size: 1500, sha256: sha256hex(FILES[3].bytes) },
    ]);
  });

  it("reads a pinned revision through the revision endpoint, short sha included", async () => {
    const snap = await fetchHubSnapshot("org/repo", "7b9321e", {
      hubUrl: hub.baseUrl,
      allowHttp: true,
    });
    expect(snap.revision).toBe(hub.sha);
    await expect(
      fetchHubSnapshot("org/repo", "9c1f0a2", { hubUrl: hub.baseUrl, allowHttp: true }),
    ).rejects.toThrow(/revision\/9c1f0a2 answered 404/);
  });

  it("follows the tree API's Link header across pages", async () => {
    const paged = await startFakeHub("org/repo", FILES, { treePageSize: 2 });
    const snap = await fetchHubSnapshot("org/repo", undefined, {
      hubUrl: paged.baseUrl,
      allowHttp: true,
    });
    expect(snap.files.map((f) => f.path)).toEqual(FILES.map((f) => f.path));
    await paged.close();
  });

  it("a gated repo without a token gives the token message; with a token it works and the header is sent", async () => {
    const gated = await startFakeHub("org/repo", FILES, { gated: true });
    await expect(
      fetchHubSnapshot("org/repo", undefined, { hubUrl: gated.baseUrl, allowHttp: true }),
    ).rejects.toThrow(GATED_MESSAGE);
    const snap = await fetchHubSnapshot("org/repo", undefined, {
      hubUrl: gated.baseUrl,
      allowHttp: true,
      token: "t",
    });
    expect(snap.files.length).toBe(4);
    expect(gated.authSeen.api.slice(-2)).toEqual(["Bearer t", "Bearer t"]);
    await gated.close();
  });

  it("refuses a hub that is not https", async () => {
    await expect(fetchHubSnapshot("org/repo", undefined, { hubUrl: hub.baseUrl })).rejects.toThrow(
      `Refusing to download over http: ${hub.baseUrl}`,
    );
  });
});

describe("planChunks", () => {
  it("skips complete files and done chunks", () => {
    const snap: HubSnapshot = {
      repo: "r",
      revision: "s",
      files: [
        { path: "a", size: 10 },
        { path: "b", size: 150 },
      ],
    };
    const record = {
      repo: "r",
      revision: "s",
      files: { a: { size: 10, complete: true }, b: { size: 150, complete: false, chunks: [1] } },
    };
    expect(planChunks(snap, record, 64)).toEqual([
      { path: "b", index: 0, start: 0, end: 64 },
      { path: "b", index: 2, start: 128, end: 150 },
    ]);
  });

  it("ignores a record whose size disagrees, and plans one chunk for an empty file", () => {
    const snap: HubSnapshot = {
      repo: "r",
      revision: "s",
      files: [
        { path: "a", size: 10 },
        { path: "e", size: 0 },
      ],
    };
    const record = { repo: "r", revision: "s", files: { a: { size: 9, complete: true } } };
    expect(planChunks(snap, record, 64)).toEqual([
      { path: "a", index: 0, start: 0, end: 10 },
      { path: "e", index: 0, start: 0, end: 0 },
    ]);
  });
});

describe("downloadHubSnapshot", () => {
  it("produces byte-identical files, nested paths included, and a complete record", async () => {
    const events: DownloadEvent[] = [];
    const out = await download({ onEvent: (e: DownloadEvent) => events.push(e) });
    expect(out).toBe(path.join(dir, "m"));
    expectFilesMatch(out);
    const record = readMlxModelRecord(out)!;
    expect(record.revision).toBe(hub.sha);
    expect(isMlxModelComplete(record)).toBe(true);
    expect(record.files["model-00001-of-00002.safetensors"]).toEqual({
      size: 5300,
      sha256: sha256hex(FILES[1].bytes),
      complete: true,
    });
    expect(events.filter((e) => e.kind === "file-start").length).toBe(4);
    expect(
      events.filter((e) => e.kind === "verify").every((e) => e.kind === "verify" && e.ok),
    ).toBe(true);
    const last = events[events.length - 1];
    expect(last).toEqual({ kind: "bytes", done: 8907, total: 8907 });
    // The token never reaches the CDN, and the fake saw no token at all here.
    expect(hub.authSeen.cdn.every((a) => a === "")).toBe(true);
  });

  it("sends the token to the hub routes and never to the CDN", async () => {
    await download({ token: "secret" });
    expect(hub.authSeen.resolve.every((a) => a === "Bearer secret")).toBe(true);
    expect(hub.authSeen.cdn.every((a) => a === "")).toBe(true);
  });

  it("resumes without re-requesting done chunks", async () => {
    let requests = 0;
    // The network goes away for good after three chunks: every retry of the
    // fourth fails, so the run rejects with three chunks on disk.
    const failing = (async (url: string, init?: RequestInit) => {
      if (url.includes("/cdn/") && init?.headers !== undefined && "range" in init.headers) {
        requests += 1;
        if (requests >= 4) throw new Error("connection reset");
      }
      return fetch(url, init);
    }) as unknown as typeof fetch;
    await expect(download({ fetch: failing, concurrency: 1 })).rejects.toThrow("connection reset");
    const partial = readMlxModelRecord(path.join(dir, "m"))!;
    expect(isMlxModelComplete(partial)).toBe(false);
    expect(Object.keys(hub.rangeHits).length).toBe(3);
    const out = await download({ concurrency: 1 });
    expectFilesMatch(out);
    expect(Object.values(hub.rangeHits).every((n) => n === 1)).toBe(true);
    expect(Object.keys(hub.rangeHits).length).toBe(12);
  });

  it("quarantines a file whose bytes do not match, and the next run fetches only that file", async () => {
    const out = await download();
    // Claim every chunk but the last is done, with garbage on disk.
    const bad = "model-00002-of-00002.safetensors";
    fs.writeFileSync(path.join(out, bad), bytes(2100, 9));
    const record = readMlxModelRecord(out)!;
    record.files[bad] = { ...record.files[bad], complete: false, chunks: [0, 1] };
    writeMlxModelRecord(out, record);
    const before = { ...hub.rangeHits };
    await expect(download()).rejects.toThrow(/SHA-256 verification failed for "model-00002/);
    expect(fs.existsSync(path.join(out, `${bad}.invalidSha`))).toBe(true);
    expect(readMlxModelRecord(out)!.files[bad].chunks).toEqual([]);
    const again = await download();
    expectFilesMatch(again);
    expect(isMlxModelComplete(readMlxModelRecord(again)!)).toBe(true);
    for (const [key, n] of Object.entries(hub.rangeHits)) {
      if (!key.startsWith(bad)) {
        expect(n).toBe(before[key]);
      }
    }
  });

  it("re-resolves once when the CDN URL has expired", async () => {
    hub.expireNextCdn = true;
    const out = await download({ concurrency: 1 });
    expectFilesMatch(out);
    expect(hub.authSeen.resolve.length).toBe(FILES.length + 1);
  });

  it("refuses when the record is from another revision", async () => {
    const target = path.join(dir, "m");
    fs.mkdirSync(target);
    writeMlxModelRecord(target, { repo: "org/repo", revision: "9c1f0a2deadbeef", files: {} });
    await expect(download({}, target)).rejects.toThrow(
      `${target} holds revision 9c1f0a2, but org/repo is now at 7b9321e. Remove it or pin the old revision with mlx:org/repo@9c1f0a2.`,
    );
  });

  it("adopts files already on disk with no record when their bytes match", async () => {
    const target = path.join(dir, "m");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, FILES[1].path), FILES[1].bytes);
    const events: DownloadEvent[] = [];
    const out = await download({ onEvent: (e: DownloadEvent) => events.push(e) }, target);
    expectFilesMatch(out);
    expect(events.some((e) => e.kind === "adopt" && e.path === FILES[1].path)).toBe(true);
    expect(Object.keys(hub.rangeHits).some((k) => k.startsWith(FILES[1].path))).toBe(false);
  });

  it("refuses a tree entry that escapes the directory", async () => {
    const snap: HubSnapshot = {
      repo: "org/repo",
      revision: hub.sha,
      files: [{ path: "../escape", size: 7 }],
    };
    await expect(downloadHubSnapshot(snap, path.join(dir, "m"), opts())).rejects.toThrow(/escape/);
    expect(fs.existsSync(path.join(dir, "escape"))).toBe(false);
  });
});
