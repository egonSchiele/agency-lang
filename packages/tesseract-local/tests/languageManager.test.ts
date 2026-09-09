import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
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
  let url: string;
  const body = Buffer.from("language data");
  beforeEach(async () => {
    tmp = await makeTmp("tess-dl-");
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    url = `http://127.0.0.1:${address.port}/eng.traineddata`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes the file when the hash matches", async () => {
    const sha256 = createHash("sha256").update(body).digest("hex");
    const dest = path.join(tmp, "eng.traineddata");
    await downloadLanguage({ url, sha256, sizeBytes: body.length }, dest);
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
  });

  it("rejects a mismatched hash and deletes the partial", async () => {
    const dest = path.join(tmp, "eng.traineddata");
    await expect(
      downloadLanguage(
        { url, sha256: "0".repeat(64), sizeBytes: body.length },
        dest,
      ),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(fs.stat(dest)).rejects.toThrow();
    await expect(fs.stat(`${dest}.partial`)).rejects.toThrow();
  });

  it("refuses a plain http URL that is not localhost", async () => {
    await expect(
      downloadLanguage(
        { url: "http://example.com/x", sha256: "0".repeat(64), sizeBytes: 1 },
        path.join(tmp, "x"),
      ),
    ).rejects.toThrow(/non-HTTPS/);
  });
});
