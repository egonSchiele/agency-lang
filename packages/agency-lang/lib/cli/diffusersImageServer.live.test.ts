import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { freePort, imageServerScript } from "./localServe.js";

// Runs the real image server on a real model. It needs a Mac GPU, torch,
// diffusers, and tens of gigabytes of weights, so it runs only when both
// variables are set:
//
//   AGENCY_IMAGE_MODEL_DIR  a Z-Image Turbo or Chroma model directory
//   AGENCY_IMAGE_PYTHON     a Python with the pinned image packages
const modelDir = process.env.AGENCY_IMAGE_MODEL_DIR ?? "";
const python = process.env.AGENCY_IMAGE_PYTHON ?? "";
const enabled = modelDir !== "" && python !== "";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe.skipIf(!enabled)("diffusersImageServer.py on a real model", () => {
  let child: ChildProcess;
  let port = 0;
  let stderr = "";

  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

  beforeAll(async () => {
    port = await freePort();
    child = spawn(python, [imageServerScript(), "--model", modelDir, "--port", String(port)]);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // The port opens only after the model has loaded and warmed up.
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`The image server exited with ${child.exitCode}:\n${stderr}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
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
    child?.kill();
  });

  it("makes a PNG and returns the seed it used", async () => {
    const res = await post({ prompt: "a red apple", size: "512x512", steps: 2, seed: 7 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { b64_json: string; seed: number }[] };
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
    for (let i = 0; i < 40 && !stderr.includes("Stopped after"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(stderr).toMatch(/Stopped after \d+ of 40 steps: the client hung up\./);
  }, 120_000);
});
