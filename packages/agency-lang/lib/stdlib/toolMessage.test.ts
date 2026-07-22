import { describe, it, expect } from "vitest";
import { _toolMessage } from "./thread.js";
import { agency } from "../runtime/agency.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

function makeCtx(): RuntimeContext<any> {
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

describe("_toolMessage", () => {
  it("seeds exactly a matched assistant tool-call + tool-result pair", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.", "budget");
      },
    );

    const msgs = threads
      .getOrCreateActive()
      .getMessages()
      .map((m: any) => m.toJSON());

    // Exactly two messages, nothing stray, in order.
    expect(msgs).toHaveLength(2);
    const [asst, tool] = msgs;

    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("");
    expect(asst.toolCalls).toHaveLength(1);
    expect(asst.toolCalls[0].name).toBe("saveDraft");
    expect(asst.toolCalls[0].arguments).toEqual({ value: "hi" });

    expect(tool.role).toBe("tool");
    expect(tool.name).toBe("saveDraft");
    expect(tool.content).toBe("Draft saved.");
    expect(tool.tool_call_id).toBe(asst.toolCalls[0].id);
  });

  it("labels both pushed messages", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.", "budget");
      },
    );
    const thread = threads.getOrCreateActive();
    expect(thread.labelAt(0)).toBe("budget");
    expect(thread.labelAt(1)).toBe("budget");
  });

  it("leaves both messages unlabeled when no label is given", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.");
      },
    );
    const thread = threads.getOrCreateActive();
    expect(thread.labelAt(0)).toBe(null);
    expect(thread.labelAt(1)).toBe(null);
  });

  it("defaults null/undefined args to an empty record", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("noArgs", null, "ok");
      },
    );
    const asst: any = threads.getOrCreateActive().getMessages()[0].toJSON();
    expect(asst.toolCalls[0].arguments).toEqual({});
  });

  it("creates the active thread when there is none", async () => {
    const ctx = makeCtx();
    const threads = new ThreadStore(); // bare: no default active thread
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.");
      },
    );
    expect(threads.getOrCreateActive().getMessages()).toHaveLength(2);
  });

  it("throws a clear error on non-serializable args and pushes nothing", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const circular: any = {};
    circular.self = circular;

    await expect(
      agency.withTestContext(
        { ctx, stack: ctx.stateStack, threads },
        async () => {
          await _toolMessage("x", circular, "r");
        },
      ),
    ).rejects.toThrow(/could not be serialized/);

    expect(threads.getOrCreateActive().getMessages()).toHaveLength(0);
  });
});
