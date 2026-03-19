import {
  testSafeRetry,
  testUnsafeNoRetry,
  testSafeDefRetry,
  testDerivedSafeRetry,
  testUnsafeChainNoRetry,
} from "./agent.js";
import { writeFileSync } from "fs";

const results = {};

// Test 1: Safe retry — lookupTool calls lookupItem (safe import), so it's retryable.
// lookupItem throws on the first call. The LLM should retry and succeed.
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

// Test 2: Unsafe no retry — saveAndLookupTool calls saveItem (not marked safe).
// After calling saveItem, the tool is non-retryable. It should be removed on error.
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

// Test 3: Safe def retry — safeWrapperTool calls safeLookupHelper (marked safe def).
// Because the callee is safe, safeWrapperTool stays retryable.
// lookupItem throws on the first call. The LLM should retry and succeed.
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => {
      toolCalls.push(toolName);
    },
  };
  const result = await testSafeDefRetry({ callbacks });
  results.safeDefRetry = {
    toolCallCount: toolCalls.length,
    toolCalls,
    succeeded: result.data !== undefined && result.data !== null,
  };
}

// Test 4: Derived safe retry — derivedSafeWrapperTool calls lookupTool (not marked safe def).
// lookupTool only calls safe imported functions, so safety is derived at runtime.
// No unsafe function is ever called in the chain, so the tool stays retryable.
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => {
      toolCalls.push(toolName);
    },
  };
  const result = await testDerivedSafeRetry({ callbacks });
  results.derivedSafeRetry = {
    toolCallCount: toolCalls.length,
    toolCalls,
    succeeded: result.data !== undefined && result.data !== null,
  };
}

// Test 5: Unsafe chain no retry — unsafeChainTool calls saveItem (unsafe), then
// lookupTool which throws. Even though lookupTool's error says retryable=true,
// the outer function ANDs it with its own __retryable (false, due to saveItem).
// Result: non-retryable. The tool should be removed.
{
  const toolCalls = [];
  const callbacks = {
    onToolCallStart: ({ toolName }) => {
      toolCalls.push(toolName);
    },
  };
  try {
    const result = await testUnsafeChainNoRetry({ callbacks });
    results.unsafeChainNoRetry = {
      toolCallCount: toolCalls.length,
      toolCalls,
      hasResult: result.data !== undefined,
    };
  } catch (e) {
    results.unsafeChainNoRetry = {
      toolCallCount: toolCalls.length,
      toolCalls,
      error: e.message,
    };
  }
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
