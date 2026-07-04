import { describe, it, expect } from "vitest";
import {
  SmolError,
  SmolContentPolicyError,
  SmolContextWindowExceededError,
  SmolTimeoutError,
  SmolRateLimitError,
  SmolOverloadedError,
  SmolAuthError,
} from "smoltalk";
import { SmoltalkClient, toSmolConfig } from "./llmClient.js";

describe("SmoltalkClient.normalizeError", () => {
  const client = new SmoltalkClient();

  it("extracts status and retryAfterMs from an HTTP SmolError", () => {
    // smoltalk parses `retry-after` itself (`retryAfterMs` on the error);
    // we just read it through.
    const err = new SmolError("429 too many requests", {
      status: 429,
      retryAfterMs: 5000,
    });
    const n = client.normalizeError(err);
    expect(n.status).toBe(429);
    expect(n.retryAfterMs).toBe(5000);
    expect(n.kind).toBeUndefined();
    expect(n.message).toBe("429 too many requests");
  });

  it("maps typed terminal errors to a kind", () => {
    expect(client.normalizeError(new SmolContentPolicyError("blocked")).kind).toBe("contentPolicy");
    expect(client.normalizeError(new SmolContextWindowExceededError("too long")).kind).toBe("contextWindow");
    expect(client.normalizeError(new SmolTimeoutError("timed out")).kind).toBe("requestTimeout");
    expect(client.normalizeError(new SmolAuthError("bad key")).kind).toBe("auth");
  });

  it("maps typed retryable errors to a kind", () => {
    expect(client.normalizeError(new SmolRateLimitError("slow down")).kind).toBe("rateLimit");
    expect(client.normalizeError(new SmolOverloadedError("server busy")).kind).toBe("overloaded");
  });

  it("returns just the message for a non-smoltalk error", () => {
    const n = client.normalizeError(new Error("ECONNRESET"));
    expect(n).toEqual({ message: "ECONNRESET" });
  });
});

describe("toSmolConfig — apiKey/baseUrl pass-through", () => {
  // prompt.ts builds the PromptConfig as `{ ...clientConfig, metadata: clientConfig }`,
  // so the nested apiKey/baseUrl maps arrive via metadata. toSmolConfig must
  // NOT clobber them (which would break non-OpenAI + hosted providers).
  it("preserves the full nested apiKey + baseUrl maps from the client config", () => {
    const clientConfig = {
      model: "z-ai/glm-5.2",
      provider: "openrouter",
      apiKey: { openAi: "sk-o", anthropic: "sk-a", openRouter: "sk-or" },
      baseUrl: { openRouter: "https://or/v1" },
    };
    const promptConfig = { ...clientConfig, messages: [], metadata: clientConfig } as any;
    const out = toSmolConfig(promptConfig) as any;
    expect(out.apiKey).toEqual({ openAi: "sk-o", anthropic: "sk-a", openRouter: "sk-or" });
    expect(out.baseUrl).toEqual({ openRouter: "https://or/v1" });
    expect(out.provider).toBe("openrouter");
  });

  it("overrides only the openAi slot when a per-call apiKey names just openAi", () => {
    const clientConfig = {
      model: "gpt-4o",
      apiKey: { openAi: "sk-baked", anthropic: "sk-a" },
    };
    const promptConfig = {
      ...clientConfig,
      apiKey: { openAi: "sk-percall" }, // per-call, single provider
      messages: [],
      metadata: clientConfig,
    } as any;
    const out = toSmolConfig(promptConfig) as any;
    expect(out.apiKey).toEqual({ openAi: "sk-percall", anthropic: "sk-a" });
  });

  it("merges a per-call apiKey object over the baked-in map (per-provider override)", () => {
    const clientConfig = {
      model: "claude-opus-4",
      apiKey: { openAi: "sk-o", anthropic: "sk-baked" },
    };
    const promptConfig = {
      ...clientConfig,
      apiKey: { anthropic: "sk-percall", google: "sk-g" }, // per-call object override
      messages: [],
      metadata: clientConfig,
    } as any;
    const out = toSmolConfig(promptConfig) as any;
    // openAi preserved from baked-in, anthropic overridden, google added.
    expect(out.apiKey).toEqual({ openAi: "sk-o", anthropic: "sk-percall", google: "sk-g" });
  });
});
