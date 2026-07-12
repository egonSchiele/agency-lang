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

// Destructive tool: one call, fails after starting destructive work → the
// model receives the removed-tool message and gives up. One tool call.
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => toolCalls.push(toolName),
  };
  const result = await destructiveRemoved({ callbacks });
  results.destructive = {
    toolCallCount: toolCalls.length,
    hasResult: result.data !== undefined,
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
