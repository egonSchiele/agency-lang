import { describe, it, expect, vi } from "vitest";
import { agencyStore } from "../runtime/asyncContext.js";
import { _generateImage } from "./image.js";

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
  fn: (helpers: { stack: ReturnType<typeof makeStack>; imageGeneration: ReturnType<typeof vi.fn> }) => Promise<void>,
) {
  const stack = makeStack();
  const imageGeneration = vi.fn().mockResolvedValue(undefined);
  const store = {
    ctx: { llmClient: { image: imageImpl }, statelogClient: { imageGeneration } },
    stack,
    threads: {},
    globals: {},
    callsite: { moduleId: "test", scopeName: "main", stepPath: "" },
  } as any;
  await agencyStore.run(store, () => fn({ stack, imageGeneration }));
}

const okResult = (overrides: any = {}) => ({
  success: true,
  value: {
    images: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
    model: "m",
    costEstimate: { totalCost: 0.04 },
    tokenUsage: { totalTokens: 10 },
    ...overrides,
  },
});

describe("_generateImage", () => {
  it("returns base64 + mimeType and charges cost/tokens/guards on success", async () => {
    await withClient(async () => okResult(), async ({ stack, imageGeneration }) => {
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
    });
  });

  it("charges cost BEFORE enforcing guards (order matters for trips)", async () => {
    await withClient(async () => okResult(), async ({ stack }) => {
      await _generateImage("x", "", "", "", "", [], "", "");
      const chargeOrder = stack.chargeGuards.mock.invocationCallOrder[0];
      const enforceOrder = stack.enforceGuards.mock.invocationCallOrder[0];
      expect(chargeOrder).toBeLessThan(enforceOrder);
    });
  });

  it("propagates a guard trip, but still traces the spend + tokens first", async () => {
    await withClient(async () => okResult({ costEstimate: { totalCost: 5.0 } }), async ({ stack, imageGeneration }) => {
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
    });
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
      return okResult({ costEstimate: { totalCost: 0 } });
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
