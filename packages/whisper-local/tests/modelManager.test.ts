import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveModelDir,
  resolveModelPath,
  loadLockfile,
  parseLockfile,
  isModelInstalled,
  sha256OfFile,
  downloadModel,
  ModelManagerError,
} from "../src/modelManager.js";

describe("resolveModelDir", () => {
  const origEnv = process.env.AGENCY_WHISPER_MODELS_DIR;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENCY_WHISPER_MODELS_DIR;
    else process.env.AGENCY_WHISPER_MODELS_DIR = origEnv;
  });

  it("defaults to ~/.agency/models/whisper", () => {
    delete process.env.AGENCY_WHISPER_MODELS_DIR;
    expect(resolveModelDir()).toBe(
      path.join(os.homedir(), ".agency/models/whisper"),
    );
  });

  it("respects AGENCY_WHISPER_MODELS_DIR", () => {
    process.env.AGENCY_WHISPER_MODELS_DIR = "/tmp/custom";
    expect(resolveModelDir()).toBe("/tmp/custom");
  });
});

describe("resolveModelPath", () => {
  it("composes dir + ggml-<name>.bin", () => {
    expect(resolveModelPath("base.en", "/x")).toBe("/x/ggml-base.en.bin");
  });

  it("throws on unknown model name", () => {
    expect(() =>
      resolveModelPath("not-a-real-model" as never, "/x"),
    ).toThrow(ModelManagerError);
  });
});

describe("loadLockfile", () => {
  it("parses the shipped lockfile", async () => {
    const lock = await loadLockfile();
    expect(lock.schemaVersion).toBe(1);
    expect(lock.models["base.en"]).toBeDefined();
    expect(lock.models["base.en"].url).toMatch(/^https:\/\/huggingface\.co\//);
    expect(lock.models["base.en"].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseLockfile", () => {
  // Splitting parse out from loadLockfile lets us exercise the rejection
  // branches without round-tripping a temp file through PACKAGE_ROOT.

  it("rejects malformed JSON with a clear error", () => {
    expect(() => parseLockfile("{ not valid json")).toThrow(ModelManagerError);
    expect(() => parseLockfile("{ not valid json")).toThrow(/failed to parse/);
  });

  it("rejects non-object JSON (array, null, primitive)", () => {
    expect(() => parseLockfile("null")).toThrow(/not a JSON object/);
    expect(() => parseLockfile("[1, 2, 3]")).toThrow(/unsupported lockfile schema version/);
    // Note: arrays *are* objects in JS; the schemaVersion check catches them.
    expect(() => parseLockfile('"a string"')).toThrow(/not a JSON object/);
  });

  it("rejects unsupported schemaVersion", () => {
    expect(() =>
      parseLockfile('{"schemaVersion": 2, "models": {}}'),
    ).toThrow(/unsupported lockfile schema version 2/);
    expect(() =>
      parseLockfile('{"schemaVersion": "1", "models": {}}'),
    ).toThrow(/unsupported lockfile schema version 1/);
    expect(() => parseLockfile('{"models": {}}')).toThrow(
      /unsupported lockfile schema version undefined/,
    );
  });

  it("accepts a minimal valid lockfile", () => {
    const lock = parseLockfile('{"schemaVersion": 1, "models": {}}');
    expect(lock.schemaVersion).toBe(1);
    expect(lock.models).toEqual({});
  });

  it("rejects a lockfile missing the 'models' object", () => {
    // Without this guard, ensureModel would later fail with a confusing
    // TypeError ("cannot read properties of undefined") when accessing
    // lock.models[name]. Catching it here gives an actionable error.
    expect(() => parseLockfile('{"schemaVersion": 1}')).toThrow(
      /missing a 'models' object \(got undefined\)/,
    );
    expect(() => parseLockfile('{"schemaVersion": 1, "models": null}')).toThrow(
      /missing a 'models' object \(got null\)/,
    );
    expect(() =>
      parseLockfile('{"schemaVersion": 1, "models": []}'),
    ).toThrow(/missing a 'models' object \(got array\)/);
    expect(() =>
      parseLockfile('{"schemaVersion": 1, "models": "nope"}'),
    ).toThrow(/missing a 'models' object \(got string\)/);
  });

  it("includes the source label in error messages", () => {
    expect(() => parseLockfile("{ bad", "/some/path.json")).toThrow(
      /\/some\/path\.json/,
    );
  });
});

describe("isModelInstalled", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns false when the file is missing", async () => {
    expect(await isModelInstalled("base.en", tmp)).toBe(false);
  });

  it("returns true when the file exists", async () => {
    await fs.writeFile(path.join(tmp, "ggml-base.en.bin"), "x");
    expect(await isModelInstalled("base.en", tmp)).toBe(true);
  });
});

describe("sha256OfFile", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-sha-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("computes the SHA-256 of a file", async () => {
    const f = path.join(tmp, "hello");
    await fs.writeFile(f, "hello world");
    expect(await sha256OfFile(f)).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

describe("downloadModel", () => {
  let tmp: string;
  let server: ReturnType<typeof createServer>;
  let url: string;
  const payload = Buffer.from("synthetic model bytes for testing");
  // Compute the SHA at test-init time; do NOT hardcode it. A wrong hardcoded
  // value would silently turn the success-path test into a failure-path test.
  const payloadSha = crypto
    .createHash("sha256")
    .update(payload)
    .digest("hex");

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-dl-"));
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.end(payload);
      });
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        url = `http://127.0.0.1:${port}/model.bin`;
        resolve();
      });
    });
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("downloads, verifies the SHA-256, and atomically writes the file", async () => {
    const entry = { url, sha256: payloadSha, sizeBytes: payload.length };
    const dest = path.join(tmp, "ggml-base.en.bin");
    await downloadModel(entry, dest);
    const wrote = await fs.readFile(dest);
    expect(wrote.equals(payload)).toBe(true);
    expect(await fs.readdir(tmp)).toEqual(["ggml-base.en.bin"]);
  });

  it("rejects mismatched SHA-256 and deletes the partial", async () => {
    const entry = { url, sha256: "f".repeat(64), sizeBytes: payload.length };
    const dest = path.join(tmp, "ggml-base.en.bin");
    await expect(downloadModel(entry, dest)).rejects.toThrow(
      /SHA-256 mismatch/,
    );
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it("refuses non-HTTPS, non-localhost URLs", async () => {
    const entry = {
      url: "http://example.com/model.bin",
      sha256: payloadSha,
      sizeBytes: payload.length,
    };
    const dest = path.join(tmp, "ggml-base.en.bin");
    await expect(downloadModel(entry, dest)).rejects.toThrow(/non-HTTPS/);
  });

  it("refuses a redirect that downgrades to a non-allowed scheme", async () => {
    // Defense in depth: even though the lockfile URL passes the up-front
    // scheme check, fetch follows redirects by default. A compromised
    // upstream could 302 us to http://attacker/ — we re-validate
    // response.url (the *final* URL after following redirects) and reject.
    //
    // We can't easily stand up a server that "redirects" to a real
    // attacker host, so we stub global.fetch to return a fake Response
    // whose url is a disallowed scheme. This exercises exactly the branch
    // that re-checks response.url after the initial fetch resolves.
    const realFetch = globalThis.fetch;
    // Fresh body per call (a ReadableStream can only be consumed once).
    const makeFakeResp = () => ({
      ok: true,
      url: "http://attacker.example/model.bin", // <-- the dangerous part
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
    });
    globalThis.fetch = (async () => makeFakeResp()) as unknown as typeof fetch;
    try {
      const entry = { url, sha256: payloadSha, sizeBytes: payload.length };
      const dest = path.join(tmp, "ggml-base.en.bin");
      // One call, both substring assertions on the same rejection.
      let caught: Error | null = null;
      try {
        await downloadModel(entry, dest);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/refusing to follow redirect to non-HTTPS URL/);
      expect(caught!.message).toMatch(/attacker\.example/);
      // No partial file should remain after the rejection.
      expect(await fs.readdir(tmp)).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects HTTP error responses (5xx)", async () => {
    // Replace the default OK server with one that returns 500.
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.statusCode = 500;
        res.end("server exploded");
      });
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        url = `http://127.0.0.1:${port}/model.bin`;
        resolve();
      });
    });
    const entry = { url, sha256: payloadSha, sizeBytes: payload.length };
    const dest = path.join(tmp, "ggml-base.en.bin");
    await expect(downloadModel(entry, dest)).rejects.toThrow(/HTTP 500/);
  });

  it("cleans up a leftover .partial from a prior crashed attempt", async () => {
    // Simulate a previous run that died mid-download and left a stale partial.
    const dest = path.join(tmp, "ggml-base.en.bin");
    await fs.writeFile(`${dest}.partial`, "stale garbage from a prior crash");

    const entry = { url, sha256: payloadSha, sizeBytes: payload.length };
    await downloadModel(entry, dest);

    // Final file should match the server's payload, not the stale bytes.
    const wrote = await fs.readFile(dest);
    expect(wrote.equals(payload)).toBe(true);
    // No .partial should remain.
    expect(await fs.readdir(tmp)).toEqual(["ggml-base.en.bin"]);
  });
});
