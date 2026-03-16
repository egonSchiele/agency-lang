import { ask } from "./agent.js";
import { writeFileSync } from "fs";

let capturedUsage = null;
let capturedCost = null;

const callbacks = {
  onLLMCallEnd: ({ usage, cost }) => {
    capturedUsage = usage;
    capturedCost = cost;
  },
};

await ask({ callbacks });

// Check usage fields are present and non-zero
const usageCheck = {
  exists: capturedUsage !== null && capturedUsage !== undefined,
  inputTokensNonZero: capturedUsage?.inputTokens > 0,
  outputTokensNonZero: capturedUsage?.outputTokens > 0,
  totalTokensNonZero: capturedUsage?.totalTokens > 0,
};

// Check cost fields are present and non-zero
const costCheck = {
  exists: capturedCost !== null && capturedCost !== undefined,
  inputCostNonZero: capturedCost?.inputCost > 0,
  outputCostNonZero: capturedCost?.outputCost > 0,
  totalCostNonZero: capturedCost?.totalCost > 0,
  hasCurrency: typeof capturedCost?.currency === "string" && capturedCost.currency.length > 0,
};

writeFileSync(
  "__result.json",
  JSON.stringify({ usageCheck, costCheck }, null, 2),
);
