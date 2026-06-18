import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../statelog/wireTypes.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { StatelogClient } from "../statelogClient.js";
import {
  _evalValue,
  _evalValues,
  _evalOutput,
  _evalOutputs,
  _evalRecord,
  _finalEvalOutput,
} from "./statelog.js";

let ts = 0;

function nextTs(): string {
  ts += 100;
  return new Date(1_700_000_000_000 + ts).toISOString();
}

function event(type: string, data: Record<string, unknown> = {}): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "trace-stdlib",
    project_id: "project",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: nextTs(), ...data },
  };
}

function writeJsonl(dir: string, events: EventEnvelope[]): string {
  const filePath = path.join(dir, "statelog.jsonl");
  fs.writeFileSync(filePath, events.map((ev) => JSON.stringify(ev)).join("\n"));
  return filePath;
}

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

function spyClient(ctx: RuntimeContext<any>) {
  const evalValueRecorded = vi.fn(async () => undefined);
  const evalOutputRecorded = vi.fn(async () => undefined);
  ctx.statelogClient = {
    ...ctx.statelogClient,
    evalValueRecorded,
    evalOutputRecorded,
  } as any;
  return { evalValueRecorded, evalOutputRecorded };
}

async function withFrame(
  threads: ThreadStore,
  fn: (spies: ReturnType<typeof spyClient>) => Promise<void>,
): Promise<void> {
  const ctx = makeCtx();
  const spies = spyClient(ctx);
  await runInTestContext(ctx, new StateStack(), threads, () => fn(spies));
}

describe("std::statelog eval annotations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdlib-statelog-"));
    ts = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records eval input with the active thread id", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const threadId = threads.activeId();
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalValue("hello");
    });

    expect(spies.evalValueRecorded).toHaveBeenCalledOnce();
    expect(spies.evalValueRecorded).toHaveBeenCalledWith({
      value: "hello",
      threadId,
    });
  });

  it("round-trips plain objects before recording", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalValue({ foo: 1 });
    });

    expect(spies.evalValueRecorded).toHaveBeenCalledWith({
      value: { foo: 1 },
      threadId: threads.activeId(),
    });
  });

  it("records null and coerces undefined to null", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalOutput(null);
      await _evalOutput(undefined);
    });

    expect(spies.evalOutputRecorded).toHaveBeenNthCalledWith(1, {
      value: null,
      threadId: threads.activeId(),
    });
    expect(spies.evalOutputRecorded).toHaveBeenNthCalledWith(2, {
      value: null,
      threadId: threads.activeId(),
    });
  });

  it("no-ops outside an Agency execution frame", async () => {
    await expect(_evalValue("hello")).resolves.toBeUndefined();
  });

  it("rejects circular values at the call site", async () => {
    const circular: any = {};
    circular.self = circular;
    await withFrame(ThreadStore.withDefaultActive(makeCtx().statelogClient), async () => {
      await expect(_evalValue(circular)).rejects.toThrow(TypeError);
    });
  });

  it("rejects top-level functions with a clear serialization error", async () => {
    await withFrame(ThreadStore.withDefaultActive(makeCtx().statelogClient), async () => {
      await expect(_evalValue(() => "nope")).rejects.toThrow(
        /must be JSON-serializable/i,
      );
    });
  });

  it("rejects top-level symbols with a clear serialization error", async () => {
    await withFrame(ThreadStore.withDefaultActive(makeCtx().statelogClient), async () => {
      await expect(_evalOutput(Symbol("nope"))).rejects.toThrow(
        /must be JSON-serializable/i,
      );
    });
  });

  it("resolves with a disabled statelog client", async () => {
    const ctx = makeCtx();
    ctx.statelogClient = new StatelogClient({
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
      observability: false,
    });
    await runInTestContext(ctx, new StateStack(), new ThreadStore(), async () => {
      await expect(_evalValue("x")).resolves.toBeUndefined();
      await expect(_evalOutput("y")).resolves.toBeUndefined();
    });
  });

  it("records null threadId when there is no active thread", async () => {
    const ctx = makeCtx();
    const threads = new ThreadStore();
    const spies = spyClient(ctx);

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      await _evalOutput("x");
    });

    expect(spies.evalOutputRecorded).toHaveBeenCalledWith({
      value: "x",
      threadId: null,
    });
  });

  it("exposes parser projections for agents", async () => {
    const statelogPath = writeJsonl(tmpDir, [
      event("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
      event("evalValueRecorded", { threadId: "0", value: "question" }),
      event("evalOutputRecorded", { threadId: "0", value: "draft" }),
      event("evalOutputRecorded", { threadId: "0", value: "answer" }),
    ]);

    await expect(_evalValues(statelogPath)).resolves.toMatchObject([
      { value: "question", threadId: "0" },
    ]);
    await expect(_evalOutputs(statelogPath)).resolves.toMatchObject([
      { value: "draft", threadId: "0" },
      { value: "answer", threadId: "0" },
    ]);
    await expect(_finalEvalOutput(statelogPath)).resolves.toMatchObject({
      value: "answer",
      threadId: "0",
    });
    await expect(_evalRecord(statelogPath)).resolves.toMatchObject({
      traceId: "trace-stdlib",
      source: statelogPath,
    });
  });
});
