import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { memoryHost } from "../host/memoryHost.js";
import {
  SmolError,
  SmolContentPolicyError,
  SmolContextWindowExceededError,
  SmolTimeoutError,
  SmolRateLimitError,
  SmolOverloadedError,
  SmolAuthError,
} from "smoltalk";
import {
  PROVIDER_KEY_VARIABLES,
  SmoltalkClient,
  apiKeysFromSettings,
  toSmolConfig,
} from "./llmClient.js";

const require = createRequire(import.meta.url);

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
    expect(client.normalizeError(new SmolContextWindowExceededError("too long")).kind).toBe(
      "contextWindow",
    );
    expect(client.normalizeError(new SmolTimeoutError("timed out")).kind).toBe("requestTimeout");
    expect(client.normalizeError(new SmolAuthError("bad key")).kind).toBe("auth");
  });

  it("maps typed retryable errors to a kind", () => {
    expect(client.normalizeError(new SmolRateLimitError("slow down")).kind).toBe("rateLimit");
    expect(client.normalizeError(new SmolOverloadedError("server busy")).kind).toBe("overloaded");
  });

  it("keeps the typed kind for smoltalk 0.13.1's transient 400", () => {
    // Anthropic sometimes answers a valid request with a bare 400 "Invalid
    // request data" mid-generation. smoltalk maps it to SmolOverloadedError
    // with the 400 left on it; the typed kind must win over the status so
    // the retry policy treats it as transient rather than terminal.
    const err = new SmolOverloadedError("400 Invalid request data", { status: 400 });
    const n = client.normalizeError(err);
    expect(n.kind).toBe("overloaded");
    expect(n.status).toBe(400);
  });

  it("returns just the message for a non-smoltalk error", () => {
    const n = client.normalizeError(new Error("ECONNRESET"));
    expect(n).toEqual({ message: "ECONNRESET" });
  });
});

describe("toSmolConfig — metadata pass-through", () => {
  // smoltalk-llama-cpp reads its settings (llamaCppDraftModel, and the like)
  // from `config.metadata`. The baked defaults are spread to the top level,
  // so a `metadata` object baked among them has to come out as the top-level
  // `metadata` key of the smoltalk config, not be lost in the spread.
  it("forwards a metadata object baked among the defaults as smoltalk's metadata", () => {
    const clientConfig = {
      model: "/m/big.gguf",
      provider: "llama-cpp",
      metadata: { llamaCppDraftModel: "/m/small.gguf" },
    };
    const promptConfig = { ...clientConfig, messages: [], metadata: clientConfig } as any;
    const out = toSmolConfig(promptConfig) as any;
    expect(out.metadata).toEqual({ llamaCppDraftModel: "/m/small.gguf" });
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

describe("toSmolConfig — logprobs pass-through", () => {
  it("forwards the logprobs option", () => {
    const smol = toSmolConfig({
      messages: [],
      model: "gpt-4o",
      logprobs: { top: 2 },
    } as any);
    expect(smol.logprobs).toEqual({ top: 2 });
  });
});

describe("apiKeysFromSettings", () => {
  it("fills a slot for each key the host holds and skips the rest", () => {
    const host = memoryHost({ variables: { GEMINI_API_KEY: "g-1", OPENAI_API_KEY: "o-1" } });
    expect(apiKeysFromSettings(host.settings)).toEqual({ google: "g-1", openAi: "o-1" });
  });

  it("leaves out a variable that is empty", () => {
    const host = memoryHost({ variables: { GEMINI_API_KEY: "" } });
    expect(apiKeysFromSettings(host.settings)).toEqual({});
  });

  // smoltalk's resolveApiKey (dist/util/provider.js) pairs each slot with
  // the variable it falls back to: `k?.google || env("GEMINI_API_KEY")`.
  // Read those pairs out of the installed copy, so a provider smoltalk adds
  // or renames shows up here as a failing test.
  it("names the same variables as smoltalk's resolveApiKey", () => {
    // `require.resolve("smoltalk")` is dist/index.js; provider.js is beside it.
    const providerFile = path.join(path.dirname(require.resolve("smoltalk")), "util/provider.js");
    const source = readFileSync(providerFile, "utf8");
    const pairs: Record<string, string> = {};
    for (const match of source.matchAll(/k\?\.(\w+) \|\| env\("(\w+)"\)/g)) {
      pairs[match[1]] = match[2];
    }
    expect(Object.keys(pairs).length).toBeGreaterThan(0);
    expect(PROVIDER_KEY_VARIABLES).toEqual(pairs);
  });
});

describe("toSmolConfig — tools are never strict", () => {
  // With strict off, smoltalk lets a provider accept an argument key that
  // is not in the schema, which is what lets the runtime forgive a
  // parameter alias (`url` for `baseUrl`). A strict tool would have the
  // provider refuse the alias before Agency saw it.
  it("passes tools through without a strict flag", () => {
    const tool = { name: "fetch", description: "", schema: null };
    const out = toSmolConfig({ messages: [], tools: [tool] } as any) as any;
    expect(out.tools).toEqual([tool]);
    expect(out.tools[0].strict).toBeUndefined();
  });
});
