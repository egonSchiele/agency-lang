import { describe, it, expect, vi } from "vitest";
import { runInTestContext } from "./asyncContext.js";
import { runPrompt } from "./prompt.js";
import { MessageThread } from "./state/messageThread.js";
import { ThreadStore } from "./state/threadStore.js";
import { makeCtx, RecordingClient } from "./promptTestHelpers.js";

/** Each LLM call's requested reasoning level is logged on its
 *  `promptCompletion`, so an eval run can report usage per level. */

async function completionFor(extraConfig: Record<string, unknown>): Promise<unknown> {
  const ctx = makeCtx();
  ctx.setLLMClient(new RecordingClient([{ return: "done" }]));
  const spy = vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  await runInTestContext(ctx, ctx.stateStack, threads, (run) =>
    runPrompt(run, {
      prompt: "hi",
      messages: new MessageThread(),
      clientConfig: { ...extraConfig } as any,
    }),
  );
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0][0];
}

describe("reasoningEffort on promptCompletion", () => {
  it("a call with reasoningEffort logs it on its completion", async () => {
    const event = await completionFor({ reasoningEffort: "high" });
    expect(event).toMatchObject({ reasoningEffort: "high" });
  });

  it("a call without one logs null", async () => {
    const event = await completionFor({});
    expect(event).toMatchObject({ reasoningEffort: null });
  });
});
