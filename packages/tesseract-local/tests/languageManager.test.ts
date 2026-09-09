import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import {
  ensureLanguage,
  downloadLanguage,
  parseLockfile,
  LanguageManagerError,
} from "../src/languageManager.js";

// realpath: on macOS os.tmpdir() sits under /var, which is a symlink, and
// agency-lang's contained module refuses a spelling with a link in it.
async function makeTmp(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

describe("parseLockfile", () => {
  it("rejects a wrong schema version", () => {
    expect(() => parseLockfile('{"schemaVersion":2,"languages":{}}')).toThrow(
      /schema version/,
    );
  });
  it("rejects a missing languages object", () => {
    expect(() => parseLockfile('{"schemaVersion":1}')).toThrow(/languages/);
  });
});

describe("ensureLanguage", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTmp("tess-");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the existing file without downloading", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await fs.writeFile(dest, "pretend");
    expect(await ensureLanguage("eng", tmp)).toBe(dest);
  });

  it("rejects an unknown language", async () => {
    await expect(ensureLanguage("klingon" as never, tmp)).rejects.toThrow(
      LanguageManagerError,
    );
  });
});

describe("downloadLanguage", () => {
  let tmp: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  const body = Buffer.from("language data");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const entry = (
    overrides: Partial<{ url: string; sha256: string; sizeBytes: number }> = {},
  ) => ({
    url: `${base}/eng.traineddata`,
    sha256,
    sizeBytes: body.length,
    ...overrides,
  });

  // One server, several routes: the plain file, a redirect to it, a
  // redirect off to plaintext, and an oversized body.
  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === "/eng.traineddata") {
      res.writeHead(200);
      res.end(body);
    } else if (req.url === "/redirect-same-host") {
      res.writeHead(302, { location: "/eng.traineddata" });
      res.end();
    } else if (req.url === "/redirect-to-plaintext") {
      res.writeHead(302, { location: "http://example.com/eng.traineddata" });
      res.end();
    } else if (req.url === "/oversized") {
      res.writeHead(200);
      res.end(Buffer.concat([body, body, body]));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  beforeEach(async () => {
    tmp = await makeTmp("tess-dl-");
    server = createServer(handle);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function leftovers(): Promise<string[]> {
    return (await fs.readdir(tmp)).filter((name) => name.includes(".partial"));
  }

  it("writes the file when the size and hash match", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await downloadLanguage(entry(), dest);
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("follows a redirect that stays on an allowed scheme", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await downloadLanguage(entry({ url: `${base}/redirect-same-host` }), dest);
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
  });

  it("refuses a redirect to plaintext before requesting it", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await expect(
      downloadLanguage(entry({ url: `${base}/redirect-to-plaintext` }), dest),
    ).rejects.toThrow(/non-HTTPS/);
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it("rejects a mismatched hash and deletes the partial", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await expect(
      downloadLanguage(entry({ sha256: "0".repeat(64) }), dest),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(fs.stat(dest)).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("stops a body that grows past the pinned size and deletes the partial", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await expect(
      downloadLanguage(entry({ url: `${base}/oversized` }), dest),
    ).rejects.toThrow(/exceeded the pinned size/);
    await expect(fs.stat(dest)).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("rejects a body shorter than the pinned size", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await expect(
      downloadLanguage(entry({ sizeBytes: body.length + 1 }), dest),
    ).rejects.toThrow(/lockfile pins/);
    expect(await leftovers()).toEqual([]);
  });

  it("refuses a plain http URL that is not localhost without fetching", async () => {
    await expect(
      downloadLanguage(
        { url: "http://example.com/x", sha256: "0".repeat(64), sizeBytes: 1 },
        path.join(tmp, "x"),
      ),
    ).rejects.toThrow(/non-HTTPS/);
  });

  it("lets two concurrent downloads of one language both succeed", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await Promise.all([
      downloadLanguage(entry(), dest),
      downloadLanguage(entry(), dest),
    ]);
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
    expect(await leftovers()).toEqual([]);
  });
});
