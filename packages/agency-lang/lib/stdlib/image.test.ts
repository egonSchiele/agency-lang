import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as smoltalk from "smoltalk";
import { agencyStore } from "../runtime/asyncContext.js";
import { InvocationUsageMeter } from "../runtime/invocationUsage.js";
import { _generateImage, _generateImageLocal } from "./image.js";
import { registerMlxImageProvider } from "./mlxImage.js";

type ImageImpl = (input: any, config: any) => Promise<any>;

function makeStack() {
  // billCharge mirrors the real StateStack pair (localCost + chargeGuards)
  // so the existing per-piece assertions keep observing the same effects.
  const stack = {
    localCost: 0,
    localTokens: 0,
    chargeGuards: vi.fn(),
    enforceGuards: vi.fn(),
    billCharge: vi.fn((amount: number) => {
      stack.localCost += amount;
      stack.chargeGuards(amount);
    }),
  };
  return stack;
}

/** Run `fn` inside a real ALS frame whose ctx carries a mock image client +
 *  statelog. Returns the frame's stack + statelog spy for assertions. */
async function withClient(
  imageImpl: ImageImpl | undefined,
  fn: (helpers: {
    stack: ReturnType<typeof makeStack>;
    imageGeneration: ReturnType<typeof vi.fn>;
    meter: InvocationUsageMeter;
  }) => Promise<void>,
) {
  const stack = makeStack();
  const imageGeneration = vi.fn().mockResolvedValue(undefined);
  const meter = new InvocationUsageMeter();
  const store = {
    // A real meter: image generation accounts via recordUsage, which merges
    // ctx.invocationUsage (the serve cost seam's accounting boundary).
    ctx: {
      llmClient: { image: imageImpl },
      statelogClient: { imageGeneration },
      invocationUsage: meter,
    },
    stack,
    threads: {},
    globals: {},
    callsite: { moduleId: "test", scopeName: "main", stepPath: "" },
  } as any;
  await agencyStore.run(store, () => fn({ stack, imageGeneration, meter }));
}

const okResult = (overrides: any = {}) => ({
  success: true,
  value: {
    images: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
    model: "m",
    costEstimate: { totalCost: 0.04, currency: "USD" },
    tokenUsage: { totalTokens: 10 },
    ...overrides,
  },
});

describe("_generateImage", () => {
  it("returns base64 + mimeType and charges cost/tokens/guards on success", async () => {
    await withClient(
      async () => okResult(),
      async ({ stack, imageGeneration }) => {
        const r = await _generateImage("a red bike", "", "", "", "", [], "", "");
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.value.mimeType).toBe("image/png");
          expect(r.value.base64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
        }
        expect(stack.localCost).toBeCloseTo(0.04);
        expect(stack.localTokens).toBe(10);
        expect(stack.chargeGuards).toHaveBeenCalledWith(0.04);
        expect(stack.enforceGuards).toHaveBeenCalled();
        expect(imageGeneration).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("charges cost BEFORE enforcing guards (order matters for trips)", async () => {
    await withClient(
      async () => okResult(),
      async ({ stack }) => {
        await _generateImage("x", "", "", "", "", [], "", "");
        const chargeOrder = stack.chargeGuards.mock.invocationCallOrder[0];
        const enforceOrder = stack.enforceGuards.mock.invocationCallOrder[0];
        expect(chargeOrder).toBeLessThan(enforceOrder);
      },
    );
  });

  it("propagates a guard trip, but still traces the spend + tokens first", async () => {
    await withClient(
      async () => okResult({ costEstimate: { totalCost: 5.0, currency: "USD" } }),
      async ({ stack, imageGeneration }) => {
        stack.enforceGuards.mockImplementation(() => {
          throw new Error("budget exceeded");
        });
        await expect(_generateImage("x", "", "", "", "", [], "", "")).rejects.toThrow(
          /budget exceeded/,
        );
        // The generation already cost money — tokens counted + event traced
        // before the trip propagates (same ordering as llm()).
        expect(stack.localTokens).toBe(10);
        expect(imageGeneration).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("a successful result with no image accounts usage + tokens, skips the event, and fails", async () => {
    await withClient(
      async () => okResult({ images: [] }),
      async ({ stack, imageGeneration }) => {
        const r = await _generateImage("x", "", "", "", "", [], "", "");
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error).toMatch(/returned no images/);
        // The provider still charged us: full usage + tokens are accounted and the
        // guard gate runs, even though there is no image to return.
        expect(stack.localCost).toBeCloseTo(0.04);
        expect(stack.localTokens).toBe(10);
        expect(stack.enforceGuards).toHaveBeenCalled();
        // No image → no imageGeneration event (its contract requires an image).
        expect(imageGeneration).not.toHaveBeenCalled();
      },
    );
  });

  it("does NOT charge cost or log the prompt on a provider failure", async () => {
    await withClient(
      async () => ({ success: false, error: "no api key" }),
      async ({ stack, imageGeneration }) => {
        const r = await _generateImage("secret prompt", "", "", "", "", [], "", "");
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error).toMatch(/no api key/);
        expect(stack.chargeGuards).not.toHaveBeenCalled();
        expect(imageGeneration).not.toHaveBeenCalled();
      },
    );
  });

  it("a rejected image dispatch records one unresolved attempt (the run has an unpriced call)", async () => {
    await withClient(
      async () => {
        throw new Error("provider 500 after dispatch");
      },
      async ({ meter }) => {
        await expect(_generateImage("x", "", "", "", "", [], "", "")).rejects.toThrow(
          /provider 500/,
        );
        await Promise.resolve();
        const usage = meter.snapshot();
        expect(usage.unpricedCallCount).toBe(1);
        expect(usage.unpricedCallCount).toBeGreaterThan(0);
      },
    );
  });

  it("returns a descriptive failure when the client has no image() support", async () => {
    await withClient(undefined, async () => {
      const r = await _generateImage("x", "", "", "", "", [], "", "");
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error).toMatch(/does not support image generation/);
    });
  });

  it("classifies input images into ImageRefs (edit/variation path)", async () => {
    let captured: any;
    const impl: ImageImpl = async (input) => {
      captured = input;
      return okResult({ costEstimate: { totalCost: 0, currency: "USD" } });
    };
    await withClient(impl, async () => {
      await _generateImage("edit", "", "", "", "", ["./a.png", "https://x/b.png"], "", "");
      expect(captured.prompt).toBe("edit");
      expect(captured.images).toEqual([
        { kind: "path", path: "./a.png" },
        { kind: "url", url: "https://x/b.png" },
      ]);
    });
  });
});

describe("_generateImageLocal", () => {
  // The runtime registers the provider when it loads provider modules; the
  // tests call the stdlib function directly, so they register it here.
  beforeAll(() => registerMlxImageProvider());
  // A stand-in for `agency local serve --image`: records each request body
  // and answers with whatever the test sets.
  let server: http.Server;
  let baseUrl = "";
  let requests: Record<string, unknown>[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const savedBaseUrl = process.env.MLX_BASE_URL;

  beforeAll(async () => {
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    process.env.MLX_BASE_URL = savedBaseUrl;
    await new Promise((resolve) => server.close(resolve));
  });

  /** The default client's image path: smoltalk's image(), which dispatches
   *  to the mlx provider Agency registers. */
  const realImage: ImageImpl = (input, config) => smoltalk.image(input, config);

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  function serve(status: number, body: unknown) {
    process.env.MLX_BASE_URL = baseUrl;
    requests = [];
    answer = { status, body };
  }

  it("sends the served name and only the settings given, and returns the seed", async () => {
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 42 }] });
    await withClient(realImage, async ({ stack, imageGeneration }) => {
      const r = await _generateImageLocal(
        "a lighthouse",
        "z-image-turbo",
        "1024x768",
        null,
        null,
        null,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(r.success).toBe(true);
      expect(r.success && r.value).toEqual({
        base64: PNG.toString("base64"),
        mimeType: "image/png",
        seed: 42,
      });
      expect(requests).toEqual([
        {
          path: "/v1/images/generations",
          model: "Tongyi-MAI/Z-Image-Turbo",
          prompt: "a lighthouse",
          n: 1,
          size: "1024x768",
          output_format: "png",
          response_format: "b64_json",
        },
      ]);
      expect(stack.localCost).toBe(0);
      expect(imageGeneration).toHaveBeenCalledTimes(1);
    });
  });

  it("sends steps, guidance, seed, and a negative prompt when they are set", async () => {
    serve(200, { output_format: "webp", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "a cat",
        "chroma1-hd",
        "512x512",
        30,
        4.5,
        7,
        "blurry",
        "webp",
        "",
        null,
        "",
        "",
        null,
      );
      expect(r.success && r.value.mimeType).toBe("image/webp");
      expect(requests[0]).toMatchObject({
        model: "lodestones/Chroma1-HD",
        steps: 30,
        guidance: 4.5,
        seed: 7,
        negative_prompt: "blurry",
        output_format: "webp",
      });
    });
  });

  it("passes the server's refusal through as the failure", async () => {
    serve(400, { error: { message: "steps must be between 1 and 50 for Z-Image Turbo." } });
    await withClient(realImage, async ({ stack }) => {
      const r = await _generateImageLocal(
        "a cat",
        "z-image-turbo",
        "1024x1024",
        99,
        null,
        null,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(r.success === false && r.error).toBe(
        "generateImageLocal failed: steps must be between 1 and 50 for Z-Image Turbo.",
      );
      expect(stack.localCost).toBe(0);
      // A refusal is one request, never retried.
      expect(requests).toHaveLength(1);
    });
  });

  it("says how to start the server when nothing answers", async () => {
    process.env.MLX_BASE_URL = "http://127.0.0.1:9/v1";
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "a cat",
        "z-image-turbo",
        "1024x1024",
        null,
        null,
        null,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(r.success === false && r.error).toBe(
        "generateImageLocal failed: no local model server answered at http://127.0.0.1:9/v1. Start one with:\n  agency local serve --image z-image-turbo",
      );
    });
  });

  it("refuses a chat or GGUF model, a bad format, and an empty prompt before any request", async () => {
    serve(200, {});
    await withClient(realImage, async () => {
      const mlx = await _generateImageLocal(
        "a cat",
        "qwen3-tts-mlx",
        "1024x1024",
        null,
        null,
        null,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(mlx.success === false && mlx.error).toMatch(
        /is an MLX model\. Local image models are diffusers models/,
      );
      const gguf = await _generateImageLocal(
        "a cat",
        "smollm2-135m",
        "1024x1024",
        null,
        null,
        null,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(gguf.success === false && gguf.error).toMatch(/is a GGUF model/);
      const gif = await _generateImageLocal(
        "a cat",
        "z-image-turbo",
        "1024x1024",
        null,
        null,
        null,
        "",
        "gif",
        "",
        null,
        "",
        "",
        null,
      );
      expect(gif.success === false && gif.error).toBe(
        'generateImageLocal failed: format "gif" is not supported. Use png, jpeg, or webp.',
      );
      const empty = await _generateImageLocal(
        "  ",
        "z-image-turbo",
        "1024x1024",
        null,
        null,
        null,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(empty.success === false && empty.error).toBe(
        "generateImageLocal failed: prompt cannot be empty.",
      );
      expect(requests).toEqual([]);
    });
  });

  it("sends the ControlNet, its image as a real path, and its scale, and refuses one without the other", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "control-")));
    const pose = path.join(dir, "pose.png");
    fs.writeFileSync(pose, "png");
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "a cat",
        "diffusers:Laxhar/noobai-XL-1.1",
        "1024x1024",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        "scribble",
        pose,
        0.8,
      );
      expect(r.success).toBe(true);
      expect(requests[0]).toMatchObject({
        controlnet: "scribble",
        control_image: pose,
        control_scale: 0.8,
      });
      const half = await _generateImageLocal(
        "a cat",
        "diffusers:Laxhar/noobai-XL-1.1",
        "1024x1024",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        "scribble",
        "",
        null,
      );
      expect(half.success === false && half.error).toBe(
        "generateImageLocal failed: controlnet and controlImage go together: the ControlNet's name, and the image it conditions the generation on.",
      );
      const missing = await _generateImageLocal(
        "a cat",
        "diffusers:Laxhar/noobai-XL-1.1",
        "1024x1024",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        "scribble",
        path.join(dir, "nope.png"),
        null,
      );
      expect(missing.success === false && missing.error).toMatch(/no such file/);
      expect(requests).toHaveLength(1);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends the adapter name and scale when a LoRA is asked for", async () => {
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "a cat",
        "diffusers:Laxhar/noobai-XL-1.1",
        "1024x1024",
        null,
        null,
        7,
        "",
        "png",
        "sketch",
        0.8,
        "",
        "",
        null,
      );
      expect(r.success).toBe(true);
      expect(requests[0]).toMatchObject({
        model: "Laxhar/noobai-XL-1.1",
        lora: "sketch",
        lora_scale: 0.8,
      });
      // The fields are sent only when asked for: an empty name and a null
      // scale are the server's defaults, not settings.
      expect(Object.keys(requests[0])).not.toContain("negative_prompt");
      serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
      await _generateImageLocal(
        "a cat",
        "diffusers:Laxhar/noobai-XL-1.1",
        "1024x1024",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        "",
        "",
        null,
      );
      expect(Object.keys(requests[0])).not.toContain("lora");
      expect(Object.keys(requests[0])).not.toContain("lora_scale");
    });
  });
});
