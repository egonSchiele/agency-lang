import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "./manager.js";
import { FileMemoryStore } from "./store.js";
import { StatelogClient } from "../../statelogClient.js";
import { agency } from "../agency.js";
import { RuntimeContext } from "../state/context.js";
import { StateStack } from "../state/stateStack.js";
import { ThreadStore } from "../state/threadStore.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Builds a minimal LLMClient mock. `text` is a vi.fn() so tests can
// override the next return value with `mockResolvedValueOnce`. The
// underlying value MUST match the smoltalk PromptResult shape — we
// wrap it in `{ success: true, value: { output, ... } }` so the
// MemoryManager's _text() helper unwraps cleanly. `embed` returns a
// stable 3-d vector. `textStream` is a no-op generator (memory never
// uses streaming).
function mockLlmClient() {
  const textFn = vi.fn();
  // Default: empty extraction result — most tests override this anyway.
  textFn.mockResolvedValue(wrapTextResult(
    JSON.stringify({ entities: [], relations: [], expirations: [] })
  ));
  return {
    text: textFn,
    textStream: async function* () { },
    embed: vi.fn().mockResolvedValue({
      success: true,
      value: { embeddings: [[0.1, 0.2, 0.3]], model: "mock-embed" },
    }),
  };
}

function wrapTextResult(output: string) {
  return {
    success: true,
    value: {
      output,
      toolCalls: [],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
    },
  };
}

describe("MemoryManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mgr-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to 'default' memoryId", () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    expect(manager.getMemoryId()).toBe("default");
  });

  it("sets memoryId", () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    manager.setMemoryId("user-123");
    expect(manager.getMemoryId()).toBe("user-123");
  });

  it("lazily initializes on first operation", async () => {
    const store = new FileMemoryStore(tmpDir);
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    expect(manager.isInitialized()).toBe(false);
    await manager.remember("Mom likes pottery");
    expect(manager.isInitialized()).toBe(true);
  });

  it("persists graph on save", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValue(
      wrapTextResult(JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      }))
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    await manager.save();

    const manager2 = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    await manager2.init();
    const entities = manager2.getGraph().getEntities();
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("Mom");
  });

  it("caches per memoryId — switching id keeps both in memory", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockImplementation(async (config: any) => {
      const prompt = config?.messages?.[0]?.content ?? "";
      if (prompt.includes("Alice")) {
        return wrapTextResult(JSON.stringify({
          entities: [{ name: "Alice", type: "person", observations: ["a fact"] }],
          relations: [],
          expirations: [],
        }));
      }
      if (prompt.includes("Bob")) {
        return wrapTextResult(JSON.stringify({
          entities: [{ name: "Bob", type: "person", observations: ["b fact"] }],
          relations: [],
          expirations: [],
        }));
      }
      return wrapTextResult(
        JSON.stringify({ entities: [], relations: [], expirations: [] })
      );
    });
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    manager.setMemoryId("user-a");
    await manager.remember("Alice info");
    manager.setMemoryId("user-b");
    await manager.remember("Bob info");
    // Switch back
    manager.setMemoryId("user-a");
    expect(manager.getGraph().getEntities()[0].name).toBe("Alice");
    manager.setMemoryId("user-b");
    expect(manager.getGraph().getEntities()[0].name).toBe("Bob");
  });

  it("persists on every write (remember auto-saves)", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValue(
      wrapTextResult(JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      }))
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    // Without explicit save, a fresh manager should still see the data.
    const fresh = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: mockLlmClient(),
    });
    await fresh.init();
    expect(fresh.getGraph().getEntities()).toHaveLength(1);
  });

  it("recall pipes cheap-tier candidates through the LLM filter and returns matches", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    // First text call: extraction populates Mom + observation.
    client.text.mockResolvedValueOnce(
      wrapTextResult(JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      }))
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    const mom = manager.getGraph().findEntityByName("Mom")!;
    // Tier 3 (filter) returns Mom's id from the candidate set Tier 1
    // surfaced. We assert end-to-end that the formatted recall text
    // includes the entity and its observation.
    client.text.mockResolvedValue(wrapTextResult(JSON.stringify([mom.id])));
    const text = await manager.recall("mom");
    expect(text).toContain("Mom");
    expect(text).toContain("Likes pottery");
  });

  it("recall drops Tier-3 hallucinated ids that were never offered", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValueOnce(
      wrapTextResult(JSON.stringify({
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      }))
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom likes pottery");
    // LLM hallucinates an id outside the candidate set. With the
    // hallucination guard this collapses to an empty filter result,
    // and recall should return "" rather than a corrupted entity ref.
    client.text.mockResolvedValue(
      wrapTextResult(JSON.stringify(["entity-totally-fake"])),
    );
    const text = await manager.recall("mom");
    expect(text).toBe("");
  });

  it("recall feeds embed text contextualized as '{name} ({type}): {content}'", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValueOnce(
      wrapTextResult(JSON.stringify({
        entities: [
          { name: "Maggie", type: "person", observations: ["loves to weave"] },
        ],
        relations: [],
        expirations: [],
      }))
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Maggie loves to weave");
    // The embed call we care about is the one made during the
    // remember above (when Tier 2 vectors are written). Inspect the
    // first arg passed to embed.
    const embedCalls = (client.embed as any).mock.calls;
    expect(embedCalls.length).toBeGreaterThan(0);
    const firstEmbedInput = embedCalls[0][0];
    expect(firstEmbedInput).toBe("Maggie (person): loves to weave");
  });

  it("forget uses substring matching (soft-delete via validTo)", async () => {
    const store = new FileMemoryStore(tmpDir);
    const client = mockLlmClient();
    client.text.mockResolvedValueOnce(
      wrapTextResult(JSON.stringify({
        entities: [
          {
            name: "Mom",
            type: "person",
            observations: ["Favorite color is blue"],
          },
        ],
        relations: [],
        expirations: [],
      }))
    );
    const manager = new MemoryManager({
      store,
      config: { dir: tmpDir },
      llmClient: client,
    });
    await manager.remember("Mom's favorite color is blue");
    // forget asks the LLM what to expire — return a substring that should match.
    client.text.mockResolvedValueOnce(
      wrapTextResult(JSON.stringify({
        observations: [
          { entityName: "Mom", observationContent: "favorite color" },
        ],
        relations: [],
      }))
    );
    await manager.forget("forget mom's favorite color");
    const mom = manager.getGraph().findEntityByName("Mom")!;
    const current = manager.getGraph().getCurrentObservations(mom.id);
    expect(current).toHaveLength(0);
    // Original observation still present, just expired
    expect(mom.observations[0].validTo).toBeTruthy();
  });

  /**
   * These tests drive the manager with a real `StatelogClient`
   * pointed at a temp file sink and assert the resulting event
   * stream. The shape of the stream is the contract the trace
   * viewer relies on, so regressions here would silently break
   * the tarsec viewer.
   *
   * We build the events file with `observability: true` and a
   * stable `traceId` so the run-id continuity check at the end is
   * deterministic.
   */
  describe("statelog observability", () => {
    function makeStatelogClient(file: string): StatelogClient {
      return new StatelogClient({
        host: "",
        apiKey: "",
        projectId: "test",
        traceId: "test-trace-id",
        debugMode: false,
        observability: true,
        logFile: file,
      });
    }

    function readEvents(file: string): any[] {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, "utf-8").trim();
      if (!raw) return [];
      return raw.split("\n").map((line) => JSON.parse(line));
    }

    /**
     * Tap startSpan to record the sequence of span types opened during
     * the test. startSpan/endSpan don't emit events themselves —
     * they just maintain a stack that nested events attach to via
     * `span_id` / `parent_span_id`. To assert that the umbrella spans
     * exist we spy on the call directly.
     */
    function spyOnSpans(statelogClient: StatelogClient): string[] {
      const opened: string[] = [];
      const realStart = statelogClient.startSpan.bind(statelogClient);
      vi.spyOn(statelogClient, "startSpan").mockImplementation((type) => {
        opened.push(type);
        return realStart(type);
      });
      return opened;
    }

    it("remember opens a memoryRemember span and emits prompt/embed events", async () => {
      const eventsFile = path.join(tmpDir, "events.jsonl");
      const statelogClient = makeStatelogClient(eventsFile);
      const openedSpans = spyOnSpans(statelogClient);
      const client = mockLlmClient();
      client.text.mockResolvedValue(
        wrapTextResult(JSON.stringify({
          entities: [{ name: "Mom", type: "person", observations: ["likes pottery"] }],
          relations: [],
          expirations: [],
        }))
      );
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
        statelogClient,
      });

      await manager.remember("Mom likes pottery");

      // The umbrella + inner spans were all opened in the right
      // shape — memoryRemember wraps an llmCall (extraction) and an
      // embedding span (per new observation).
      expect(openedSpans).toContain("memoryRemember");
      expect(openedSpans).toContain("llmCall");
      expect(openedSpans).toContain("embedding");

      const events = readEvents(eventsFile);
      const types = events.map((e) => e.data.type);
      expect(types).toContain("promptCompletion");
      expect(types).toContain("embedCompletion");
    });

    it("recall opens memoryRecall and parents inner spans correctly", async () => {
      const eventsFile = path.join(tmpDir, "events.jsonl");
      const statelogClient = makeStatelogClient(eventsFile);
      const client = mockLlmClient();
      // Seed an entity via remember.
      client.text.mockResolvedValueOnce(
        wrapTextResult(JSON.stringify({
          entities: [{ name: "Mom", type: "person", observations: ["likes pottery"] }],
          relations: [],
          expirations: [],
        }))
      );
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
        statelogClient,
      });
      await manager.remember("Mom likes pottery");

      // Tier-3 LLM returns the seeded entity id.
      const mom = manager.getGraph().findEntityByName("Mom")!;
      client.text.mockResolvedValueOnce(wrapTextResult(JSON.stringify([mom.id])));

      // Spy on spans + reset the events file so we only see recall.
      const openedSpans = spyOnSpans(statelogClient);
      fs.writeFileSync(eventsFile, "");
      await manager.recall("mom");

      expect(openedSpans).toContain("memoryRecall");
      // Tier 2 fires an embedding span; tier 3 fires an llmCall.
      expect(openedSpans).toContain("embedding");
      expect(openedSpans).toContain("llmCall");

      // Every event emitted inside recall has a parent_span_id —
      // they all live under the memoryRecall umbrella (or under one
      // of its child spans, which themselves chain back to recall).
      // The root-level case is when parent_span_id is null.
      const events = readEvents(eventsFile);
      const childishEvents = events.filter(
        (e) =>
          e.data.type === "promptCompletion" ||
          e.data.type === "embedCompletion",
      );
      expect(childishEvents.length).toBeGreaterThan(0);
      for (const evt of childishEvents) {
        expect(evt.parent_span_id).not.toBeNull();
      }
    });

    it("forget opens a memoryForget span", async () => {
      const eventsFile = path.join(tmpDir, "events.jsonl");
      const statelogClient = makeStatelogClient(eventsFile);
      const client = mockLlmClient();
      client.text.mockResolvedValueOnce(
        wrapTextResult(JSON.stringify({
          entities: [{ name: "Mom", type: "person", observations: ["likes pottery"] }],
          relations: [],
          expirations: [],
        }))
      );
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
        statelogClient,
      });
      await manager.remember("Mom likes pottery");
      client.text.mockResolvedValueOnce(
        wrapTextResult(JSON.stringify({
          observations: [{ entityName: "Mom", observationContent: "pottery" }],
          relations: [],
        }))
      );
      const openedSpans = spyOnSpans(statelogClient);
      fs.writeFileSync(eventsFile, "");
      await manager.forget("forget mom pottery");
      expect(openedSpans).toContain("memoryForget");
    });

    /**
     * Locks the run-id continuity invariant in §5 of the plan:
     * every memory-emitted event must carry the same `trace_id` as
     * the StatelogClient instance, which (in production) is set to
     * the run id by `RuntimeContext.createExecutionContext`. If
     * something accidentally bypasses the shared client and emits
     * via a new one, the trace splits and the viewer can't stitch.
     */
    it("all memory events inherit the StatelogClient's trace_id", async () => {
      const eventsFile = path.join(tmpDir, "events.jsonl");
      const statelogClient = makeStatelogClient(eventsFile);
      const client = mockLlmClient();
      client.text.mockResolvedValue(
        wrapTextResult(JSON.stringify({
          entities: [{ name: "Mom", type: "person", observations: ["likes pottery"] }],
          relations: [],
          expirations: [],
        }))
      );
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
        statelogClient,
      });
      await manager.remember("Mom likes pottery");
      const events = readEvents(eventsFile);
      expect(events.length).toBeGreaterThan(0);
      for (const evt of events) {
        // Every line shares the configured trace_id — no shadow
        // StatelogClient created somewhere in the manager.
        expect(evt.trace_id).toBe("test-trace-id");
      }
    });
  });

  // Memory's `_text` and `_embed` charge the surrounding branch's
  // `withCostGuard` budget via `agency.addCost(...)`. Production
  // paths always reach the manager from inside an Agency execution
  // frame (post-completion hook in prompt.ts, or stdlib agency code
  // calling remember/recall/forget); these tests install a frame by
  // hand to exercise the same charge path without spinning up a
  // full Runner.
  describe("cost attribution", () => {
    function makeFrame() {
      const ctx = new RuntimeContext({
        statelogConfig: {
          host: "",
          apiKey: "",
          projectId: "",
          debugMode: false,
          observability: false,
        },
        smoltalkDefaults: {},
        dirname: process.cwd(),
      });
      return { ctx, stack: new StateStack(), threads: new ThreadStore() };
    }

    function mockLlmClientWithCost(textCost: number, embedCost: number) {
      const client = mockLlmClient();
      client.text.mockResolvedValue({
        success: true,
        value: {
          output: JSON.stringify({ entities: [], relations: [], expirations: [] }),
          toolCalls: [],
          model: "mock",
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
          cost: {
            inputCost: 0,
            outputCost: textCost,
            totalCost: textCost,
            currency: "USD",
          },
        },
      });
      client.embed.mockResolvedValue({
        success: true,
        value: {
          embeddings: [[0.1, 0.2, 0.3]],
          model: "mock-embed",
          costEstimate: {
            inputCost: embedCost,
            outputCost: 0,
            totalCost: embedCost,
            currency: "USD",
          },
        },
      });
      return client;
    }

    it("charges _text spend to the active branch's localCost", async () => {
      const env = makeFrame();
      const client = mockLlmClientWithCost(0.05, 0);
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
      });
      const before = env.stack.localCost;
      await agency.withTestContext(env, async () => {
        // `remember` calls `_text` once for the extraction prompt and
        // returns early when the parse yields no entities — no embed
        // call follows, so this isolates the text-cost charge.
        await manager.remember("nothing notable");
      });
      expect(env.stack.localCost).toBeCloseTo(before + 0.05, 10);
    });

    it("charges _embed spend in addition to _text spend", async () => {
      const env = makeFrame();
      const client = mockLlmClientWithCost(0.05, 0.01);
      // Extraction yields one entity with one observation → one
      // _text call ($0.05) + one _embed call ($0.01).
      client.text.mockResolvedValueOnce(
        wrapTextResultWithCost(
          JSON.stringify({
            entities: [
              { name: "Maggie", type: "person", observations: ["weaves baskets"] },
            ],
            relations: [],
            expirations: [],
          }),
          0.05,
        ),
      );
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
      });
      const before = env.stack.localCost;
      await agency.withTestContext(env, async () => {
        await manager.remember("Maggie weaves baskets");
      });
      expect(env.stack.localCost).toBeCloseTo(before + 0.05 + 0.01, 10);
    });

    it("no-ops cleanly when called outside any Agency frame", async () => {
      // Direct-construction unit tests (the rest of this file) call
      // the manager without ever installing a frame. The charge path
      // must silently skip in that case rather than throwing.
      const client = mockLlmClientWithCost(0.05, 0);
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
      });
      await expect(manager.remember("anything")).resolves.toBeUndefined();
    });

    it("trips a withCostGuard when memory's spend exceeds the budget", async () => {
      const env = makeFrame();
      const client = mockLlmClientWithCost(1.0, 0);
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
      });
      await agency.withTestContext(env, async () => {
        // $0.50 budget, memory's _text call charges $1.00 →
        // `enforceGuards()` inside `agency.addCost` throws.
        await expect(
          agency.withCostGuard(0.5, async () => {
            await manager.remember("anything");
          }),
        ).rejects.toThrow(/cost/i);
      });
    });

    it("propagates a GuardExceededError from inside generateEmbeddings's swallow site", async () => {
      // Regression for the original Proposal A PR review: memory has
      // several "best effort" catches around _text / _embed (per-obs
      // embed in generateEmbeddings, tier-2 query embed, tier-3 LLM
      // filter). If those catches absorbed a GuardExceededError, the
      // surrounding withCostGuard would silently fail to trip. This
      // test pins the propagation by making the embed-side cost
      // (not the text cost) blow the budget — the throw happens
      // inside the catch block of `generateEmbeddings`.
      const env = makeFrame();
      const client = mockLlmClientWithCost(0, 1.0);
      // Extraction returns one entity with one observation so
      // generateEmbeddings runs at all.
      client.text.mockResolvedValueOnce(
        wrapTextResultWithCost(
          JSON.stringify({
            entities: [
              { name: "Maggie", type: "person", observations: ["weaves baskets"] },
            ],
            relations: [],
            expirations: [],
          }),
          0,
        ),
      );
      const manager = new MemoryManager({
        store: new FileMemoryStore(tmpDir),
        config: { dir: tmpDir },
        llmClient: client,
      });
      await agency.withTestContext(env, async () => {
        await expect(
          agency.withCostGuard(0.5, async () => {
            await manager.remember("Maggie weaves baskets");
          }),
        ).rejects.toThrow(/cost/i);
      });
    });
  });
});

// Build a PromptResult with a specific `totalCost` for the test-cost
// suite. Same shape as `wrapTextResult` but lets the caller pin the
// cost so assertions can mix calls with different prices.
function wrapTextResultWithCost(output: string, totalCost: number) {
  return {
    success: true,
    value: {
      output,
      toolCalls: [],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      cost: { inputCost: 0, outputCost: totalCost, totalCost, currency: "USD" },
    },
  };
}
