// Test fixtures use real envelopes. The recorded fixture retains all 66
// events, caps string leaves in message content/tool output at 400 chars,
// and retains advertised tool names without their repeated schemas.
import { readFileSync } from "node:fs";
import { buildForest } from "./tree.js";
import { parseStatelogJsonl } from "./parse.js";
import type { EventEnvelope, TreeNode } from "./types.js";
export function sampleRunForest(): TreeNode[] {
  return buildForest(
    parseStatelogJsonl(
      readFileSync(new URL("./fixtures/handler-chain.jsonl", import.meta.url), "utf8"),
    ).events,
  );
}
export function event(
  type: string,
  at: number,
  spanId: string | null,
  parent: string | null = null,
  data: Record<string, unknown> = {},
): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "T",
    project_id: "",
    span_id: spanId,
    parent_span_id: parent,
    data: { type, timestamp: new Date(at).toISOString(), ...data },
  };
}
export function loopEvents(): EventEnvelope[] {
  const messages = [{ role: "user", content: "write a module" }];
  return [
    event("promptCompletion", 100, "L", null, {
      messages,
      completion: { toolCalls: [{ name: "agencyGuide" }] },
    }),
    event("toolCallStart", 101, "guide", "L", {
      toolName: "agencyGuide",
      args: { filename: "handlers.md" },
    }),
    event("handlerDecision", 102, "handler1", "guide", {
      interruptId: "read",
      decision: "approve",
    }),
    event("interruptResolved", 103, "guide", "L", {
      interruptId: "read",
      outcome: "approved",
      resolvedBy: "ipc",
      interrupt: { effect: "std::read", message: "Read?" },
    }),
    event("toolCall", 107, "guide", "L", {
      toolName: "agencyGuide",
      output: "guide",
      timeTaken: 6,
    }),
    event("promptCompletion", 200, "L", null, {
      messages,
      completion: { toolCalls: [{ name: "grep" }] },
    }),
    event("toolCallStart", 201, "grep", "L", { toolName: "grep", args: { pattern: "foo" } }),
    event("handlerDecision", 202, "handler2", "grep", {
      interruptId: "grep-id",
      decision: "reject",
    }),
    event("interruptResolved", 203, "grep", "L", {
      interruptId: "grep-id",
      outcome: "rejected",
      interrupt: { effect: "std::grep", message: "Search?" },
    }),
    event("promptCompletion", 300, "L", null, { messages, completion: { output: "done" } }),
  ];
}
export function agentLoopTrace(): TreeNode {
  return buildForest(loopEvents())[0];
}
