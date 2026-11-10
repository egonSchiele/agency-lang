import { z } from "zod";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import type * as smoltalk from "smoltalk";
import { AgencyFunction } from "./agencyFunction.js";
import { DeterministicClient, type LLMMock } from "./deterministicClient.js";
import type { EmbedConfig, EmbedResult, LLMClient, PromptConfig } from "./llmClient.js";
import { RuntimeContext } from "./state/context.js";

/** Shared setup for the unit tests that drive `runPrompt` directly. */

export function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
  });
}

/** A deterministic client that also records which tools, and which
 *  hosted tools, each request offered, so a test can see the request
 *  after the cap carry none of either. */
export class RecordingClient implements LLMClient {
  readonly offered: string[][] = [];
  readonly hosted: string[][] = [];
  /** The messages each request carried, copied when it was sent. */
  readonly requests: smoltalk.Message[][] = [];
  private readonly inner: DeterministicClient;

  constructor(mocks: LLMMock[]) {
    this.inner = new DeterministicClient(mocks);
  }

  private record(config: PromptConfig): void {
    this.offered.push((config.tools ?? []).map((tool) => tool.name));
    this.hosted.push(config.hostedTools ?? []);
    this.requests.push([...config.messages]);
  }

  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.record(config);
    return this.inner.text(config);
  }

  textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    this.record(config);
    return this.inner.textStream(config);
  }

  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    return { success: false, error: "not used" };
  }
}

/** A tool that counts how many times it ran. */
export function pingTool(): { ping: AgencyFunction; runs: () => number } {
  let count = 0;
  const ping = new AgencyFunction({
    name: "ping",
    module: "test.agency",
    fn: () => {
      count += 1;
      return "pong";
    },
    params: [],
    toolDefinition: { name: "ping", description: "Returns pong.", schema: z.object({}) },
  });
  return { ping, runs: () => count };
}
