import { testSafeRetry, testUnsafeNoRetry } from "./agent.js";
import { writeFileSync } from "fs";

const results = {};

// Test 1: Safe retry — lookupTool throws on first call, LLM retries, succeeds
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => {
      toolCalls.push(toolName);
    },
  };
  const result = await testSafeRetry({ callbacks });
  results.safeRetry = {
    toolCallCount: toolCalls.length,
    toolCalls,
    succeeded: result.data !== undefined && result.data !== null,
  };
}

// Test 2: Unsafe no retry — saveAndLookupTool calls saveItem (unsafe) then lookupItem throws
// Tool should be removed, not retried
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => {
      toolCalls.push(toolName);
    },
  };
  try {
    const result = await testUnsafeNoRetry({ callbacks });
    results.unsafeNoRetry = {
      toolCallCount: toolCalls.length,
      toolCalls,
      hasResult: result.data !== undefined,
    };
  } catch (e) {
    results.unsafeNoRetry = {
      toolCallCount: toolCalls.length,
      toolCalls,
      error: e.message,
    };
  }
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
