import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { _detectObjects, _tagImage, _captionImage } from "./vision.js";

describe("std::vision helpers", () => {
  // A stand-in for `agency local serve` with a vision model: records each
  // request and answers with whatever the test sets.
  let server: http.Server;
  let requests: Record<string, unknown>[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const savedBaseUrl = process.env.MLX_BASE_URL;
  let dir: string;
  let image: string;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vision-")));
    image = path.join(dir, "page.png");
    fs.writeFileSync(image, "png bytes");
    server = http.createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        requests.push({ path: req.url, ...JSON.parse(text) });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.MLX_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    process.env.MLX_BASE_URL = savedBaseUrl;
    await new Promise((resolve) => server.close(resolve));
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  function serve(status: number, body: unknown) {
    requests = [];
    answer = { status, body };
  }

  it("sends the labels and threshold to the detections route and numbers the results", async () => {
    serve(200, {
      detections: [
        { label: "person", score: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        { label: "desk", score: 0.8, box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } },
      ],
    });
    const r = await _detectObjects(image, ["person", "desk"], "florence-2", 0.3);
    expect(r.success).toBe(true);
    expect(r.success && r.value).toEqual([
      { id: 0, label: "person", score: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      { id: 1, label: "desk", score: 0.8, box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } },
    ]);
    expect(requests).toEqual([
      {
        path: "/v1/vision/detections",
        model: "florence-community/Florence-2-large",
        image,
        labels: ["person", "desk"],
        threshold: 0.3,
      },
    ]);
  });

  it("sends the threshold and limit to the tags route", async () => {
    serve(200, { tags: [{ tag: "1girl", score: 0.98 }] });
    const r = await _tagImage(image, "wd14-tagger", 0.35, 30);
    expect(r.success && r.value).toEqual([{ tag: "1girl", score: 0.98 }]);
    expect(requests[0]).toEqual({
      path: "/v1/vision/tags",
      model: "SmilingWolf/wd-eva02-large-tagger-v3",
      image,
      threshold: 0.35,
      limit: 30,
    });
  });

  it("sends the detail to the captions route", async () => {
    serve(200, { caption: "A cat on a chair." });
    const r = await _captionImage(image, "florence-2", "long");
    expect(r.success && r.value).toBe("A cat on a chair.");
    expect(requests[0]).toMatchObject({ path: "/v1/vision/captions", detail: "long" });
  });

  it("passes the server's refusal through as the failure, once", async () => {
    serve(404, {
      error: {
        message: "WD14 tagger does not answer /v1/vision/captions. It answers /v1/vision/tags.",
      },
    });
    const r = await _captionImage(image, "wd14-tagger", "short");
    expect(r.success === false && r.error).toBe(
      "captionImage failed: WD14 tagger does not answer /v1/vision/captions. It answers /v1/vision/tags.",
    );
    expect(requests).toHaveLength(1);
  });

  it("refuses a model of another kind before any request", async () => {
    serve(200, {});
    const chat = await _tagImage(image, "qwen3-coder-next-mlx", 0.35, 30);
    expect(chat.success === false && chat.error).toBe(
      'tagImage failed: "qwen3-coder-next-mlx" is a chat model, not a vision model. Local vision models are detectors and taggers such as wd14-tagger and florence-2.',
    );
    const imageModel = await _tagImage(image, "z-image-turbo", 0.35, 30);
    expect(imageModel.success === false && imageModel.error).toContain("is an image model");
    const empty = await _tagImage(image, "", 0.35, 30);
    expect(empty.success === false && empty.error).toBe("tagImage failed: model cannot be empty.");
    expect(requests).toEqual([]);
  });

  it("refuses an image that is missing or a symlink before any request", async () => {
    serve(200, {});
    const missing = await _tagImage(path.join(dir, "nope.png"), "wd14-tagger", 0.35, 30);
    expect(missing.success === false && missing.error).toMatch(/no such file/);
    fs.symlinkSync(image, path.join(dir, "link.png"));
    const linked = await _tagImage(path.join(dir, "link.png"), "wd14-tagger", 0.35, 30);
    expect(linked.success).toBe(false);
    expect(requests).toEqual([]);
  });

  it("says how to start the server when nothing answers", async () => {
    process.env.MLX_BASE_URL = "http://127.0.0.1:9/v1";
    const r = await _tagImage(image, "wd14-tagger", 0.35, 30);
    expect(r.success === false && r.error).toBe(
      "tagImage failed: no local model server answered at http://127.0.0.1:9/v1. Start one with:\n  agency local serve wd14-tagger",
    );
  });
});
