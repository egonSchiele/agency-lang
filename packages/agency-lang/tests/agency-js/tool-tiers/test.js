import { neutralStaysCallable, destructiveRemoved } from "./agent.js";
import { writeFileSync } from "fs";

const results = {};

// Neutral tool: first call throws, model retries, second succeeds. The tool
// must have stayed callable — two tool calls, a truthy result.
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => toolCalls.push(toolName),
  };
  const result = await neutralStaysCallable({ callbacks });
  results.neutral = {
    toolCallCount: toolCalls.length,
    succeeded: result.data !== undefined && result.data !== null,
  };
}

// Destructive tool: the model is scripted to call destructiveTool TWICE.
// The first call fails after starting destructive work → the tool is
// removed. The second scripted call must therefore be SKIPPED (never
// executed), so onToolCallStart fires exactly ONCE. If the destructive-tier
// removal wiring broke and the tool stayed callable, the second scripted
// call would execute and toolCallCount would be 2 — this is what gives the
// test teeth.
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => toolCalls.push(toolName),
  };
  const result = await destructiveRemoved({ callbacks });
  results.destructive = {
    scriptedCalls: 2,
    toolCallCount: toolCalls.length,
    hasResult: result.data !== undefined,
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
