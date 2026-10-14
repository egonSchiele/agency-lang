import { describe, it, expect } from "vitest";
import { DeterministicClient } from "./deterministicClient.js";
import { DETERMINISTIC_IMAGE_COST } from "../constants.js";
import { _generateImage } from "../stdlib/image.js";
import { withRun, type Run } from "./asyncContext.js";
import { StateStack } from "./state/stateStack.js";
import { CostGuard } from "./guard.js";
import { InvocationUsageMeter } from "./invocationUsage.js";
import { asRootRun, callHelper } from "./__tests__/testHelpers.js";
import { memoryHost } from "../host/memoryHost.js";
import type { Host } from "../host/host.js";
import type { ImageConfig, ImageInput } from "./llmClient.js";

// Note: SmoltalkClient.image's `{ model: DEFAULT_IMAGE_MODEL, ...config }` spread
// (default applied only when config sets no model) is trivial by construction and
// exercised for real by the image-generation e2e (tests/agency-js/image-generation).
// It isn't unit-tested here because smoltalk's `image` is a read-only ESM export
// that vitest cannot spy on without fragile whole-module mocking.

describe("DeterministicClient.image", () => {
  it("returns a decodable PNG with the fixed cost", async () => {
    const client = new DeterministicClient([]);
    const r = await client.image!("a red bike", { model: "test-image" });
    expect(r.success).toBe(true);
    if (r.success) {
      const img = r.value.images[0];
      expect(img.mimeType).toBe("image/png");
      // Real PNG signature — proves the base64 decodes to actual PNG bytes.
      expect(Array.from(img.data.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(r.value.costEstimate?.totalCost).toBe(DETERMINISTIC_IMAGE_COST);
      // Regression: the estimate must be a VALID USD price. Omitting `currency`
      // (the old `as any` cast) makes the serve cost seam treat it as unpriced,
      // so getCost() stays zero and image guards never trip.
      expect(r.value.costEstimate?.currency).toBe("USD");
    }
  });
});

/** Run `fn` under `run`, as the test's root run, so `callHelper` finds it. */
function underRun<T>(run: Run, fn: (run: Run) => T): T {
  return withRun(run, asRootRun(fn));
}

/** The deterministic client, recording the config of each image call. */
class RecordingImageClient extends DeterministicClient {
  configs: Partial<ImageConfig>[] = [];

  async image(input: ImageInput, config?: Partial<ImageConfig>) {
    this.configs.push(config ?? {});
    return super.image(input, config);
  }
}

function imageFrame(
  stack: StateStack,
  host: Host = memoryHost(),
  client = new RecordingImageClient([]),
) {
  const log = { imageGeneration: () => {} };
  return {
    ctx: {
      llmClient: client,
      statelogClient: log,
      invocationUsage: new InvocationUsageMeter(),
      // A host with no keys unless the test gives one, so the config
      // carries only what the call set.
      host,
    },
    log,
    stack,
    threads: {},
    globals: {},
    callsite: { moduleId: "t", scopeName: "main", stepPath: "" },
  } as any;
}

describe("deterministic image cost/guard path (regression)", () => {
  it("bills the deterministic image cost against the branch", async () => {
    const stack = new StateStack();
    await underRun(imageFrame(stack), async () => {
      const r = await callHelper(_generateImage, "a red bike", "", "", "", "", [], "", "");
      expect(r.success).toBe(true);
    });
    expect(stack.localCost).toBeCloseTo(DETERMINISTIC_IMAGE_COST);
  });

  it("trips a guard tighter than the deterministic image cost", async () => {
    const stack = new StateStack();
    stack.guards.push(new CostGuard(DETERMINISTIC_IMAGE_COST / 2));
    await underRun(imageFrame(stack), async () => {
      await expect(
        callHelper(_generateImage, "x", "", "", "", "", [], "", ""),
      ).rejects.toBeTruthy();
    });
  });
});

describe("the host's keys on an image call", () => {
  const host = memoryHost({ variables: { OPENAI_API_KEY: "o-host", GEMINI_API_KEY: "g-host" } });

  it("sends the host's keys when the call passes none", async () => {
    const client = new RecordingImageClient([]);
    await underRun(imageFrame(new StateStack(), host, client), async () => {
      await callHelper(_generateImage, "a red bike", "", "", "", "", [], "", "");
    });
    expect(client.configs[0].apiKey).toEqual({ openAi: "o-host", google: "g-host" });
  });

  it("lets a key the call passed win over the host's", async () => {
    const client = new RecordingImageClient([]);
    await underRun(imageFrame(new StateStack(), host, client), async () => {
      await callHelper(_generateImage, "a red bike", "", "", "", "", [], "k-call", "");
    });
    expect(client.configs[0].apiKey).toEqual({
      openAi: "k-call",
      google: "k-call",
      liteLlm: "k-call",
      openAiCompat: "k-call",
    });
  });
});
