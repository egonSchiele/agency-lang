import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as smoltalk from "smoltalk";
import { agencyStore } from "../runtime/asyncContext.js";
import { InvocationUsageMeter } from "../runtime/invocationUsage.js";
import { _generateImage, _generateImageLocal, _imageSources, _imageDestination } from "./image.js";
import { MAX_IMAGE_BYTES } from "./vision.js";
import { registerMlxImageProvider } from "./mlxImage.js";
import type { LocalImageInputs } from "./localImageInputs.js";

/** The input images of a call with none. */
const NO_INPUTS: LocalImageInputs = { files: [], settings: {} };

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

/** Run `fn` inside a real context frame whose ctx carries a mock image client +
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

  it("sends a local image as its bytes and a URL as a URL, never a path", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gen-image-")));
    const file = path.join(dir, "a.png");
    fs.writeFileSync(file, Buffer.from("png bytes"));
    let captured: any;
    const impl: ImageImpl = async (input) => {
      captured = input;
      return okResult({ costEstimate: { totalCost: 0, currency: "USD" } });
    };
    try {
      await withClient(impl, async () => {
        const sources = [
          { source: file, local: true },
          { source: "https://x/b.png", local: false },
        ];
        await _generateImage("edit", "", "", "", "", sources, "", "");
        expect(captured.prompt).toBe("edit");
        expect(captured.images).toEqual([
          { kind: "bytes", data: new Uint8Array(Buffer.from("png bytes")), mimeType: "image/png" },
          { kind: "url", url: "https://x/b.png" },
        ]);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails without a request when an approved file has become a symlink", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gen-image-")));
    fs.writeFileSync(path.join(dir, "real.png"), "x");
    fs.symlinkSync(path.join(dir, "real.png"), path.join(dir, "a.png"));
    const impl = vi.fn(async () => okResult());
    try {
      await withClient(impl, async () => {
        const sources = [{ source: path.join(dir, "a.png"), local: true }];
        const r = await _generateImage("edit", "", "", "", "", sources, "", "");
        expect(r.success).toBe(false);
        expect(impl).not.toHaveBeenCalled();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("_imageSources", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-sources-")));
  fs.writeFileSync(path.join(dir, "a.png"), "x");
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  fs.mkdirSync(path.join(dir, "folder.png"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes URLs and data: URIs through and marks only local paths", () => {
    const data = "data:image/png;base64,eA==";
    expect(_imageSources(["https://x/b.png", data, path.join(dir, "a.png")])).toEqual([
      { source: "https://x/b.png", local: false },
      { source: data, local: false },
      { source: path.join(dir, "a.png"), local: true },
    ]);
  });

  it("refuses a missing file, a directory, and a file that is not an image", () => {
    expect(() => _imageSources([path.join(dir, "missing.png")])).toThrow(/no such file/);
    expect(() => _imageSources([path.join(dir, "folder.png")])).toThrow(/not a regular file/);
    expect(() => _imageSources([path.join(dir, "notes.txt")])).toThrow(/Accepted: .png/);
  });
});

describe("_imageDestination", () => {
  it("names the default model and the provider it belongs to", () => {
    expect(_imageDestination("", "")).toEqual({ model: "gpt-image-1", provider: "openai" });
  });

  it("keeps a provider the caller names", () => {
    expect(_imageDestination("my-model", "litellm")).toEqual({
      model: "my-model",
      provider: "litellm",
    });
  });

  it("says unknown for a model no provider is known for", () => {
    expect(_imageDestination("not-a-real-model", "")).toEqual({
      model: "not-a-real-model",
      provider: "unknown",
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
        NO_INPUTS,
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
        NO_INPUTS,
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
        NO_INPUTS,
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
        NO_INPUTS,
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
        NO_INPUTS,
      );
      expect(mlx.success === false && mlx.error).toMatch(
        /is an MLX model\. Local image models are diffusers models/,
      );
      const controlnet = await _generateImageLocal(
        "a cat",
        "controlnet-scribble-sdxl",
        "1024x1024",
        null,
        null,
        null,
        "",
        "png",
        "",
        null,
        NO_INPUTS,
      );
      expect(controlnet.success === false && controlnet.error).toBe(
        'generateImageLocal failed: "controlnet-scribble-sdxl" is a ControlNet, not an image model. Pass it as the controlnet argument, with a controlImage, and name an SDXL image model as the model.',
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
        NO_INPUTS,
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
        NO_INPUTS,
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
        NO_INPUTS,
      );
      expect(empty.success === false && empty.error).toBe(
        "generateImageLocal failed: prompt cannot be empty.",
      );
      expect(requests).toEqual([]);
    });
  });

  it("sends the ControlNet with its drawing's bytes, never the path, and refuses a link or a large file", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "control-")));
    const pose = path.join(dir, "pose.png");
    fs.writeFileSync(pose, PNG);
    fs.symlinkSync(pose, path.join(dir, "linked.png"));
    fs.symlinkSync(dir, `${dir}-link`);
    // Sparse, so the test writes no 50 MB.
    fs.writeFileSync(path.join(dir, "huge.png"), "");
    fs.truncateSync(path.join(dir, "huge.png"), MAX_IMAGE_BYTES + 1);
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    const generate = (image: string) =>
      _generateImageLocal(
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
        {
          files: [
            {
              field: "control_image",
              path: image,
              dir: path.dirname(image),
              filename: path.basename(image),
              question: "",
            },
          ],
          settings: { controlnet: "scribble", control_scale: 0.8, control_invert: true },
        },
      );
    await withClient(realImage, async () => {
      const r = await generate(pose);
      expect(r.success).toBe(true);
      expect(requests[0]).toMatchObject({
        controlnet: "scribble",
        control_image: PNG.toString("base64"),
        control_scale: 0.8,
        control_invert: true,
      });
      const linkedFile = await generate(path.join(dir, "linked.png"));
      expect(linkedFile.success === false && linkedFile.error).toMatch(
        /symlink|not a regular file/,
      );
      const linkedDir = await generate(path.join(`${dir}-link`, "pose.png"));
      expect(linkedDir.success === false && linkedDir.error).toMatch(/is a symlink/);
      const huge = await generate(path.join(dir, "huge.png"));
      expect(huge.success === false && huge.error).toBe(
        `generateImageLocal failed: ${path.join(dir, "huge.png")} is 50,000,001 bytes; the most this reads is 50,000,000.`,
      );
      const missing = await generate(path.join(dir, "nope.png"));
      expect(missing.success === false && missing.error).toMatch(/no such file/);
      expect(requests).toHaveLength(1);
    });
    fs.rmSync(`${dir}-link`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends references as a list of their bytes in base64, never their paths", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reference-")));
    const cat = path.join(dir, "cat.png");
    const hat = path.join(dir, "hat.png");
    const HAT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    fs.writeFileSync(cat, PNG);
    fs.writeFileSync(hat, HAT);
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    const file = (image: string) => ({
      field: "images",
      path: image,
      dir,
      filename: path.basename(image),
      question: "",
    });
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "add a hat to the cat",
        "flux2-klein-4b",
        "",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        { files: [file(cat), file(hat)], settings: {} },
      );
      expect(r.success).toBe(true);
      expect(requests[0].images).toEqual([PNG.toString("base64"), HAT.toString("base64")]);
      expect(requests[0].size).toBe("");
      // The count is for the timeout and is not a request field.
      expect(Object.keys(requests[0])).not.toContain("references");
      expect(JSON.stringify(requests[0])).not.toContain(dir);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends a start image as its bytes in base64, with the strength, never its path", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-")));
    const photo = path.join(dir, "photo.png");
    fs.writeFileSync(photo, PNG);
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "a watercolor painting",
        "z-image-turbo",
        "",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        {
          files: [{ field: "start_image", path: photo, dir, filename: "photo.png", question: "" }],
          settings: { strength: 0.4 },
        },
      );
      expect(r.success).toBe(true);
      // One image is sent as a string, not a list of one.
      expect(requests[0].start_image).toBe(PNG.toString("base64"));
      expect(requests[0].strength).toBe(0.4);
      expect(JSON.stringify(requests[0])).not.toContain(dir);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends a start image and its mask, each as its bytes in base64, never their paths", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inpaint-")));
    const photo = path.join(dir, "photo.png");
    const mask = path.join(dir, "mask.png");
    const MASK = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    fs.writeFileSync(photo, PNG);
    fs.writeFileSync(mask, MASK);
    serve(200, { output_format: "png", data: [{ b64_json: PNG.toString("base64"), seed: 7 }] });
    await withClient(realImage, async () => {
      const r = await _generateImageLocal(
        "a vase of sunflowers",
        "z-image-turbo",
        "",
        null,
        null,
        7,
        "",
        "png",
        "",
        null,
        {
          files: [
            { field: "start_image", path: photo, dir, filename: "photo.png", question: "" },
            { field: "mask_image", path: mask, dir, filename: "mask.png", question: "" },
          ],
          settings: { strength: 0.9 },
        },
      );
      expect(r.success).toBe(true);
      expect(requests[0].start_image).toBe(PNG.toString("base64"));
      expect(requests[0].mask_image).toBe(MASK.toString("base64"));
      expect(requests[0].strength).toBe(0.9);
      expect(JSON.stringify(requests[0])).not.toContain(dir);
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
        NO_INPUTS,
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
        NO_INPUTS,
      );
      expect(Object.keys(requests[0])).not.toContain("lora");
      expect(Object.keys(requests[0])).not.toContain("lora_scale");
    });
  });
});
