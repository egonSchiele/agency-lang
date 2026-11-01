import { main, hasInterrupts, __setLLMClient } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

__setLLMClient({
  async text() {
    return {
      success: true,
      value: { output: "a red square", toolCalls: [], model: "test", usage: USAGE, cost: COST },
    };
  },
  async *textStream(config) {
    const result = await this.text(config);
    yield { type: "done", result: result.value };
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
});

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

// 6,000 bytes of picture: 8,000 base64 characters, over the 4,096 limit.
const PICTURE_BYTES = 6000;
const base64 = Buffer.alloc(PICTURE_BYTES, 7).toString("base64");
const attachment = { type: "image", source: { kind: "base64", base64, mimeType: "image/png" } };
const marker = `[image/png: ${PICTURE_BYTES} bytes omitted]`;

const result = await main(attachment);

const lines = readFileSync("statelog.log", "utf-8").trim().split("\n");
const events = lines.map((line) => JSON.parse(line));
const linesOfType = (type) => lines.filter((line, index) => events[index].data.type === type);
const nodeEvents = events.filter((event) =>
  ["enterNode", "exitNode", "followEdge"].includes(event.data.type),
);
const interruptedExit = events.find(
  (event) => event.data.type === "exitNode" && event.data.data?.data?.[0]?.checkpoint,
);
const promptCompletion = events.find((event) => event.data.type === "promptCompletion");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      paused: hasInterrupts(result.data),
      noLineHoldsThePicture: lines.every((line) => !line.includes(base64)),
      // promptCompletion is left out: its messages are already redacted by
      // smoltalk's redactAttachments before they reach the statelog client,
      // so that line carries smoltalk's own marker.
      markerIn: Object.fromEntries(
        ["agentStart", "enterNode", "followEdge", "exitNode"].map((type) => [
          type,
          linesOfType(type).some((line) => line.includes(marker)),
        ]),
      ),
      checkpointHoldsTheMarker:
        interruptedExit !== undefined &&
        JSON.stringify(interruptedExit.data.data.data[0].checkpoint).includes(marker),
      nodeEventsHoldNoRuntime: nodeEvents.every(
        (event) => !("ctx" in event.data.data) && !("run" in event.data.data),
      ),
      nodeEventCount: nodeEvents.length,
      toolsLogged: promptCompletion?.data.tools,
    },
    null,
    2,
  ),
);
