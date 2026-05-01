import { exit } from "process";
import {
  testApprove, testReject, testResolve, testLlmOverride, testThread,
  hasInterrupts, approve, reject, respondToInterrupts,
} from "./agent.js";
import { writeFileSync } from "fs";

// Test 1: approveInterrupt with overrides
const r1 = await testApprove();
const resumed1 = await respondToInterrupts(r1.data, [approve()], { overrides: { x: 42 } });

// Test 2: rejectInterrupt with overrides
const r2 = await testReject();
//console.log("Result of testReject:", JSON.stringify(r2, null, 2));
const resumed2 = await respondToInterrupts(r2.data, [reject()], { overrides: { x: 99 } });
//console.log("Resumed after rejectInterrupt:", JSON.stringify(resumed2, null, 2));
// Test 3: resolveInterrupt with overrides
const r3 = await testResolve();
const resumed3 = await respondToInterrupts(r3.data, [approve("resolved-value")], { overrides: { x: 77 } });
// Test 4: override LLM result before interrupt
const r4 = await testLlmOverride("I feel terrible");
const resumed4 = await respondToInterrupts(r4.data, [approve()], { overrides: { mood: "happy" } });

// Test 5: override inside a thread
const r5 = await testThread("I feel terrible");
const resumed5 = await respondToInterrupts(r5.data, [approve()], { overrides: { mood: "happy" } });


writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      approve: { x: resumed1.data.x, result: resumed1.data.result },
      reject: resumed2.data,
      resolve: { x: resumed3.data.x, result: resumed3.data.result },
      llmOverride: { mood: resumed4.data.mood },
      threadOverride: { mood: resumed5.data.mood },
    },
    null,
    2,
  ),
);
