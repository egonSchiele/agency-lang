import { main, shaped, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { ToolCall } from "smoltalk";

// promptStart pairing contract: every promptCompletion is preceded by a
// promptStart in the same span, in strict start→completion alternation
// PER SPAN. The payload carries the request shape (message/tool counts,
// schema + maxTokens fingerprint, threadId), not the messages.

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

let callIndex = 0;
const client = {
  async text() {
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        value: {
          output: null,
          toolCalls: [new ToolCall("call-1", "getArea", { country: "France" })],
          model: "test",
          usage: USAGE,
          cost: COST,
        },
      };
    }
    if (idx === 1) {
      return {
        success: true,
        value: { output: "ok", toolCalls: [], model: "test", usage: USAGE, cost: COST },
      };
    }
    return {
      success: true,
      value: {
        output: JSON.stringify({ answer: "json-ok" }),
        toolCalls: [],
        model: "test",
        usage: USAGE,
        cost: COST,
      },
    };
  },
  async *textStream(config) {
    const r = await this.text(config);
    if (r.success) yield { type: "done", result: r.value };
    else yield { type: "error", error: r.error };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const mainResult = await main();
const shapedResult = await shaped();

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const starts = events.filter((e) => e.data?.type === "promptStart");
const completions = events.filter((e) => e.data?.type === "promptCompletion");

// Per-span alternation: within each span, starts and completions must
// strictly alternate S,C,S,C,...
const bySpan = {};
for (const event of events) {
  if (event.data?.type === "promptStart" || event.data?.type === "promptCompletion") {
    const key = event.span_id ?? "none";
    if (!bySpan[key]) {
      bySpan[key] = "";
    }
    bySpan[key] += event.data.type === "promptStart" ? "S" : "C";
  }
}
const perSpanAlternation = Object.values(bySpan).every((sequence) =>
  /^(SC)+$/.test(sequence),
);

const fingerprintStart = starts.find((e) => e.data.hasResponseFormat === true);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      mainData: mainResult.data,
      shapedData: shapedResult.data,
      startCount: starts.length,
      completionCount: completions.length,
      perSpanAlternation,
      spanCount: Object.keys(bySpan).length,
      firstStartShape: {
        toolCount: starts[0]?.data.toolCount,
        hasResponseFormat: starts[0]?.data.hasResponseFormat,
        hasMessages: "messages" in (starts[0]?.data ?? {}),
        threadIdMatchesCompletion:
          starts[0]?.data.threadId === completions[0]?.data.threadId &&
          starts[0]?.data.threadId != null,
      },
      fingerprint: {
        found: fingerprintStart != null,
        maxTokens: fingerprintStart?.data.maxTokens,
      },
    },
    null,
    2,
  ),
);
