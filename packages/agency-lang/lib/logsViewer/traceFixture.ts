import type { EventEnvelope } from "./types.js";
export type TraceContents = { answer: string; toolOutput: string; ask?: string };
export function traceEvents(traceId: string, contents: TraceContents): EventEnvelope[] {
  const data = [
    { type: "agentStart", entryNode: "main" },
    {
      type: "promptCompletion",
      model: '"m"',
      timeTaken: 100,
      messages: [{ role: "user", content: contents.ask ?? `ask for ${traceId}` }],
      completion: { output: contents.answer },
      usage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5 },
      cost: 0.01,
    },
    { type: "toolCallStart", toolName: "read" },
    { type: "toolCall", toolName: "read", output: contents.toolOutput },
    { type: "agentEnd" },
  ];
  return data.map((entry, position) => ({
    format_version: 1,
    trace_id: traceId,
    project_id: "",
    span_id: null,
    parent_span_id: null,
    data: { ...entry, timestamp: new Date(position * 1000).toISOString() },
  }));
}
export function errorEvent(traceId: string): EventEnvelope {
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "",
    span_id: null,
    parent_span_id: null,
    data: { type: "error", timestamp: new Date(5000).toISOString(), message: "failed" },
  };
}
