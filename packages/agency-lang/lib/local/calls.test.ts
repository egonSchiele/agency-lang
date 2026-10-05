import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  _detectObjects,
  _tagImage,
  _captionImage,
  _embedImage,
  _findRegions,
} from "../stdlib/vision.js";
import {
  detectObjects,
  tagImage,
  captionImage,
  embedImage,
  findRegions,
  VISION_DEFAULTS,
} from "./calls.js";

// The image twin, `generateImage` beside `generateImageLocal`, is tested in
// lib/stdlib/image.test.ts, where the stdlib function's run is set up.

describe("the vision functions of agency-lang/local, beside std::vision", () => {
  // A stand-in for `agency local serve` with a vision model: records each
  // request and answers with whatever the test sets.
  let server: http.Server;
  let baseUrl = "";
  let requests: Record<string, unknown>[] = [];
  let answer: unknown = {};
  const savedBaseUrl = process.env.MLX_BASE_URL;
  let dir: string;
  let image: string;
  const bytes = new Uint8Array(Buffer.from("png bytes"));

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-calls-")));
    image = path.join(dir, "page.png");
    fs.writeFileSync(image, "png bytes");
    server = http.createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        requests.push({ path: req.url, ...JSON.parse(text) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    // The stdlib functions take no address, so they read it from here.
    process.env.MLX_BASE_URL = baseUrl;
  });

  afterAll(async () => {
    process.env.MLX_BASE_URL = savedBaseUrl;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the stdlib call and then the public one, and checks the two
   *  sent the same body and returned the same value. */
  async function expectTwins(
    reply: unknown,
    stdlibCall: () => Promise<{ success: boolean; value?: unknown }>,
    publicCall: () => Promise<{ success: boolean; value?: unknown }>,
  ) {
    requests = [];
    answer = reply;
    const fromStdlib = await stdlibCall();
    const fromPublic = await publicCall();
    expect(fromStdlib.success).toBe(true);
    expect(fromPublic.success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(fromPublic.value).toEqual(fromStdlib.value);
  }

  const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

  it("detectObjects sends the same request and numbers the detections the same way", async () => {
    await expectTwins(
      { detections: [{ label: "cat", score: 0.9, box }] },
      () => _detectObjects(image, ["cat"], "florence-2", 0.3),
      () => detectObjects({ baseUrl, model: "florence-2", image, labels: ["cat"], threshold: 0.3 }),
    );
    expect(requests[0].path).toBe("/v1/vision/detections");
  });

  it("tagImage sends the same request, from a path and from bytes", async () => {
    const reply = { tags: [{ tag: "1girl", score: 0.99 }] };
    await expectTwins(
      reply,
      () => _tagImage(image, "wd14-tagger", 0.5, 10),
      () => tagImage({ baseUrl, model: "wd14-tagger", image, threshold: 0.5, limit: 10 }),
    );
    await expectTwins(
      reply,
      () => _tagImage(image, "wd14-tagger", 0.5, 10),
      () => tagImage({ baseUrl, model: "wd14-tagger", image: bytes, threshold: 0.5, limit: 10 }),
    );
  });

  it("captionImage sends the same request", async () => {
    await expectTwins(
      { caption: "A cat on a desk." },
      () => _captionImage(image, "florence-2", "long"),
      () => captionImage({ baseUrl, model: "florence-2", image, detail: "long" }),
    );
  });

  it("embedImage sends the same request, with boxes and without", async () => {
    await expectTwins(
      { embeddings: [[0.1, 0.2]] },
      () => _embedImage(image, "dinov2-base", [box]),
      () => embedImage({ baseUrl, model: "dinov2-base", image, boxes: [box] }),
    );
    await expectTwins(
      { embeddings: [[0.1, 0.2]] },
      () => _embedImage(image, "dinov2-base", null),
      () => embedImage({ baseUrl, model: "dinov2-base", image }),
    );
  });

  it("findRegions sends the same request", async () => {
    await expectTwins(
      { regions: [{ score: 0.8, box }] },
      () => _findRegions(image, "owlv2-base", 20, 0.2),
      () => findRegions({ baseUrl, model: "owlv2-base", image, limit: 20, threshold: 0.2 }),
    );
  });

  it("uses the stdlib's defaults for the settings a caller leaves out", async () => {
    requests = [];
    answer = { tags: [] };
    await tagImage({ baseUrl, model: "wd14-tagger", image });
    expect(requests[0]).toMatchObject({ threshold: 0.35, limit: 30 });
    answer = { regions: [] };
    await findRegions({ baseUrl, model: "owlv2-base", image });
    expect(requests[1]).toMatchObject({ limit: 50, threshold: null });
  });

  it("refuses a model of another kind under its own name, before any request", async () => {
    requests = [];
    const tags = await tagImage({ baseUrl, model: "z-image-turbo", image });
    expect(tags.success === false && tags.error).toMatch(
      /^tagImage failed: "z-image-turbo" is an image model, not a vision model\./,
    );
    expect(requests).toEqual([]);
  });

  it("says how to start the server when nothing answers", async () => {
    const tags = await tagImage({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "wd14-tagger",
      image,
    });
    expect(tags).toEqual({
      success: false,
      error:
        "tagImage failed: no local model server answered at http://127.0.0.1:9/v1. Start one with:\n  agency local serve wd14-tagger",
    });
  });

  it("returns Cancelled when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const tags = await tagImage({
      baseUrl,
      model: "wd14-tagger",
      image,
      signal: controller.signal,
    });
    expect(tags).toEqual({ success: false, error: "tagImage failed: Cancelled" });
  });
});

describe("VISION_DEFAULTS", () => {
  // The stdlib's defaults are parameter defaults in Agency source, which
  // TypeScript cannot import. This reads the source so that a default
  // changed in one place fails here.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../stdlib/vision.agency"),
    "utf8",
  );

  /** The text of one function's parameter list in vision.agency. */
  function parametersOf(name: string): string {
    const start = source.indexOf(`def ${name}(`);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("): Result<", start));
  }

  it("matches each parameter default in stdlib/vision.agency", () => {
    for (const [name, defaults] of Object.entries(VISION_DEFAULTS)) {
      const parameters = parametersOf(name);
      for (const [parameter, value] of Object.entries(defaults)) {
        const written = new RegExp(`\\b${parameter}: [^=\\n]*= ([^,\\n]+),`).exec(parameters);
        expect(written?.[1], `${name}.${parameter}`).toBe(JSON.stringify(value));
      }
    }
  });
});
