import { describe, it, expect } from "vitest";
import { withThreadEndHooksEvents } from "./threadEndHooksEvents.js";

function recordingClient() {
  const calls: string[] = [];
  return {
    calls,
    startSpan: (type: string) => {
      calls.push(`startSpan:${type}`);
      return "span-1";
    },
    endSpan: (spanId?: string) => {
      calls.push(`endSpan:${spanId}`);
      return undefined;
    },
    threadEndHooksStart: async (payload: any) => {
      calls.push(`start:${payload.threadId}:${payload.eagerSummarize}`);
    },
    threadEndHooksEnd: async (payload: any) => {
      calls.push(`end:${payload.threadId}:${typeof payload.timeTaken}`);
    },
  };
}

const PAYLOAD = { threadId: "t1", eagerSummarize: true, messageCount: 2 };

describe("withThreadEndHooksEvents", () => {
  it("brackets fn with span + start/end events and returns its value", async () => {
    const client = recordingClient();
    const value = await withThreadEndHooksEvents(client as any, PAYLOAD, async () => "hook-result");
    expect(value).toBe("hook-result");
    expect(client.calls).toEqual([
      "startSpan:threadEndHooks",
      "start:t1:true",
      "end:t1:number",
      "endSpan:span-1",
    ]);
  });

  it("posts the end event and closes the span even when fn throws, propagating the error", async () => {
    const client = recordingClient();
    await expect(
      withThreadEndHooksEvents(client as any, { ...PAYLOAD, threadId: "t2", eagerSummarize: false }, async () => {
        throw new Error("hook boom");
      }),
    ).rejects.toThrow("hook boom");
    expect(client.calls).toEqual([
      "startSpan:threadEndHooks",
      "start:t2:false",
      "end:t2:number",
      "endSpan:span-1",
    ]);
  });

  it("degrades to a bare fn() when the client is null", async () => {
    const value = await withThreadEndHooksEvents(null as any, PAYLOAD, async () => 42);
    expect(value).toBe(42);
  });

  it("degrades when the client has the start method but not the end method", async () => {
    // The finally posts the end event; a client missing only that method
    // would throw from the finally and mask the primary exception.
    const lopsided = {
      startSpan: () => "s",
      endSpan: () => undefined,
      threadEndHooksStart: async () => undefined,
    };
    const value = await withThreadEndHooksEvents(lopsided as any, PAYLOAD, async () => "ok");
    expect(value).toBe("ok");
  });

  it("degrades to a bare fn() when the client lacks the new methods", async () => {
    // Older test contexts construct partial statelog clients (see the
    // ?.threadEndHookError?. guard in runner.ts). Instrumentation must
    // never be the thing that throws from thread's finally.
    const partial = { startSpan: () => "s" };
    const value = await withThreadEndHooksEvents(partial as any, PAYLOAD, async () => "ok");
    expect(value).toBe("ok");
  });
});
