import { describe, it, expect } from "vitest";
import { memoryHost } from "../host/memoryHost.js";
import { runInTestContext } from "./asyncContext.js";
import { DeterministicClient } from "./deterministicClient.js";
import { withHostKeys, type PromptConfig } from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";

// smoltalk's own env() answers nothing in a browser, so the keys a page can
// use are the ones the runtime puts in the config. They come from the
// host's settings, and go underneath the config's own: agency.json and the
// call win.

class RecordingClient extends DeterministicClient {
  textConfigs: PromptConfig[] = [];

  async text(config: PromptConfig) {
    this.textConfigs.push(config);
    return super.text(config);
  }
}

const variables = { GEMINI_API_KEY: "g-host", OPENAI_API_KEY: "o-host" };

describe("withHostKeys", () => {
  it("puts the host's keys under the config's keys", () => {
    const host = memoryHost({ variables });
    const config = withHostKeys(host.settings, { model: "m", apiKey: { google: "g-baked" } });
    expect(config.apiKey).toEqual({ google: "g-baked", openAi: "o-host" });
  });

  it("fills a slot the config holds as an empty string", () => {
    // What the generated header bakes in a page, where the default host
    // has no variables when the module loads.
    const host = memoryHost({ variables });
    const config = withHostKeys(host.settings, {
      model: "m",
      apiKey: { google: "", openAi: "", anthropic: "" },
    });
    expect(config.apiKey).toEqual({ google: "g-host", openAi: "o-host" });
  });

  it("returns the config as is when the host holds no key", () => {
    const config: { model: string; apiKey?: Record<string, string> } = { model: "m" };
    expect(withHostKeys(memoryHost().settings, config)).toBe(config);
  });
});

function contextWith(host: ReturnType<typeof memoryHost>) {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test",
      projectId: "test",
      debugMode: false,
    },
    smoltalkDefaults: { model: "gemini-2.5-flash", provider: "google" },
    dirname: "/tmp",
    host,
  });
}

describe("runPrompt and the host", () => {
  it("sends the host's keys with the call", async () => {
    const ctx = contextWith(memoryHost({ variables }));
    const client = new RecordingClient([{ return: "ok" }]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await runInTestContext(ctx, ctx.stateStack, threads, (run) =>
      runPrompt(run, { prompt: "hi", messages: threads.getOrCreateActive(), clientConfig: {} }),
    );
    expect(client.textConfigs).toHaveLength(1);
    expect(client.textConfigs[0].apiKey).toEqual({ google: "g-host", openAi: "o-host" });
  });

  it("refuses the call on a host without the llm capability", async () => {
    const host = memoryHost({ variables, capabilities: ["network", "env", "terminal"] });
    const ctx = contextWith(host);
    const client = new RecordingClient([{ return: "ok" }]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await expect(
      runInTestContext(ctx, ctx.stateStack, threads, (run) =>
        runPrompt(run, { prompt: "hi", messages: threads.getOrCreateActive(), clientConfig: {} }),
      ),
    ).rejects.toThrow("llm needs the llm capability, which the memory host does not have.");
    expect(client.textConfigs).toHaveLength(0);
  });
});
