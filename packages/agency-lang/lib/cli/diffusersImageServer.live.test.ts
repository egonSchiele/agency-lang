import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { freePort, imageServerScript } from "./localServe.js";

// Runs the real image server on a real model. It needs a Mac GPU, torch,
// diffusers, and tens of gigabytes of weights, so each block runs only
// when its variables are set:
//
//   AGENCY_IMAGE_MODEL_DIR  a Z-Image Turbo or Chroma model directory
//   AGENCY_KLEIN_MODEL_DIR  a FLUX.2 [klein] model directory
//   AGENCY_IMAGE_PYTHON     a Python with the pinned image packages
const modelDir = process.env.AGENCY_IMAGE_MODEL_DIR ?? "";
const kleinDir = process.env.AGENCY_KLEIN_MODEL_DIR ?? "";
const python = process.env.AGENCY_IMAGE_PYTHON ?? "";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

type ImageReply = { data: { b64_json: string; seed: number }[] };

/** The width and height a PNG's header records. */
function pngSize(bytes: Buffer): [number, number] {
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** An image server on `dir`, started before the block's tests and stopped
 *  after them. `stderr` holds what the server printed so far. */
function servedModel(dir: string) {
  const server = { port: 0, stderr: "", child: null as ChildProcess | null };

  beforeAll(async () => {
    server.port = await freePort();
    const child = spawn(python, [
      imageServerScript(),
      "--model",
      dir,
      "--port",
      String(server.port),
    ]);
    server.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      server.stderr += chunk.toString();
    });
    // The port opens only after the model has loaded and warmed up.
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`The image server exited with ${child.exitCode}:\n${server.stderr}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/health`);
        if (res.ok) {
          return;
        }
      } catch {
        // Still loading.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, 300_000);

  afterAll(() => {
    server.child?.kill();
  });

  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${server.port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

  return { server, post };
}

describe.skipIf(modelDir === "" || python === "")("diffusersImageServer.py on a real model", () => {
  const { server, post } = servedModel(modelDir);

  it("makes a PNG and returns the seed it used", async () => {
    const res = await post({ prompt: "a red apple", size: "512x512", steps: 2, seed: 7 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImageReply;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].seed).toBe(7);
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  }, 120_000);

  it("stops a generation when the client hangs up", async () => {
    const controller = new AbortController();
    const pending = post({ prompt: "a red apple", size: "512x512", steps: 40 }, controller.signal);
    setTimeout(() => controller.abort(), 1500);
    await expect(pending).rejects.toThrow();
    for (let i = 0; i < 40 && !server.stderr.includes("Stopped after"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(server.stderr).toMatch(/Stopped after \d+ of 40 steps: the client hung up\./);
  }, 120_000);

  it("redraws a start image, and leaves the next plain request as it was", async () => {
    // The img2img pipeline is built from the plain one's parts, scheduler
    // included. A plain request after it must make the same image as the
    // same request made before it. FLUX.2 [klein] has no img2img pipeline
    // and answers 400 here, so AGENCY_IMAGE_MODEL_DIR must not name one.
    const plain = { prompt: "a red apple", size: "512x512", steps: 4, seed: 3 };
    const before = await post(plain);
    expect(before.status).toBe(200);
    const picture = ((await before.json()) as ImageReply).data[0].b64_json;

    const redrawn = await post({
      prompt: "a watercolor painting of a red apple",
      size: "",
      steps: 4,
      seed: 3,
      start_image: picture,
      strength: 0.6,
    });
    expect(redrawn.status).toBe(200);
    const bytes = Buffer.from(((await redrawn.json()) as ImageReply).data[0].b64_json, "base64");
    expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(bytes)).toEqual([512, 512]);

    const after = await post(plain);
    expect(after.status).toBe(200);
    expect(((await after.json()) as ImageReply).data[0].b64_json).toBe(picture);
  }, 300_000);
});

describe.skipIf(kleinDir === "" || python === "")(
  "diffusersImageServer.py on FLUX.2 [klein]",
  () => {
    const { post } = servedModel(kleinDir);

    it("edits a reference, at the reference's shape when the request gives no size", async () => {
      // A portrait picture to edit, made by the same model.
      const made = await post({ prompt: "a red apple", size: "512x768", seed: 1 });
      expect(made.status).toBe(200);
      const reference = ((await made.json()) as ImageReply).data[0].b64_json;

      const res = await post({ prompt: "make the apple green", size: "", images: [reference] });
      expect(res.status).toBe(200);
      const bytes = Buffer.from(((await res.json()) as ImageReply).data[0].b64_json, "base64");
      expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
      expect(pngSize(bytes)).toEqual([512, 768]);
    }, 300_000);
  },
);
