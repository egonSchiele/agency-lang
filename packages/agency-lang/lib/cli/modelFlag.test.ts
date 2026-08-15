import { describe, expect, it, vi } from "vitest";
import { InvalidArgumentError } from "@/vendor/commander/index.js";
import { resolveModelFlag } from "./modelFlag.js";

// The default catalog comes from `_listHostedModels()`. Mock it rather than
// asserting on real model names: which models ship changes month to month, and
// a test that breaks when a catalog is refreshed is a test nobody trusts. The
// text-only filtering belongs to `_listHostedModels` and is already covered in
// `lib/stdlib/llm.test.ts`; what matters here is that the resolver asks it.
vi.mock("@/stdlib/llm.js", () => ({
  _listHostedModels: () => [
    { name: "catalog-model-one", provider: "openai" },
    { name: "catalog-model-two", provider: "anthropic" },
  ],
}));

const CATALOG = ["gpt-4o-mini", "gpt-4o", "claude-opus-4-8", "gemini-2.5-pro"];

const resolve = (value: string) => resolveModelFlag(value, CATALOG);

describe("resolveModelFlag: bare names", () => {
  it("accepts a known model and states no provider", () => {
    expect(resolve("gpt-4o-mini")).toEqual({ model: "gpt-4o-mini" });
  });

  it("rejects an unknown name and suggests the closest catalog entry", () => {
    expect(() => resolve("gpt-4o-minii")).toThrow(InvalidArgumentError);
    expect(() => resolve("gpt-4o-minii")).toThrow(/Unknown model "gpt-4o-minii"/);
    expect(() => resolve("gpt-4o-minii")).toThrow(/Did you mean "gpt-4o-mini"/);
  });

  it("rejects an unknown name with no near match, and suggests nothing", () => {
    expect(() => resolve("zzzzzzzzzzzz")).toThrow(/Unknown model/);
    expect(() => resolve("zzzzzzzzzzzz")).not.toThrow(/Did you mean/);
  });

  it("names the prefix escape in the error", () => {
    expect(() => resolve("gpt-4o-minii")).toThrow(/provider\/model/);
  });
});

describe("resolveModelFlag: provider prefixes", () => {
  it("splits on the first slash", () => {
    expect(resolve("anthropic/claude-opus-4-8")).toEqual({
      model: "claude-opus-4-8",
      explicitProvider: "anthropic",
    });
  });

  it("keeps every later slash in the model name", () => {
    expect(resolve("openrouter/anthropic/claude-sonnet-4")).toEqual({
      model: "anthropic/claude-sonnet-4",
      explicitProvider: "openrouter",
    });
  });

  it("accepts an unknown provider, because provider modules register at runtime", () => {
    expect(resolve("my-company/my-tune")).toEqual({
      model: "my-tune",
      explicitProvider: "my-company",
    });
  });

  it("never checks a prefixed model against the catalog", () => {
    expect(() => resolve("openai/not-a-real-model-at-all")).not.toThrow();
  });
});

describe("resolveModelFlag: structurally invalid values", () => {
  it.each([
    ["", "empty value"],
    ["/claude-opus-4-8", "empty provider"],
    ["anthropic/", "empty model"],
    ["/", "both empty"],
  ])("rejects %s (%s)", (value) => {
    expect(() => resolve(value)).toThrow(InvalidArgumentError);
  });
});

describe("resolveModelFlag: the default catalog", () => {
  it("accepts a name the adapter returns", () => {
    expect(resolveModelFlag("catalog-model-one")).toEqual({
      model: "catalog-model-one",
    });
  });

  it("rejects a name the adapter does not return", () => {
    expect(() => resolveModelFlag("catalog-model-three")).toThrow(/Unknown model/);
  });
});
