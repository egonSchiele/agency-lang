import {
  neutralStaysCallable,
  destructiveRemoved,
  callerPoisonedBySuccess,
  callerNotPoisoned,
  callerBlockPoisoned,
} from "./agent.js";
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

// Decision 8 (the frame fix): a destructive tool that SUCCEEDS inside llm()
// propagates to the calling function, so its later failure is destructiveRan
// true. Before the fix this was false (the mark landed on runPrompt's
// throwaway frame).
{
  const result = await callerPoisonedBySuccess({});
  results.callerPoisonedBySuccess = { callerDestructiveRan: result.data };
}

// The gating still holds: a destructive tool that cleanly refuses
// (destructiveRan false) does NOT propagate, so the caller stays false.
{
  const result = await callerNotPoisoned({});
  results.callerNotPoisoned = { callerDestructiveRan: result.data };
}

// llm() inside a block: block-locals get marked, and the block-join fold
// must carry it to the function, so the later failure is destructiveRan true.
{
  const result = await callerBlockPoisoned({});
  results.callerBlockPoisoned = { callerDestructiveRan: result.data };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
